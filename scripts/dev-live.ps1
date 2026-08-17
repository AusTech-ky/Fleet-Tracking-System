<#
.SYNOPSIS
  Run the dev stack against the LIVE production database.

  Dev and prod share one database. Everything you do here — rename a group,
  move a device, delete something — happens on the real site. There is no
  second copy. Only the web app and API run locally; the data does not.

  Requires: Coolify -> fts-pg -> "Make it publicly available" checked.

.EXAMPLE
  .\scripts\dev-live.ps1 -Password 'PASSWORD-FROM-COOLIFY'

  Then open http://localhost:4301 and sign in with your PRODUCTION login.
  Ctrl+C stops both servers.

.NOTES
  This deliberately does NOT run ingestion. Your FTC927 keeps reporting to
  fleetapi.swift.ky:5027 and positions land in the shared DB, so dev sees them
  live — but through the DB, not through a second ingestion path.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$Password,
  [string]$DbHost = 'fleetapi.swift.ky',
  [int]$DbPort = 5432,
  [string]$User = 'postgres',
  [string]$Database = 'fleet',
  [int]$ApiPort = 4300,
  [int]$WebPort = 4301
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# The password goes into the URL, so it must be percent-encoded — a raw '@' or
# '#' would be read as URL structure and produce "password authentication failed".
$enc = [uri]::EscapeDataString($Password)
$env:DATABASE_URL = "postgres://${User}:${enc}@${DbHost}:${DbPort}/${Database}?sslmode=require"

# Local Redis: only used for the IMEI allow-list cache and pub/sub between
# services. Ingestion isn't running here, so it's effectively idle, but the
# control-plane requires it to boot in postgres mode.
$env:REDIS_URL = if ($env:REDIS_URL) { $env:REDIS_URL } else { 'redis://localhost:6379' }
$env:JWT_SECRET = if ($env:JWT_SECRET) { $env:JWT_SECRET } else { 'dev-only-secret-not-for-prod' }
$env:CORS_ORIGINS = "http://localhost:$WebPort"
$env:PORT = "$ApiPort"

# Fail fast with a clear message if the DB isn't reachable — an unreachable DB
# otherwise surfaces as a confusing crash deep in Nest's bootstrap.
Write-Host "[dev-live] checking connection to $($DbHost):$($DbPort)/$($Database) ..."
# psql reports failure on stderr; under ErrorAction=Stop PowerShell would throw
# on that before we reach our own message, so relax it for this one call.
$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$probe = (docker compose exec -T -e PGPASSWORD=$Password -e PGCONNECT_TIMEOUT=10 db `
  psql "host=$DbHost port=$DbPort user=$User dbname=$Database sslmode=require" -Atc "select count(*) from device" 2>&1 | Out-String).Trim()
$ErrorActionPreference = $prevEap
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "  $probe"
  Write-Host ""
  Write-Host "  Could not reach the live database. Check, in Coolify -> fts-pg:"
  Write-Host "    - 'Make it publicly available' is ticked AND you clicked Save"
  Write-Host "    - the Password field (eye icon) is what you passed to -Password"
  Write-Host "    - if 5432 is taken by another DB on the server, set Public Port 5433 and pass -DbPort 5433"
  exit 1
}
Write-Host "[dev-live] connected - live DB has $($probe) device(s)"

if (-not (docker compose ps -q redis)) { docker compose up -d redis | Out-Null }

Write-Host "[dev-live] control-plane :$($ApiPort)  ->  LIVE DB (writes go to production)"
$api = Start-Process node -ArgumentList 'dist/src/main.js' -WorkingDirectory 'services/control-plane' -NoNewWindow -PassThru

Write-Host "[dev-live] web :$($WebPort)  ->  API http://localhost:$($ApiPort)"
$env:NEXT_PUBLIC_API_URL = "http://localhost:$ApiPort"
Push-Location apps/web
try {
  # NEXT_PUBLIC_* is baked in at build time; rebuild so the bundle points at this API port.
  npx next build | Out-Null
  $web = Start-Process npx -ArgumentList "next start -p $WebPort" -NoNewWindow -PassThru
} finally { Pop-Location }

Write-Host ""
Write-Host "  open http://localhost:$($WebPort)  (sign in with your production login)"
Write-Host "  Ctrl+C to stop"
try { Wait-Process -Id $api.Id, $web.Id }
finally {
  foreach ($p in @($api, $web)) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
}
