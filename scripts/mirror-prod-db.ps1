<#
.SYNOPSIS
  Mirror the PRODUCTION database into the local docker-compose Postgres, so dev
  shows exactly the tenants / devices / groups / history that live has.

  PowerShell twin of mirror-prod-db.sh. One-way and read-only against
  production: it only ever *reads* from prod (pg_dump) and *writes* to the local
  container. Nothing you do in dev afterwards can touch live.

.EXAMPLE
  .\scripts\mirror-prod-db.ps1 -ProdDatabaseUrl 'postgres://user:pass@host:5432/db'

  The URL comes from Coolify -> your Postgres resource -> "Postgres URL (public)".
  Pass it as the parameter (or set $env:PROD_DATABASE_URL); never commit it.

  Re-run any time to refresh the snapshot. It drops and recreates the local
  `fleet` database, so anything you created only in dev is discarded.
#>
[CmdletBinding()]
param(
  # Option 1: a full URL. Fine when the password has no URL-special characters.
  [string]$ProdDatabaseUrl = $env:PROD_DATABASE_URL,

  # Option 2: the parts separately. The password goes to Postgres verbatim via
  # PGPASSWORD and never passes through a URL parser — so a Coolify-generated
  # password containing @ # % / + & cannot be mangled into "password
  # authentication failed".
  [string]$DbHost = 'fleetapi.swift.ky',
  [int]$Port = 5432,
  [string]$User = 'postgres',
  # Coolify's "Initial Database" for fts-pg is `fleet`, not the postgres default.
  [string]$Database = 'fleet',
  [string]$Password = $env:PGPASSWORD,
  [switch]$NoSsl,

  # Option 3 (recommended): reach the DB over an SSH tunnel to the Coolify host,
  # so the database never has to be made publicly available. The tunnel is
  # opened for the duration of the dump and torn down afterwards.
  #   -SshHost root@167.99.49.143 -Password '<POSTGRES_PASSWORD>'
  # The DB container name is looked up on the server; pass -DbContainer to pin it.
  [string]$SshHost,
  [string]$DbContainer
)
$ErrorActionPreference = 'Stop'

# ---- optional SSH tunnel --------------------------------------------------
# On the Coolify host, the Postgres container is only reachable on the Docker
# network. Forwarding a local port to it over SSH gives us a private path in.
# The tunnel binds a spare local port; the *db container* then reaches it via
# host.docker.internal, since 'localhost' inside a container is the container.
$tunnel = $null
if ($SshHost) {
  if (-not $DbContainer) {
    Write-Host "[mirror] locating the Postgres container on $SshHost..."
    $DbContainer = (ssh -o BatchMode=yes -o ConnectTimeout=15 $SshHost `
      "docker ps --format '{{.Names}} {{.Image}}' | grep -iE 'postgres|timescale' | grep -v 'coolify-db' | head -1 | cut -d' ' -f1").Trim()
    if ($LASTEXITCODE -ne 0 -or -not $DbContainer) { throw "[mirror] could not find a Postgres container via $SshHost (is your SSH key authorised there?)" }
    Write-Host "  -> $DbContainer"
  }
  $ip = (ssh -o BatchMode=yes $SshHost "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $DbContainer").Trim().Split(' ')[0]
  if (-not $ip) { throw "[mirror] container $DbContainer has no network IP" }
  $localPort = 15432
  Write-Host "[mirror] opening tunnel localhost:$localPort -> $DbContainer ($ip:5432) via $SshHost"
  # -N: no shell, just forward. Runs in the background until we stop it.
  $tunnel = Start-Process ssh -ArgumentList "-o BatchMode=yes -o ExitOnForwardFailure=yes -N -L 0.0.0.0:${localPort}:${ip}:5432 $SshHost" -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  if ($tunnel.HasExited) { throw "[mirror] SSH tunnel failed to open (exit $($tunnel.ExitCode))" }
  # Inside the db container, the host's loopback is host.docker.internal.
  $DbHost = 'host.docker.internal'; $Port = $localPort
  $NoSsl = $true   # traffic is already inside SSH; the container itself has no TLS
}

# Build the pg_dump target. Without a URL, pass a conninfo string and hand the
# password over the environment; both are parsed literally by libpq.
$dumpEnv = @()
if ($ProdDatabaseUrl -and -not $SshHost) {
  if ($ProdDatabaseUrl -notmatch '^postgres(ql)?://') { throw "ProdDatabaseUrl must be a postgres:// URL, not: $ProdDatabaseUrl" }
  $target = $ProdDatabaseUrl
} else {
  if (-not $Password) { throw "Pass -Password 'the-db-password' (Coolify -> fts-pg -> Password), or set `$env:PGPASSWORD." }
  $ssl = if ($NoSsl) { 'prefer' } else { 'require' }
  $target = "host=$DbHost port=$Port user=$User dbname=$Database sslmode=$ssl"
  $dumpEnv = @('-e', "PGPASSWORD=$Password")
}

# Whatever happens below, don't leave a background ssh tunnel behind.
try {

Set-Location (Join-Path $PSScriptRoot '..')
$db = (docker compose ps -q db).Trim()
if (-not $db) { throw "local db container is not running: docker compose up -d db redis" }

# Native exes (docker, pg_dump) signal failure through the exit code, and they
# legitimately write warnings to stderr — pg_dump notes the self-referencing
# org_unit FK every run. Under $ErrorActionPreference='Stop', PowerShell 5.1
# turns any stderr line from a native exe into a terminating exception, so each
# call runs with it relaxed and we judge success by $LASTEXITCODE instead.
function Invoke-Native([string]$step, [scriptblock]$cmd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $cmd 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host "  $($_.Exception.Message)" } else { $_ } } }
  finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "[mirror] $step failed (exit $LASTEXITCODE)" }
}

Write-Host "[mirror] dumping production (schema + data)..."
Invoke-Native 'pg_dump of production' {
  docker exec -e PGCONNECT_TIMEOUT=15 @dumpEnv $db pg_dump $target --format=custom --no-owner --no-privileges --file=/tmp/prod.dump
}

Write-Host "[mirror] recreating local 'fleet' database..."
Invoke-Native 'recreate local db' {
  docker exec $db psql -U postgres -v ON_ERROR_STOP=1 -q `
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='fleet' AND pid<>pg_backend_pid();" `
    -c "DROP DATABASE IF EXISTS fleet;" `
    -c "CREATE DATABASE fleet;"
}

# TimescaleDB must be pre-loaded before restoring hypertables, and the restore
# must run inside its 'restoring' guard — the documented Timescale procedure.
Write-Host "[mirror] restoring into local..."
Invoke-Native 'timescale pre-restore' {
  docker exec $db psql -U postgres -d fleet -v ON_ERROR_STOP=1 -q `
    -c "CREATE EXTENSION IF NOT EXISTS timescaledb;" `
    -c "CREATE EXTENSION IF NOT EXISTS postgis;" `
    -c "SELECT timescaledb_pre_restore();"
}
Invoke-Native 'pg_restore' {
  docker exec $db pg_restore -U postgres -d fleet --no-owner --no-privileges --exit-on-error /tmp/prod.dump
}
Invoke-Native 'timescale post-restore' {
  docker exec $db psql -U postgres -d fleet -q -c "SELECT timescaledb_post_restore();"
}
docker exec $db rm -f /tmp/prod.dump

Write-Host "[mirror] done. Local now mirrors production:"
docker exec $db psql -U postgres -d fleet -At -c @"
  SELECT '  tenants:  ' || count(*) FROM tenant
  UNION ALL SELECT '  devices:  ' || count(*) FROM device
  UNION ALL SELECT '  groups:   ' || count(*) FROM org_unit
  UNION ALL SELECT '  positions:' || count(*) FROM position;
"@

} finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    Write-Host "[mirror] tunnel closed"
  }
}
