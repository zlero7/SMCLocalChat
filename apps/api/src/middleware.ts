import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { verifyAccessToken } from './security.js';

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload) return next(new HttpError(401, '로그인이 필요해요'));
  req.user = { id: payload.sub, role: payload.role };
  next();
};

/** requireAuth 뒤에 쓴다. 관리자가 아니면 403 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'admin') return next(new HttpError(403, '관리자만 쓸 수 있어요'));
  next();
};

/** 메서드/경로/상태/소요시간만 기록한다. 요청 본문(대화 내용)은 절대 기록하지 않는다. */
export const requestLogger: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (config.NODE_ENV === 'test') return next();
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    return void res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const message = issue?.message ?? '값이 올바르지 않아요';
    // 직접 쓴 한국어 메시지는 그대로 보여 주고, zod 기본(영어) 메시지일 때만 어느 칸인지 붙인다
    if (/[가-힣]/.test(message)) return void res.status(400).json({ error: message });
    const field = issue?.path.join('.') || '입력값';
    return void res.status(400).json({ error: `${field}: ${message}` });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return void res.status(400).json({ error: '요청 형식이 올바르지 않아요' });
  }
  if (typeof err === 'object' && err && 'type' in err && err.type === 'entity.too.large') {
    return void res.status(413).json({ error: '요청이 너무 커요' });
  }

  console.error('[error]', err instanceof Error ? (config.NODE_ENV === 'production' ? err.message : err.stack) : err);
  res.status(500).json({ error: '서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
};
