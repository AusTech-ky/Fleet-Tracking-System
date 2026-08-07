import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

/**
 * Migration runner.
 *
 * `001_init.sql` only executes via docker-entrypoint-initdb.d on a *fresh*
 * volume, which does not help managed databases (Coolify, RDS, Timescale Cloud)
 * or existing installs. This applies every `migrations/*.sql` file in filename
 * order inside a transaction and records it in `schema_migrations`, so it is
 * safe to run on every deploy.
 *
 *   node dist/src/migrate.js            # uses DATABASE_URL
 *   MIGRATIONS_DIR=/app/migrations node dist/src/migrate.js
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('migrate: DATABASE_URL is not set');
    process.exit(1);
  }
  const dir = process.env.MIGRATIONS_DIR ?? join(__dirname, '..', '..', 'migrations');

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log(`migrate: no .sql files in ${dir}`);
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`migrate: skip ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`migrate: applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        // A pre-existing database may already have 001's objects. Record it as
        // applied rather than failing every deploy, but surface the reason.
        const message = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(message)) {
          await pool.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
            [file],
          );
          console.warn(`migrate: ${file} objects already exist — marking as applied (${message})`);
        } else {
          console.error(`migrate: FAILED on ${file}: ${message}`);
          throw err;
        }
      } finally {
        client.release();
      }
    }
    console.log('migrate: up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migrate: aborted', err instanceof Error ? err.message : err);
  process.exit(1);
});
