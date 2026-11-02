import fs from 'node:fs/promises';
import pg from 'pg';
import { config, paths } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  console.error('[db] 유휴 연결 오류:', err.message);
});

/** migrations/*.sql 을 파일명 순서대로 한 번씩만 적용한다. */
export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // 여러 인스턴스가 동시에 마이그레이션하지 않도록 잠금
    await client.query('select pg_advisory_lock(727001)');
    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Set<string>(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await fs.readdir(paths.migrations)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(`${paths.migrations}/${file}`, 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`마이그레이션 실패 (${file}): ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}
