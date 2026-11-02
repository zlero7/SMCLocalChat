import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../middleware.js';
import { MAX_CUSTOM_STYLES, STYLE_PRESETS } from '../styles.js';

export const stylesRouter = Router();
stylesRouter.use(requireAuth);

interface StyleRow {
  id: string;
  name: string;
  instruction: string;
  created_at: Date;
  updated_at: Date;
}

const toStyle = (r: StyleRow) => ({
  id: r.id,
  name: r.name,
  instruction: r.instruction,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const NOT_FOUND = '스타일을 찾을 수 없어요';

const styleSchema = z.object({
  name: z.string().trim().min(1, '스타일 이름을 입력해 주세요').max(30, '스타일 이름은 30자 이하로 해 주세요'),
  instruction: z
    .string()
    .trim()
    .min(1, '스타일 지침을 입력해 주세요')
    .max(2000, '스타일 지침은 2000자 이하로 해 주세요'),
});

function parseId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, NOT_FOUND);
  return parsed.data;
}

/** 기본 제공 스타일 + 내 스타일 + 지금 고른 스타일 */
stylesRouter.get('/', async (req, res) => {
  const userId = req.user!.id;
  const [custom, user] = await Promise.all([
    pool.query<StyleRow>(
      'select id, name, instruction, created_at, updated_at from user_styles where user_id = $1 order by created_at',
      [userId],
    ),
    pool.query<{ style_id: string }>('select style_id from users where id = $1', [userId]),
  ]);
  res.json({
    presets: STYLE_PRESETS,
    custom: custom.rows.map(toStyle),
    selected: user.rows[0]?.style_id ?? 'default',
    maxCustom: MAX_CUSTOM_STYLES,
  });
});

stylesRouter.post('/', async (req, res) => {
  const { name, instruction } = styleSchema.parse(req.body);
  const userId = req.user!.id;
  // 개수 확인과 추가를 한 문장으로 (동시에 여러 번 눌러도 최대 개수를 넘지 않게)
  const { rows } = await pool.query<StyleRow>(
    `insert into user_styles (user_id, name, instruction)
     select $1, $2, $3
     where (select count(*) from user_styles where user_id = $1) < $4
     returning id, name, instruction, created_at, updated_at`,
    [userId, name, instruction, MAX_CUSTOM_STYLES],
  );
  if (!rows[0]) throw new HttpError(409, `스타일은 ${MAX_CUSTOM_STYLES}개까지 만들 수 있어요`);
  res.status(201).json({ style: toStyle(rows[0]) });
});

stylesRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const { name, instruction } = styleSchema.parse(req.body);
  const { rows } = await pool.query<StyleRow>(
    `update user_styles set name = $1, instruction = $2, updated_at = now()
     where id = $3 and user_id = $4
     returning id, name, instruction, created_at, updated_at`,
    [name, instruction, id, req.user!.id],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  res.json({ style: toStyle(rows[0]) });
});

stylesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const userId = req.user!.id;
  const { rowCount } = await pool.query('delete from user_styles where id = $1 and user_id = $2', [id, userId]);
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  // 지운 스타일을 쓰고 있었다면 기본 스타일로 돌린다
  await pool.query(`update users set style_id = 'default' where id = $1 and style_id = $2`, [userId, id]);
  res.status(204).end();
});
