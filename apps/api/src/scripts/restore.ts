/**
 * 백업 되돌리기
 *   npm run restore -- C:\chat-site-backup\chat-20261015-040000.ndjson.gz
 *   npm run restore -- <파일> --force     → 이미 데이터가 있어도 전부 지우고 백업으로 덮어쓴다
 *
 * 먼저 사이트를 끄세요 (작업 스케줄러의 "chat-site 사이트" 중지). 데이터베이스가 비어 있지 않으면 --force 가 없을 때 멈춘다.
 * 표(테이블) 구조는 마이그레이션이 만들고, 이 스크립트는 그 안에 행만 채운다.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { migrate, pool } from '../db.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('사용법: npm run restore -- <백업 파일> [--force]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`파일이 없어요: ${file}`);
  process.exit(1);
}

const BATCH = 500;

try {
  await migrate();
  const client = await pool.connect();
  try {
    const existing = Number((await client.query<{ n: string }>('select count(*) as n from users')).rows[0]!.n);
    if (existing > 0 && !force) {
      console.error(`데이터베이스에 이미 계정이 ${existing}개 있어요. 정말 덮어쓰려면 --force 를 붙이세요.`);
      process.exit(1);
    }

    await client.query('begin');
    // 외래 키 순서를 신경 쓰지 않고 넣으려고 이 연결에서만 검사를 끈다 (슈퍼유저 필요)
    await client.query("set local session_replication_role = 'replica'");

    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let header: { tables: string[] } | null = null;
    let sawEnd = false;
    let batch: unknown[] = [];
    let batchTable = '';
    const inserted: Record<string, number> = {};

    const flush = async () => {
      if (!batch.length) return;
      await client.query(`insert into "${batchTable}" select * from jsonb_populate_recordset(null::"${batchTable}", $1::jsonb)`, [
        JSON.stringify(batch),
      ]);
      inserted[batchTable] = (inserted[batchTable] ?? 0) + batch.length;
      batch = [];
    };

    for await (const line of rl) {
      if (!line) continue;
      const o = JSON.parse(line) as { kind?: string; tables?: string[]; t?: string; r?: unknown };
      if (o.kind === 'chat-site-backup') {
        header = { tables: o.tables ?? [] };
        const known = new Set(
          (await client.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'")).rows.map(
            (r) => r.table_name,
          ),
        );
        const missing = header.tables.filter((t) => !known.has(t));
        if (missing.length) throw new Error(`이 데이터베이스에 없는 표가 백업에 있어요: ${missing.join(', ')} (코드가 더 오래된 버전인가요?)`);
        // schema_migrations 도 백업에 들어 있으니 같이 비우고 채운다
        await client.query(`truncate table ${header.tables.map((t) => `"${t}"`).join(', ')} restart identity cascade`);
      } else if (o.kind === 'end') {
        sawEnd = true;
      } else if (o.t) {
        if (!header) throw new Error('백업 파일의 머리 부분이 없어요');
        if (o.t !== batchTable || batch.length >= BATCH) {
          await flush();
          batchTable = o.t;
        }
        batch.push(o.r);
      }
    }
    await flush();
    if (!header || !sawEnd) throw new Error('백업 파일이 끝까지 있지 않아요 (중간에 끊긴 파일). 아무것도 바꾸지 않고 되돌렸어요.');

    // 자동 번호가 이어서 붙도록 맞춘다
    await client.query("select setval('messages_seq_seq', greatest((select coalesce(max(seq), 0) from messages), 1))");
    await client.query("select setval('usage_logs_id_seq', greatest((select coalesce(max(id), 0) from usage_logs), 1))");
    await client.query('commit');

    for (const [t, n] of Object.entries(inserted)) console.log(`  ${t}: ${n}행`);
    console.log(`[restore] 완료: ${file}`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
} catch (err) {
  console.error('[restore] 실패:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
