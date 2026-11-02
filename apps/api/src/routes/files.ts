import fs from 'node:fs/promises';
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { saveUpload, storedPath, toAttachment, type FileRow } from '../files.js';
import { requireAuth } from '../middleware.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

const NOT_FOUND = '파일을 찾을 수 없어요';

function parseId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, NOT_FOUND);
  return parsed.data;
}

/**
 * 파일 올리기. 본문에 파일 그대로(application/octet-stream), 이름은 X-File-Name 헤더(URL 인코딩)로.
 * 문서는 서버가 글자를 뽑아 둔다. 돌려주는 id 를 메시지 보낼 때 attachmentIds 로 넣는다.
 */
filesRouter.post(
  '/',
  express.raw({ type: () => true, limit: `${config.MAX_UPLOAD_MB}mb` }),
  async (req, res) => {
    let name = '';
    try {
      name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    } catch {
      throw new HttpError(400, '파일 이름이 올바르지 않아요');
    }
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '파일 내용이 없어요');
    const row = await saveUpload(req.user!.id, name, req.body);
    res.status(201).json({
      file: { ...toAttachment(row), chars: row.text?.length ?? null },
    });
  },
);

/** 파일 내용 (주인만). 이미지·PDF 는 화면에 보여 주고, 나머지는 내려받게 한다 */
filesRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query<FileRow>('select * from files where id = $1 and user_id = $2', [id, req.user!.id]);
  const file = rows[0];
  if (!file) throw new HttpError(404, NOT_FOUND);
  try {
    await fs.access(storedPath(file));
  } catch {
    throw new HttpError(404, NOT_FOUND);
  }
  const inline = file.kind === 'image' || file.mime === 'application/pdf';
  res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(storedPath(file));
});

/** 아직 메시지에 붙여 보내지 않은 파일 지우기 (보낸 파일은 대화에 남는다) */
filesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query<FileRow>(
    'delete from files where id = $1 and user_id = $2 and not attached returning *',
    [id, req.user!.id],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  await fs.rm(storedPath(rows[0]), { force: true });
  res.status(204).end();
});
