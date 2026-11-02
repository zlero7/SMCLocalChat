import { createRequire } from 'node:module';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { LlmError, streamChat, type ToolCall } from '../llm/client.js';
import { estimateTokens, type ModelMessage } from '../llm/context.js';
import { slotQueue } from '../llm/queue.js';
import { checkAndStartWindow } from '../quota.js';
import {
  DEFAULT_ASK_WITH_FILES,
  SEND_FILE_TOOL,
  buildUserTurn,
  fitHistory,
  handleSendFile,
  inputBudgetTokens,
  prepareAttachments,
  type IncomingFile,
  type OutFile,
  type Prepared,
} from './attach.js';
import { Conversations, DISCORD_LIMIT, Gate, RateLimiter, SYSTEM_PROMPT, defang, splitMessage } from './core.js';
import { decryptToken } from './secret.js';

/**
 * 사용자들이 설정에서 연결한 자기 디스코드 봇을 이 서버가 대신 켜 둔다.
 * 봇마다 디스코드 연결 하나. 답변은 사이트와 같은 모델 줄(slotQueue)을 쓰고, 쓴 양은 봇 주인의 5시간 사용량에서 빠진다.
 *
 * 봇이 듣는 곳: DM, @멘션, 슬래시 명령, 그리고 (설정한 경우) 지정한 채널의 모든 글.
 * 마지막은 디스코드의 "메시지 내용(Message Content)" 특권 인텐트가 필요해서, 지정한 채널이 있을 때만 요청한다.
 */

export interface BotRow {
  user_id: string;
  token_enc: string;
  bot_id: string;
  bot_name: string;
  enabled: boolean;
  allowed_channels: string;
  allowed_users: string;
  allow_dm: boolean;
  channel_chat: boolean;
}

export type BotState = { state: 'off' | 'starting' | 'online' | 'error'; error?: string; guilds?: number };

const MAX_QUESTION_CHARS = 4000;
const EDIT_INTERVAL_MS = 1500;
const MAX_ANSWER_TIME_MS = 5 * 60_000;
const SYNC_EVERY_MS = 30_000;
const MAX_TOOL_ROUNDS = 3;
/** 이 글로 시작하는 메시지는 지정한 채널에서도 봇이 무시한다 (사람끼리 하는 말) */
const IGNORE_PREFIX = /^\s*\/\//;

const ids = (csv: string) => new Set(csv.split(',').map((s) => s.trim()).filter(Boolean));
/** 채널 대화 모드: 지정한 채널이 있고 설정이 켜져 있을 때만 (메시지 내용 인텐트가 필요하다) */
export const wantsContent = (row: Pick<BotRow, 'channel_chat' | 'allowed_channels'>) => row.channel_chat && ids(row.allowed_channels).size > 0;

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('AI 에게 질문하기')
    .addStringOption((o) => o.setName('질문').setDescription('묻고 싶은 내용').setRequired(true).setMaxLength(MAX_QUESTION_CHARS))
    .addAttachmentOption((o) => o.setName('파일').setDescription('같이 볼 이미지나 문서 (PDF·워드·텍스트·코드)').setRequired(false))
    .addBooleanOption((o) => o.setName('깊게').setDescription('먼저 깊이 생각하고 답하기 (더 정확하지만 느려요)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder().setName('reset').setDescription('나와 AI 의 이 채널 대화 기억을 지우기').toJSON(),
  new SlashCommandBuilder().setName('help').setDescription('사용법 보기').toJSON(),
];

const helpText = (chatty: boolean) =>
  `**사용법**\n` +
  (chatty ? '• 이 봇이 지정된 채널에서는 **그냥 채팅만 쳐도** 답해요. 사람끼리 하는 말은 앞에 `//` 를 붙이면 무시해요.\n' : '') +
  '• `/ask 질문`, 저를 @멘션, DM 으로도 물어볼 수 있어요.\n' +
  '• **이미지, PDF, 워드, 텍스트·코드 파일**을 같이 올리면 내용을 보고 답해요 (한 번에 4개까지).\n' +
  '• 코드나 문서를 파일로 달라고 하면 **파일로 만들어서 올려 줘요** (글로 된 파일만).\n' +
  '• 같은 채널에서 이어서 물으면 앞 대화를 기억해요 (30분). `/reset` 으로 지울 수 있어요.\n' +
  '• `/ask` 의 **깊게**를 켜면 먼저 생각하고 답해요 (느려요).\n' +
  `• 한 사람이 1시간에 ${config.DISCORD_MESSAGES_PER_HOUR}번, 하루 ${config.DISCORD_MESSAGES_PER_DAY}번까지 물을 수 있어요.\n` +
  '• 저는 인터넷·메일·내 컴퓨터 파일은 볼 수 없고, 틀릴 수 있어요. 중요한 내용은 다시 확인하세요.';

interface Runner {
  row: BotRow;
  tokenEnc: string;
  /** 이 연결이 메시지 내용 인텐트로 로그인했는지 (설정이 바뀌면 다시 로그인한다) */
  content: boolean;
  client: Client;
  limiter: RateLimiter;
  memory: Conversations;
  gate: Gate;
  /** 한 사람이 동시에 두 개를 돌리지 못하게 */
  busy: Set<string>;
}

/** 답을 보여 주는 곳 (슬래시 명령의 답글, 또는 메시지에 단 답글) */
interface Target {
  edit(text: string): Promise<unknown>;
  more(text: string): Promise<unknown>;
  files(files: OutFile[]): Promise<unknown>;
  typing(): void;
}

/**
 * 디스코드로 가는 연결이 "끊겼다"(other side closed)는 오류는 오래 놀던 연결을 다시 쓰다가 생기는 흔한 현상이다.
 * discord.js 는 이 오류를 다시 시도해 주지 않아서, 우리가 새 연결로 다시 보낸다.
 */
export function isNetworkGlitch(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? '';
  return (
    ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code) ||
    /other side closed|socket hang up|ECONNRESET/i.test(e.message ?? '')
  );
}

export async function withNetRetry<T>(fn: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 2 || !isNetworkGlitch(err)) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
}

/** discord.js 가 쓰는 undici 로 만든 "놀면 금방 닫는" 연결 풀 (오래 놀다 서버가 닫아 버린 연결을 다시 쓰는 일을 줄인다) */
export function shortLivedAgent(opts: { keepAliveTimeout?: number; keepAliveMaxTimeout?: number } = {}) {
  try {
    const require = createRequire(import.meta.url);
    const undici = createRequire(require.resolve('@discordjs/rest'))('undici') as typeof import('undici');
    return new undici.Agent({ keepAliveTimeout: 2_000, keepAliveMaxTimeout: 4_000, ...opts });
  } catch {
    return null;
  }
}

/** 디스코드 오류를 로그에 남길 한 줄로 (이름·코드·상태·메시지) */
function describeError(err: unknown): string {
  const e = err as { name?: string; code?: string | number; status?: number; message?: string; method?: string; url?: string };
  return [e.name, e.code !== undefined ? `code=${e.code}` : '', e.status ? `status=${e.status}` : '', e.method && e.url ? `${e.method} ${String(e.url).replace(/\/\d{15,}/g, '/…')}` : '', e.message]
    .filter(Boolean)
    .join(' · ');
}

/** 파일을 올리다 실패했을 때 사용자에게 보여 줄 이유 */
function uploadFailReason(err: unknown): string {
  const e = err as { code?: string | number; status?: number; message?: string };
  if (e.code === 50013 || e.status === 403) return "봇에게 '파일 첨부(Attach Files)' 권한이 없어요. 서버 설정 → 역할(또는 채널 권한 편집)에서 봇에게 허용해 주세요";
  if (e.code === 40005 || e.status === 413) return '파일이 너무 커서 디스코드가 받지 않아요';
  if (/abort|timeout/i.test(e.message ?? '')) return '디스코드로 보내는 데 시간이 너무 오래 걸렸어요';
  return e.message ?? '알 수 없는 오류';
}

/** 모델 입력 토큰을 글자 수로 대충 센다 (모델이 사용량을 안 알려 줄 때만) */
const roughTokens = (chars: number) => Math.ceil(chars / 2.5);

const restAgent = shortLivedAgent();

class BotManager {
  private runners = new Map<string, Runner>();
  private states = new Map<string, BotState>();
  /** 로그인이 거절된 봇: 토큰이나 설정을 바꿀 때까지 다시 시도하지 않는다 (키 = 토큰+인텐트) */
  private rejected = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;

  stateOf(userId: string): BotState {
    if (!config.DISCORD_BOTS_ENABLED) return { state: 'off', error: '관리자가 디스코드 봇 기능을 꺼 두었어요' };
    return this.states.get(userId) ?? { state: 'off' };
  }

  start() {
    if (this.timer) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_EVERY_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.runners.keys()].map((id) => this.stopOne(id)));
  }

  /** 거절됐던 봇을 다시 시도하게 한다 (개발자 포털에서 권한을 켠 뒤 "다시 연결"을 눌렀을 때) */
  async retry(userId: string) {
    this.rejected.delete(userId);
    await this.sync();
  }

  /** 켜져야 하는 봇과 지금 켜진 봇을 맞춘다 (토큰·설정이 바뀌었을 때 바로 부르기도 한다) */
  async sync() {
    // 시험 중에는 진짜 디스코드에 접속하지 않는다
    if (config.NODE_ENV === 'test' || this.syncing) return;
    this.syncing = true;
    try {
      const rows = config.DISCORD_BOTS_ENABLED
        ? (await pool.query<BotRow>('select * from discord_bots where enabled = true')).rows
        : [];
      const wanted = new Map(rows.map((r) => [r.user_id, r]));
      for (const [userId, runner] of this.runners) {
        const row = wanted.get(userId);
        // 토큰이 바뀌었거나 메시지 내용 권한이 필요해졌/필요 없어졌으면 다시 로그인해야 한다
        if (!row || row.token_enc !== runner.tokenEnc || wantsContent(row) !== runner.content) await this.stopOne(userId);
        else runner.row = row; // 채널·허용 사용자 같은 설정은 다시 로그인하지 않고 바로 반영
      }
      for (const userId of [...this.states.keys()]) if (!wanted.has(userId) && !this.runners.has(userId)) this.states.delete(userId);
      for (const row of rows) {
        if (this.runners.has(row.user_id)) continue;
        if (this.rejected.get(row.user_id) === `${row.token_enc}|${wantsContent(row)}`) continue;
        this.launch(row);
      }
    } catch (err) {
      console.error('[discord] 동기화 실패:', (err as Error).message);
    } finally {
      this.syncing = false;
    }
  }

  private async stopOne(userId: string) {
    const r = this.runners.get(userId);
    this.runners.delete(userId);
    this.states.set(userId, { state: 'off' });
    if (r) await r.client.destroy().catch(() => {});
  }

  private launch(row: BotRow) {
    const content = wantsContent(row);
    const rejectKey = `${row.token_enc}|${content}`;
    let token: string;
    try {
      token = decryptToken(row.token_enc);
    } catch {
      this.states.set(row.user_id, { state: 'error', error: '저장된 토큰을 읽을 수 없어요. 토큰을 다시 입력해 주세요' });
      this.rejected.set(row.user_id, rejectKey);
      return;
    }
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        // 지정한 채널의 모든 글을 읽으려면 필요 (개발자 포털에서 Message Content Intent 를 켜야 한다)
        ...(content ? [GatewayIntentBits.MessageContent] : []),
      ],
      partials: [Partials.Channel],
      allowedMentions: { parse: [], repliedUser: false },
      // 파일 올리기처럼 오래 걸리는 요청이 기본 15초 제한에 걸려 끊기지 않게
      rest: { timeout: 60_000, retries: 2, ...(restAgent ? { agent: restAgent as never } : {}) },
    });
    const runner: Runner = {
      row,
      tokenEnc: row.token_enc,
      content,
      client,
      limiter: new RateLimiter(config.DISCORD_MESSAGES_PER_HOUR, config.DISCORD_MESSAGES_PER_DAY),
      memory: new Conversations(),
      gate: new Gate(2, 4),
      busy: new Set(),
    };
    this.runners.set(row.user_id, runner);
    this.states.set(row.user_id, { state: 'starting' });

    client.once(Events.ClientReady, async (c) => {
      this.states.set(row.user_id, { state: 'online', guilds: c.guilds.cache.size });
      console.log(`[discord] 봇 켜짐: ${c.user.tag} (서버 ${c.guilds.cache.size}개, 채널 대화 ${content ? '켬' : '끔'})`);
      // 서버마다 등록하면 바로 나타난다 (전체 등록은 반영에 한 시간쯤 걸린다)
      for (const g of c.guilds.cache.values()) await g.commands.set(COMMANDS).catch(() => {});
    });
    client.on(Events.GuildCreate, (g) => {
      void g.commands.set(COMMANDS).catch(() => {});
      this.states.set(row.user_id, { state: 'online', guilds: client.guilds.cache.size });
    });
    client.on(Events.GuildDelete, () => this.states.set(row.user_id, { state: 'online', guilds: client.guilds.cache.size }));
    client.on(Events.InteractionCreate, (i) => {
      if (i.isChatInputCommand()) void this.onCommand(runner, i).catch((e) => console.error('[discord] 명령 오류:', (e as Error).message));
    });
    client.on(Events.MessageCreate, (m) => void this.onMessage(runner, m).catch((e) => console.error('[discord] 메시지 오류:', (e as Error).message)));
    client.on(Events.Error, (e) => console.error('[discord] 연결 오류:', e.message));

    client.login(token).catch(async (err: Error & { code?: string }) => {
      const intents = err.code === 'DisallowedIntents' || /disallowed intents/i.test(err.message);
      const invalid = err.code === 'TokenInvalid' || (!intents && /token/i.test(err.message));
      this.rejected.set(row.user_id, intents || invalid ? rejectKey : '');
      this.states.set(row.user_id, {
        state: 'error',
        error: intents
          ? '디스코드 개발자 포털 → Bot 메뉴 → Privileged Gateway Intents 에서 "Message Content Intent"를 켠 뒤 "다시 연결"을 눌러 주세요. (지정한 채널의 모든 글을 읽으려면 필요해요. 쓰지 않으려면 "채널에서 멘션 없이 답하기"를 꺼 주세요)'
          : invalid
            ? '토큰이 올바르지 않거나 취소됐어요. 새 토큰을 입력해 주세요'
            : `디스코드에 연결하지 못했어요 (${err.message}). 잠시 뒤 다시 시도해요`,
      });
      this.runners.delete(row.user_id);
      await client.destroy().catch(() => {});
    });
  }

  // ───────── 어디서 누가 쓸 수 있나 ─────────

  /** channelIds: 채널 ID 와 (스레드면) 부모 채널 ID */
  private allowed(r: Runner, channelIds: string[], userId: string, isDm: boolean): boolean {
    const chans = ids(r.row.allowed_channels);
    if (isDm ? !r.row.allow_dm : chans.size > 0 && !channelIds.some((c) => chans.has(c))) return false;
    const users = ids(r.row.allowed_users);
    return users.size === 0 || users.has(userId);
  }

  // ───────── 슬래시 명령 ─────────

  private async onCommand(r: Runner, i: ChatInputCommandInteraction) {
    const isDm = !i.inGuild();
    const channelIds = [i.channelId, ...(i.channel && 'parentId' in i.channel && i.channel.parentId ? [i.channel.parentId] : [])];
    if (!this.allowed(r, channelIds, i.user.id, isDm)) {
      return i.reply({ content: '여기서는 이 봇을 쓸 수 없어요.', flags: MessageFlags.Ephemeral });
    }
    const memKey = `${i.channelId}:${i.user.id}`;
    if (i.commandName === 'help') return i.reply({ content: helpText(r.content && ids(r.row.allowed_channels).has(i.channelId)), flags: MessageFlags.Ephemeral });
    if (i.commandName === 'reset') {
      r.memory.reset(memKey);
      return i.reply({ content: '이 채널의 대화 기억을 지웠어요.', flags: MessageFlags.Ephemeral });
    }
    if (i.commandName !== 'ask') return;
    const question = i.options.getString('질문', true).trim();
    if (!question) return i.reply({ content: '질문을 입력해 주세요.', flags: MessageFlags.Ephemeral });
    const file = i.options.getAttachment('파일');
    await i.deferReply();
    await this.answer(
      r,
      {
        edit: (t) => i.editReply({ content: t }),
        more: (t) => i.followUp({ content: t }),
        files: async (files) => {
          if (i.inGuild() && i.appPermissions && !i.appPermissions.has('AttachFiles')) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
          return i.followUp({ content: '📎', files: files.map((f) => ({ attachment: f.data, name: f.name })) });
        },
        typing: () => {},
      },
      i.user.id,
      memKey,
      question,
      file ? [{ name: file.name, url: file.url, size: file.size }] : [],
      i.options.getBoolean('깊게') ?? false,
    );
  }

  // ───────── 글: DM, @멘션, 지정한 채널의 모든 글 ─────────

  private async onMessage(r: Runner, m: Message) {
    const me = r.client.user;
    if (m.author.bot || m.system || !me) return;
    if (m.type !== MessageType.Default && m.type !== MessageType.Reply) return;
    const isDm = m.channel.type === ChannelType.DM;
    const channelIds = [m.channelId, ...(m.channel.isThread() && m.channel.parentId ? [m.channel.parentId] : [])];
    const mentioned = m.mentions.users.has(me.id) && !m.mentions.everyone;
    // 지정한 채널에서는 멘션 없이 그냥 쓴 글에도 답한다
    const chatty = r.content && channelIds.some((c) => ids(r.row.allowed_channels).has(c));
    if (!isDm && !mentioned && !chatty) return;
    if (!this.allowed(r, channelIds, m.author.id, isDm)) return;

    const raw = m.content ?? '';
    if (chatty && !mentioned && !isDm && IGNORE_PREFIX.test(raw)) return;
    const files: IncomingFile[] = [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url, size: a.size }));
    let question = raw.replace(new RegExp(`<@!?${me.id}>`, 'g'), '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!question && files.length) question = DEFAULT_ASK_WITH_FILES;
    if (!question) {
      // 멘션만 하고 아무 말도 안 했을 때만 안내한다 (지정한 채널의 빈 글·스티커는 조용히 넘어간다)
      if (mentioned || isDm) await m.reply('질문을 함께 써 주세요. 예: `@봇 오늘 저녁 뭐 먹지?`').catch(() => {});
      return;
    }
    const reply = await m.reply('💭 …');
    const ch = m.channel;
    await this.answer(
      r,
      {
        edit: (t) => reply.edit({ content: t }),
        more: (t) => (ch.isSendable() ? ch.send({ content: t }) : Promise.resolve()),
        files: async (fs) => {
          if (!ch.isSendable()) return;
          if ('permissionsFor' in ch && !ch.permissionsFor(me)?.has('AttachFiles')) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
          return ch.send({ content: '📎', files: fs.map((f) => ({ attachment: f.data, name: f.name })) });
        },
        typing: () => void (ch.isSendable() && 'sendTyping' in ch && ch.sendTyping().catch(() => {})),
      },
      m.author.id,
      `${m.channelId}:${m.author.id}`,
      question,
      files,
      false,
    );
  }

  // ───────── 답하기 ─────────

  private async answer(
    r: Runner,
    rawTarget: Target,
    discordUserId: string,
    memKey: string,
    question: string,
    incoming: IncomingFile[],
    thinking: boolean,
  ) {
    const target: Target = {
      edit: (t) => withNetRetry(() => rawTarget.edit(t)),
      more: (t) => withNetRetry(() => rawTarget.more(t)),
      files: (f) => withNetRetry(() => rawTarget.files(f)),
      typing: () => rawTarget.typing(),
    };
    const wait = r.limiter.take(discordUserId);
    if (wait) {
      const when = wait.retryAfterSec >= 120 ? `${Math.ceil(wait.retryAfterSec / 60)}분` : `${wait.retryAfterSec}초`;
      return target.edit(`요청이 너무 많아요 (${wait.reason === 'hour' ? '1시간' : '하루'} 한도). 약 ${when} 뒤에 다시 물어봐 주세요.`);
    }
    if (r.busy.has(discordUserId)) {
      r.limiter.refund(discordUserId);
      return target.edit('앞선 질문에 답하는 중이에요. 끝난 뒤에 다시 물어봐 주세요.');
    }
    r.busy.add(discordUserId);
    const ownerId = r.row.user_id;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MAX_ANSWER_TIME_MS);
    let releaseGate: (() => void) | null = null;
    let releaseSlot: (() => void) | null = null;
    let charged = false;
    let promptTokens = 0;
    let completionTokens = 0;
    const started = Date.now();
    try {
      // 봇 주인의 5시간 사용량을 쓴다 (다 썼으면 여기서 멈춘다)
      try {
        await checkAndStartWindow(ownerId);
      } catch (err) {
        r.limiter.refund(discordUserId);
        if (err instanceof HttpError && err.status === 429) return target.edit(`이 봇 주인의 ${err.message}`);
        throw err;
      }
      releaseGate = await r.gate.enter();
      if (!releaseGate || slotQueue.isFull()) {
        r.limiter.refund(discordUserId);
        return target.edit('지금 사용하는 사람이 많아요. 잠시 후 다시 물어봐 주세요.');
      }

      // 첨부를 읽는다 (이미지는 그대로, 문서는 글자로). 서버에 저장하지 않는다
      let prep: Prepared = { images: [], docs: [], notes: [], names: [] };
      if (incoming.length) {
        await target.edit('📎 첨부 파일을 읽는 중…');
        prep = await prepareAttachments(incoming);
        if (!prep.images.length && !prep.docs.length && question === DEFAULT_ASK_WITH_FILES) {
          // 읽을 수 있는 파일이 하나도 없고 질문도 없으면 모델을 부르지 않고 이유만 알려 준다
          r.limiter.refund(discordUserId);
          return target.edit(`첨부 파일을 읽지 못했어요.\n${prep.notes.map((n) => `• ${n}`).join('\n')}`);
        }
      }

      let queuedShown = 0;
      releaseSlot = await slotQueue.acquire(ctrl.signal, (pos) => {
        if (pos > 0 && pos !== queuedShown) {
          queuedShown = pos;
          void target.edit(`다른 질문을 처리하는 중이에요 (대기 ${pos}번째)…`).catch(() => {});
        }
      });
      await target.edit(thinking ? '🤔 생각하는 중…' : '💭 답을 쓰는 중…');
      const typing = setInterval(() => target.typing(), 8000);

      // 모델 입력 길이에 맞추기: 문서 → 지난 대화 순으로 줄인다
      const budget = inputBudgetTokens();
      const systemTokens = estimateTokens(SYSTEM_PROMPT) + 300; // 도구 설명 포함
      const userTurn = buildUserTurn(question, prep, Math.max(600, budget - systemTokens - estimateTokens(question) - prep.images.length * 1300 - 800));
      const history = fitHistory(r.memory.get(memKey), Math.max(0, budget - systemTokens - userTurn.tokens));

      const messages: ModelMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: userTurn.content } as ModelMessage,
      ];
      const outFiles: OutFile[] = [];
      let text = '';
      let thinkingShown = false;
      let shown = 0;
      let lastEdit = 0;
      let editing = false;
      charged = true;
      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const calls: ToolCall[] = [];
          let roundText = '';
          for await (const ev of streamChat({
            model: config.LLM_MODEL,
            messages,
            signal: ctrl.signal,
            enableThinking: thinking,
            // 생각하지 않고 바로 답할 때의 Qwen 권장 샘플링 (서버 기본값은 생각 모드용이라 글이 어색해질 수 있다)
            ...(thinking ? {} : { extra: { temperature: 0.7, top_p: 0.8 } }),
            // 마지막 차례에는 도구를 주지 않아서 반드시 글로 마무리하게 한다
            ...(round < MAX_TOOL_ROUNDS ? { tools: [SEND_FILE_TOOL] } : {}),
          })) {
            if (ev.type === 'reasoning' && !text && !roundText && !thinkingShown) {
              thinkingShown = true;
              void target.edit('🤔 생각하는 중…').catch(() => {});
            } else if (ev.type === 'delta') {
              roundText += ev.text;
              text += ev.text;
              const now = Date.now();
              if (!editing && now - lastEdit >= EDIT_INTERVAL_MS && text.length !== shown) {
                editing = true;
                lastEdit = now;
                shown = text.length;
                const first = splitMessage(text)[0] ?? text;
                void target
                  .edit(defang(first + (text.length > first.length ? '\n…' : ' ▌')))
                  .catch(() => {})
                  .finally(() => (editing = false));
              }
            } else if (ev.type === 'usage') {
              promptTokens += ev.promptTokens;
              completionTokens += ev.completionTokens;
            } else if (ev.type === 'tool_calls') {
              calls.push(...ev.calls);
            }
          }
          if (calls.length === 0) break;
          messages.push({
            role: 'assistant',
            content: roundText,
            tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })),
          });
          for (const c of calls) {
            const result = c.name === 'send_file' ? handleSendFile(c.arguments, outFiles) : `오류: 알 수 없는 도구예요: ${c.name}`;
            messages.push({ role: 'tool', tool_call_id: c.id, content: result });
          }
          if (round < MAX_TOOL_ROUNDS) text += text && !text.endsWith('\n') ? '\n\n' : '';
        }
      } finally {
        clearInterval(typing);
      }
      text = text.trim();
      if (!text && outFiles.length) text = `파일 ${outFiles.length}개를 올렸어요.`;
      if (!text) {
        r.limiter.refund(discordUserId);
        return target.edit('답을 만들지 못했어요. 다시 한번 물어봐 주세요.');
      }
      // 읽지 못한 첨부가 있으면 답 끝에 사용자에게도 직접 알린다 (모델이 빠뜨릴 수 있어서)
      const noteLine = prep.notes.length ? `\n\n> ⚠️ ${prep.notes.join('\n> ⚠️ ')}` : '';
      while (editing) await new Promise((res) => setTimeout(res, 100));
      const parts = splitMessage(defang(text) + defang(noteLine), DISCORD_LIMIT - 100);
      await target.edit(parts[0]!);
      for (const p of parts.slice(1, 6)) await target.more(p); // 아주 긴 답은 다섯 조각까지만
      if (outFiles.length) {
        try {
          await target.files(outFiles);
        } catch (err) {
          console.error('[discord] 파일 올리기 실패:', describeError(err));
          await target.more(`⚠️ 파일을 올리지 못했어요. ${uploadFailReason(err)}`).catch(() => {});
        }
      }
      r.memory.add(memKey, userTurn.remember, outFiles.length ? `${text}\n[올린 파일: ${outFiles.map((f) => f.name).join(', ')}]` : text);
      if (!completionTokens) completionTokens = roughTokens(text.length);
      if (!promptTokens) promptTokens = roughTokens(SYSTEM_PROMPT.length) + userTurn.tokens + history.reduce((n, t) => n + estimateTokens(t.content), 0);
    } catch (err) {
      r.limiter.refund(discordUserId);
      const msg = ctrl.signal.aborted
        ? '답을 만드는 데 너무 오래 걸려서 멈췄어요. 질문을 짧게 줄여 다시 시도해 주세요.'
        : err instanceof LlmError
          ? `${err.message} 잠시 후 다시 시도해 주세요.`
          : '답하는 중에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
      console.error('[discord] 답변 실패:', describeError(err), (err as Error).stack?.split('\n')[1]?.trim() ?? '');
      await target.edit(msg).catch(() => {});
    } finally {
      clearTimeout(timer);
      releaseSlot?.();
      releaseGate?.();
      r.busy.delete(discordUserId);
      // 모델을 실제로 쓴 만큼 봇 주인의 사용량에 기록한다
      if (charged && (promptTokens || completionTokens)) {
        await pool
          .query('insert into usage_logs (user_id, prompt_tokens, completion_tokens, duration_ms) values ($1, $2, $3, $4)', [
            ownerId,
            promptTokens,
            completionTokens,
            Date.now() - started,
          ])
          .catch((e) => console.error('[discord] 사용량 기록 실패:', (e as Error).message));
      }
    }
  }
}

export const botManager = new BotManager();
