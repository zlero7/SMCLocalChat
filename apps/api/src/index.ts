import { createApp } from './app.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { botManager } from './discord/manager.js';
import { cleanupUnattached } from './files.js';
import { startScheduler } from './scheduler.js';

async function main() {
  const applied = await migrate();
  if (applied.length) console.log(`[db] 마이그레이션 적용: ${applied.join(', ')}`);

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`[api] http://localhost:${config.PORT} (모델: ${config.LLM_MODEL} @ ${config.LLM_BASE_URL})`);
    if (config.REGISTRATION_MODE === 'invite') {
      console.log('[api] 초대 코드 가입 모드. 코드 만들기: npm run invite -- 5');
    }
  });

  // 예약 작업: 실행할 때가 된 작업을 30초마다 확인한다
  startScheduler();

  // 사용자들이 설정에서 연결한 디스코드 봇을 켠다 (30초마다 바뀐 것을 반영)
  if (config.DISCORD_BOTS_ENABLED && config.NODE_ENV !== 'test') botManager.start();

  // 올리기만 하고 보내지 않은 첨부 파일 정리 (시작 시 + 1시간마다)
  const cleanFiles = () =>
    cleanupUnattached()
      .then((n) => n && console.log(`[files] 보내지 않은 첨부 파일 ${n}개 정리`))
      .catch((err) => console.error('[files] 정리 실패:', (err as Error).message));
  void cleanFiles();
  setInterval(cleanFiles, 60 * 60 * 1000).unref();

  // 만료된 리프레시 토큰 정리 (시작 시 + 6시간마다)
  const cleanup = () =>
    pool
      .query(`delete from refresh_tokens where expires_at < now() - interval '1 day'`)
      .catch((err) => console.error('[db] 토큰 정리 실패:', err.message));
  void cleanup();
  const cleanupTimer = setInterval(cleanup, 6 * 60 * 60 * 1000);
  cleanupTimer.unref();

  const shutdown = (signal: string) => {
    console.log(`[api] ${signal} 받음, 종료합니다`);
    void botManager.stop();
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    // 스트리밍 연결이 남아 있어도 10초 뒤엔 강제 종료
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[api] 시작 실패:', err instanceof Error ? err.message : err);
  process.exit(1);
});
