import fs from 'node:fs/promises';
import { pool } from './db.js';
import { storedPath } from './files.js';
import { disconnectGmail } from './google/oauth.js';

/**
 * 계정과 그 사람의 데이터를 완전히 지운다.
 *  - Gmail 연결은 구글에도 권한을 돌려주고 끊는다.
 *  - 올린 파일은 디스크에서도 지운다 (DB 행만 지우면 파일이 남는다).
 *  - 대화·메시지·기억·예약·프로젝트·공유 링크는 외래 키로 함께 지워진다.
 *  - 사용 기록(usage_logs)은 누구의 것인지만 지우고 합계 통계용으로 남긴다. 초대 코드는 사용 기록만 비운다.
 */
export async function deleteAccount(userId: string): Promise<void> {
  await disconnectGmail(userId).catch((err) => console.warn('[account] Gmail 연결 끊기 실패 (계속 진행):', (err as Error).message));

  const { rows: files } = await pool.query<{ stored_as: string }>('select stored_as from files where user_id = $1', [userId]);
  const { rowCount } = await pool.query('delete from users where id = $1', [userId]);
  if (!rowCount) return;

  // DB 에서 지운 뒤에 파일을 지운다 (반대 순서면 DB 삭제가 실패했을 때 파일만 사라진다)
  for (const f of files) {
    await fs.rm(storedPath(f), { force: true }).catch((err) => console.warn('[account] 파일 지우기 실패:', (err as Error).message));
  }
}

/** 관리자가 한 명도 남지 않게 되는지 (마지막 관리자는 스스로 탈퇴할 수 없다) */
export async function isLastAdmin(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ role: string; admins: string }>(
    `select u.role, (select count(*) from users where role = 'admin') as admins from users u where u.id = $1`,
    [userId],
  );
  return rows[0]?.role === 'admin' && Number(rows[0].admins) <= 1;
}
