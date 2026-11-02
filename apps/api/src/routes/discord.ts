import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { botManager, type BotRow } from '../discord/manager.js';
import { encryptToken } from '../discord/secret.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../middleware.js';

/** 사용자가 설정에서 자기 디스코드 봇을 연결·관리한다. 토큰은 저장만 하고 어떤 응답에도 다시 내려주지 않는다 */
export const discordRouter = Router();
discordRouter.use(requireAuth);

// 채널 보기 + 메시지 보내기 + 메시지 기록 보기 + 스레드에서 메시지 보내기 + 파일 첨부
const INVITE_PERMISSIONS = '274878008320';
const inviteUrl = (botId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;

const view = (row: BotRow | undefined, userId: string) => ({
  serverEnabled: config.DISCORD_BOTS_ENABLED,
  limits: { perHour: config.DISCORD_MESSAGES_PER_HOUR, perDay: config.DISCORD_MESSAGES_PER_DAY },
  bot: row
    ? {
        botId: row.bot_id,
        botName: row.bot_name,
        enabled: row.enabled,
        allowedChannels: row.allowed_channels,
        allowedUsers: row.allowed_users,
        allowDm: row.allow_dm,
        channelChat: row.channel_chat,
        inviteUrl: inviteUrl(row.bot_id),
        status: botManager.stateOf(userId),
      }
    : null,
});

const load = async (userId: string) =>
  (await pool.query<BotRow>('select * from discord_bots where user_id = $1', [userId])).rows[0];

discordRouter.get('/', async (req, res) => {
  res.json(view(await load(req.user!.id), req.user!.id));
});

/** 토큰으로 디스코드에 물어봐서 진짜 봇 토큰인지, 어떤 봇인지 확인한다 */
async function lookupBot(token: string): Promise<{ id: string; name: string }> {
  let r: Response;
  try {
    r = await fetch(`${config.DISCORD_API_BASE}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, '디스코드에 연결하지 못했어요. 잠시 후 다시 시도해 주세요');
  }
  if (r.status === 401) throw new HttpError(400, '토큰이 올바르지 않아요. 개발자 포털의 Bot 탭에서 Reset Token 으로 새로 만든 토큰을 붙여 넣어 주세요');
  if (!r.ok) throw new HttpError(502, `디스코드가 오류를 돌려줬어요 (${r.status})`);
  const me = (await r.json().catch(() => ({}))) as { id?: string; username?: string; bot?: boolean };
  if (!me.id || !me.bot) throw new HttpError(400, '봇 토큰이 아니에요. 사용자 계정 토큰은 쓸 수 없어요');
  return { id: me.id, name: me.username ?? '봇' };
}

const tokenLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.' },
});

discordRouter.put('/token', tokenLimiter, async (req, res) => {
  if (!config.DISCORD_BOTS_ENABLED) throw new HttpError(403, '관리자가 디스코드 봇 기능을 꺼 두었어요');
  const { token } = z
    .object({ token: z.string().trim().min(30, '토큰이 너무 짧아요').max(200, '토큰이 너무 길어요').regex(/^\S+$/, '토큰에 공백이 있으면 안 돼요') })
    .parse(req.body);
  const bot = await lookupBot(token);
  const userId = req.user!.id;
  try {
    await pool.query(
      `insert into discord_bots (user_id, token_enc, bot_id, bot_name)
       values ($1, $2, $3, $4)
       on conflict (user_id) do update
         set token_enc = excluded.token_enc, bot_id = excluded.bot_id, bot_name = excluded.bot_name,
             enabled = true, updated_at = now()`,
      [userId, encryptToken(token), bot.id, bot.name],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, '이 봇은 이미 다른 계정에서 쓰고 있어요');
    throw err;
  }
  void botManager.sync();
  res.json(view(await load(userId), userId));
});

// 쉼표로 구분한 디스코드 ID 목록 (숫자 15~25자리)
const idList = z
  .string()
  .max(1500)
  .transform((s) => s.split(/[\s,]+/).filter(Boolean))
  .refine((a) => a.length <= 50, '50개까지만 넣을 수 있어요')
  .refine((a) => a.every((x) => /^\d{15,25}$/.test(x)), 'ID 는 숫자 15~25자리예요 (디스코드 설정 → 고급 → 개발자 모드를 켠 뒤 우클릭 → ID 복사)')
  .transform((a) => [...new Set(a)].join(','));

discordRouter.patch('/', async (req, res) => {
  const body = z
    .object({ enabled: z.boolean().optional(), allowedChannels: idList.optional(), allowedUsers: idList.optional(), allowDm: z.boolean().optional(), channelChat: z.boolean().optional() })
    .parse(req.body);
  const userId = req.user!.id;
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (body.enabled !== undefined) add('enabled', body.enabled);
  if (body.allowedChannels !== undefined) add('allowed_channels', body.allowedChannels);
  if (body.allowedUsers !== undefined) add('allowed_users', body.allowedUsers);
  if (body.allowDm !== undefined) add('allow_dm', body.allowDm);
  if (body.channelChat !== undefined) add('channel_chat', body.channelChat);
  if (!sets.length) throw new HttpError(400, '바꿀 내용이 없어요');
  values.push(userId);
  const { rowCount } = await pool.query(`update discord_bots set ${sets.join(', ')}, updated_at = now() where user_id = $${values.length}`, values);
  if (!rowCount) throw new HttpError(404, '연결된 봇이 없어요');
  // 설정을 바꾸면 거절됐던 봇도 다시 시도한다 (개발자 포털에서 권한을 켠 뒤 저장했을 수 있다)
  await botManager.retry(userId);
  res.json(view(await load(userId), userId));
});

/** 개발자 포털에서 권한(Message Content Intent 등)을 켠 뒤, 같은 토큰으로 다시 연결해 본다 */
discordRouter.post('/retry', async (req, res) => {
  const userId = req.user!.id;
  if (!(await load(userId))) throw new HttpError(404, '연결된 봇이 없어요');
  await botManager.retry(userId);
  res.json(view(await load(userId), userId));
});

discordRouter.delete('/', async (req, res) => {
  await pool.query('delete from discord_bots where user_id = $1', [req.user!.id]);
  await botManager.sync();
  res.status(204).end();
});
