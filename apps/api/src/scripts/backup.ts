/**
 * 데이터베이스 백업 (모든 테이블을 한 파일로)
 *   npm run backup              → BACKUP_DIR 에 chat-날짜-시각.ndjson.gz 를 만들고 오래된 것을 지운다
 *
 * 이 서버의 Postgres 에는 pg_dump 가 없어서, 한 시점의 일관된 모습(스냅샷)으로 읽어 한 줄에 한 행씩 적는다.
 * 만든 뒤 파일을 다시 읽어 행 수가 맞는지 확인하고, 맞지 않으면 그 파일을 지우고 실패로 끝낸다.
 * 되돌리기: npm run restore -- <파일>
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { pool } from '../db.js';

const dir = path.resolve(process.env.BACKUP_DIR || 'C:\\chat-site-backup');
const keepDays = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 14);
const MIN_KEEP = 3; // 며칠 동안 백업이 실패해도 마지막 몇 개는 절대 지우지 않는다
const NAME_RE = /^chat-\d{8}-\d{6}\.ndjson\.gz$/;

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(d: Date) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

fs.mkdirSync(dir, { recursive: true });
const finalPath = path.join(dir, `chat-${stamp(new Date())}.ndjson.gz`);
const tmpPath = `${finalPath}.part`;

const counts: Record<string, number> = {};

async function dump() {
  const out = zlib.createGzip({ level: 6 });
  const file = fs.createWriteStream(tmpPath, { mode: 0o600 });
  out.pipe(file);
  const write = async (obj: unknown) => {
    if (!out.write(JSON.stringify(obj) + '\n')) await once(out, 'drain');
  };

  const client = await pool.connect();
  try {
    // 읽는 동안 다른 요청이 데이터를 바꿔도 같은 시점의 모습으로 읽는다
    await client.query('begin isolation level repeatable read read only');
    const tables = (
      await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      )
    ).rows.map((r) => r.table_name);
    await write({ kind: 'chat-site-backup', version: 1, createdAt: new Date().toISOString(), tables });
    for (const table of tables) {
      counts[table] = 0;
      await client.query(`declare c cursor for select to_jsonb(t) as r from "${table}" t`);
      for (;;) {
        const { rows } = await client.query<{ r: unknown }>('fetch 1000 from c');
        if (!rows.length) break;
        for (const row of rows) {
          await write({ t: table, r: row.r });
          counts[table]!++;
        }
      }
      await client.query('close c');
    }
    await write({ kind: 'end', counts });
    await client.query('commit');
  } finally {
    client.release();
    out.end();
  }
  await once(file, 'close');
}

/** 만든 파일을 다시 읽어 행 수가 기록과 같은지 본다 */
async function verify() {
  const seen: Record<string, number> = {};
  let footer: Record<string, number> | null = null;
  const rl = readline.createInterface({ input: fs.createReadStream(tmpPath).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line) as { t?: string; kind?: string; counts?: Record<string, number> };
    if (o.t) seen[o.t] = (seen[o.t] ?? 0) + 1;
    else if (o.kind === 'end') footer = o.counts ?? null;
  }
  if (!footer) throw new Error('끝 표시가 없어요 (파일이 중간에 끊김)');
  for (const [table, n] of Object.entries(counts)) {
    if ((seen[table] ?? 0) !== n || footer[table] !== n) throw new Error(`${table} 행 수가 달라요 (기록 ${n}, 파일 ${seen[table] ?? 0})`);
  }
}

function prune() {
  const files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort(); // 이름이 날짜순
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
  const removable = files.slice(0, Math.max(0, files.length - MIN_KEEP));
  let removed = 0;
  for (const f of removable) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < cutoff) {
      fs.rmSync(p);
      removed++;
    }
  }
  return removed;
}

try {
  await dump();
  await verify();
  fs.renameSync(tmpPath, finalPath);
  const removed = prune();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const kb = Math.round(fs.statSync(finalPath).size / 1024);
  console.log(`[backup] 완료: ${finalPath} (${kb}KB, 테이블 ${Object.keys(counts).length}개, 행 ${total}개) · 오래된 백업 ${removed}개 지움`);
} catch (err) {
  fs.rmSync(tmpPath, { force: true });
  console.error('[backup] 실패:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
