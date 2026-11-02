import fs from 'node:fs/promises';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { storedPath, toAttachment, type FileRow } from '../files.js';
import { requireAuth } from '../middleware.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

/** 한 사람이 만들 수 있는 프로젝트 수, 프로젝트 하나의 자료 수 */
export const MAX_PROJECTS = 20;
export const MAX_PROJECT_FILES = 30;

const NOT_FOUND = '프로젝트를 찾을 수 없어요';

function parseId(value: unknown, message = NOT_FOUND): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, message);
  return parsed.data;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  created_at: Date;
  updated_at: Date;
  conversation_count?: number;
  file_count?: number;
}

const toProject = (p: ProjectRow) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  instructions: p.instructions,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
  conversationCount: p.conversation_count ?? 0,
  fileCount: p.file_count ?? 0,
});

/** 이 사용자의 프로젝트인지 확인 (남의 프로젝트는 없는 것과 같게 404) */
export async function getOwnedProject(id: string, userId: string): Promise<ProjectRow> {
  const { rows } = await pool.query<ProjectRow>(
    'select id, name, description, instructions, created_at, updated_at from projects where id = $1 and user_id = $2',
    [id, userId],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

const fields = {
  name: z.string().trim().min(1, '이름을 입력해 주세요').max(60, '이름은 60자 이하로 해 주세요'),
  description: z.string().trim().max(300, '설명은 300자 이하로 해 주세요'),
  instructions: z.string().trim().max(4000, '지침은 4000자 이하로 해 주세요'),
};

projectsRouter.get('/', async (req, res) => {
  const { rows } = await pool.query<ProjectRow>(
    `select p.id, p.name, p.description, p.instructions, p.created_at, p.updated_at,
       (select count(*)::int from conversations c where c.project_id = p.id and c.deleted_at is null) as conversation_count,
       (select count(*)::int from files f where f.project_id = p.id) as file_count
     from projects p where p.user_id = $1
     order by p.updated_at desc`,
    [req.user!.id],
  );
  res.json({ items: rows.map(toProject), max: MAX_PROJECTS });
});

projectsRouter.post('/', async (req, res) => {
  const body = z
    .object({ name: fields.name, description: fields.description.default(''), instructions: fields.instructions.default('') })
    .parse(req.body);
  const count = await pool.query<{ n: number }>('select count(*)::int as n from projects where user_id = $1', [req.user!.id]);
  if ((count.rows[0]?.n ?? 0) >= MAX_PROJECTS) throw new HttpError(400, `프로젝트는 ${MAX_PROJECTS}개까지 만들 수 있어요.`);
  const { rows } = await pool.query<ProjectRow>(
    `insert into projects (user_id, name, description, instructions) values ($1, $2, $3, $4)
     returning id, name, description, instructions, created_at, updated_at`,
    [req.user!.id, body.name, body.description, body.instructions],
  );
  res.status(201).json({ project: toProject(rows[0]!) });
});

/** 프로젝트 하나: 정보 + 자료 + 대화 목록 */
projectsRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const project = await getOwnedProject(id, req.user!.id);
  const [files, conversations] = await Promise.all([
    pool.query<FileRow>('select * from files where project_id = $1 order by created_at', [id]),
    pool.query<{ id: string; title: string; updated_at: Date }>(
      `select id, title, updated_at from conversations
       where project_id = $1 and user_id = $2 and deleted_at is null
       order by updated_at desc limit 100`,
      [id, req.user!.id],
    ),
  ]);
  res.json({
    project: toProject({ ...project, conversation_count: conversations.rows.length, file_count: files.rows.length }),
    files: files.rows.map((f) => ({ ...toAttachment(f), chars: f.text?.length ?? 0, createdAt: f.created_at })),
    conversations: conversations.rows.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at })),
  });
});

projectsRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  await getOwnedProject(id, req.user!.id);
  const body = z
    .object({ name: fields.name.optional(), description: fields.description.optional(), instructions: fields.instructions.optional() })
    .parse(req.body);
  const { rows } = await pool.query<ProjectRow>(
    `update projects set
       name = coalesce($2, name), description = coalesce($3, description), instructions = coalesce($4, instructions),
       updated_at = now()
     where id = $1
     returning id, name, description, instructions, created_at, updated_at`,
    [id, body.name ?? null, body.description ?? null, body.instructions ?? null],
  );
  res.json({ project: toProject(rows[0]!) });
});

/** 프로젝트 지우기: 자료는 같이 지우고, 대화는 남긴 채 프로젝트에서만 뺀다 */
projectsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  await getOwnedProject(id, req.user!.id);
  const files = await pool.query<{ stored_as: string }>('select stored_as from files where project_id = $1', [id]);
  await pool.query('delete from projects where id = $1', [id]);
  await Promise.all(files.rows.map((f) => fs.rm(storedPath(f), { force: true }).catch(() => {})));
  res.status(204).end();
});

/** 먼저 /api/files 로 올린 문서를 프로젝트 자료로 넣는다 */
projectsRouter.post('/:id/files', async (req, res) => {
  const id = parseId(req.params.id);
  await getOwnedProject(id, req.user!.id);
  const { fileId } = z.object({ fileId: z.string().uuid() }).parse(req.body);
  const count = await pool.query<{ n: number }>('select count(*)::int as n from files where project_id = $1', [id]);
  if ((count.rows[0]?.n ?? 0) >= MAX_PROJECT_FILES) throw new HttpError(400, `자료는 ${MAX_PROJECT_FILES}개까지 넣을 수 있어요.`);
  const { rows } = await pool.query<FileRow>(
    `update files set project_id = $1, attached = true
     where id = $2 and user_id = $3 and not attached and kind = 'document'
     returning *`,
    [id, fileId, req.user!.id],
  );
  if (!rows[0]) {
    throw new HttpError(400, '자료로 넣을 수 없는 파일이에요. 프로젝트 자료는 문서(PDF·워드·텍스트)만 넣을 수 있어요.');
  }
  await pool.query('update projects set updated_at = now() where id = $1', [id]);
  res.status(201).json({ file: { ...toAttachment(rows[0]), chars: rows[0].text?.length ?? 0, createdAt: rows[0].created_at } });
});

projectsRouter.delete('/:id/files/:fileId', async (req, res) => {
  const id = parseId(req.params.id);
  const fileId = parseId(req.params.fileId, '자료를 찾을 수 없어요');
  await getOwnedProject(id, req.user!.id);
  const { rows } = await pool.query<FileRow>('delete from files where id = $1 and project_id = $2 returning *', [fileId, id]);
  if (!rows[0]) throw new HttpError(404, '자료를 찾을 수 없어요');
  await fs.rm(storedPath(rows[0]), { force: true });
  res.status(204).end();
});
