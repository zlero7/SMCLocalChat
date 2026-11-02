import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';

/**
 * 공유 링크로 대화 읽기 (로그인 없이). 공유한 시점까지의 메시지만 보여 준다.
 * 링크 만들기·끄기는 conversations 라우터(/conversations/:id/share)에서 한다.
 */
export const shareRouter = Router();

const NOT_FOUND = '없거나 공유가 꺼진 링크예요';

export const newShareToken = () => crypto.randomBytes(18).toString('base64url');

shareRouter.get('/:token', async (req, res) => {
  const token = z.string().regex(/^[\w-]{20,40}$/).safeParse(req.params.token);
  if (!token.success) throw new HttpError(404, NOT_FOUND);
  const { rows } = await pool.query<{ conversation_id: string; upto_seq: string; created_at: Date; title: string; nickname: string }>(
    `select s.conversation_id, s.upto_seq, s.created_at, c.title, u.nickname
     from shares s
     join conversations c on c.id = s.conversation_id and c.deleted_at is null
     join users u on u.id = s.user_id
     where s.token = $1`,
    [token.data],
  );
  const share = rows[0];
  if (!share) throw new HttpError(404, NOT_FOUND);
  const messages = await pool.query(
    `select id, role, content, status, model, tools, attachments, created_at from messages
     where conversation_id = $1 and role in ('user', 'assistant') and seq <= $2
     order by seq`,
    [share.conversation_id, share.upto_seq],
  );
  res.json({
    title: share.title,
    sharedBy: share.nickname,
    sharedAt: share.created_at,
    messages: messages.rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      status: m.status,
      model: m.model,
      tools: m.tools,
      // 공유 화면에서는 첨부 파일의 이름만 보여 준다 (파일 자체는 주인만 열 수 있다)
      attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a: { name: string; kind: string }) => ({
        name: a.name,
        kind: a.kind,
      })),
      createdAt: m.created_at,
    })),
  });
});
