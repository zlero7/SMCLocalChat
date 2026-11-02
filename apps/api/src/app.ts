import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import { config, paths } from './config.js';
import { errorHandler, requestLogger } from './middleware.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { discordRouter } from './routes/discord.js';
import { filesRouter } from './routes/files.js';
import { googleAuthRouter, googleRouter } from './routes/google.js';
import { meRouter } from './routes/me.js';
import { projectsRouter } from './routes/projects.js';
import { schedulesRouter } from './routes/schedules.js';
import { shareRouter } from './routes/share.js';
import { statusRouter } from './routes/status.js';
import { stylesRouter } from './routes/styles.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    helmet({
      // http 로 접속하는 사설망(IP 직접 접속)에서도 깨지지 않도록 https 강제 업그레이드는 끈다
      contentSecurityPolicy: {
        directives: {
          'upgrade-insecure-requests': null,
          // 첨부 이미지는 로그인 토큰을 붙여 받은 뒤 blob: 주소로 보여 준다
          'img-src': ["'self'", 'data:', 'blob:'],
          // 프로그램 실행 도우미 (내 컴퓨터 127.0.0.1 에서 켜는 작은 프로그램) 와 이야기하려고
          'connect-src': ["'self'", 'http://127.0.0.1:*', 'http://localhost:*'],
        },
      },
    }),
  );
  app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(requestLogger);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth/google', googleAuthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/google', googleRouter);
  app.use('/api/discord', discordRouter);
  app.use('/api/me', meRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/status', statusRouter);
  app.use('/api/styles', stylesRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/schedules', schedulesRouter);
  app.use('/api/share', shareRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '없는 API 예요' });
  });

  // Nginx 없이 쓸 때: 빌드된 웹 앱을 API 서버가 같이 서빙
  const indexHtml = path.join(paths.webDist, 'index.html');
  if (config.SERVE_WEB && fs.existsSync(indexHtml)) {
    app.use(express.static(paths.webDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);
  return app;
}
