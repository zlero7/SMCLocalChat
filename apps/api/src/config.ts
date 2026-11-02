import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

// 레포 루트의 .env 를 먼저, 없으면 현재 폴더의 .env 를 읽는다. (이미 설정된 환경 변수는 덮어쓰지 않음)
dotenv.config({ path: path.resolve(here, '../../../.env'), quiet: true });
dotenv.config({ quiet: true });

const bool = (def: boolean) =>
  z
    .enum(['true', 'false'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  COOKIE_SECURE: bool(false),
  SERVE_WEB: bool(false),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL 이 필요해요'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET 은 32자 이상이어야 해요'),
  REGISTRATION_MODE: z.enum(['open', 'invite']).default('invite'),
  ADMIN_EMAIL: z.string().default(''),
  // 개인정보 처리방침에 적을 문의 이메일 (비우면 ADMIN_EMAIL)
  CONTACT_EMAIL: z.string().default(''),

  LLM_BASE_URL: z.string().default('http://127.0.0.1:8080/v1'),
  LLM_API_KEY: z.string().default('none'),
  LLM_MODEL: z.string().default('qwen3.6-35b-a3b'),
  // 사용자가 고를 수 있는 모델 목록. 쉼표로 구분, "모델ID=표시이름" 형식 가능. 비우면 LLM_MODEL 하나만
  LLM_MODELS: z.string().default(''),
  LLM_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  LLM_MAX_QUEUE: z.coerce.number().int().min(1).default(10),
  LLM_CONTEXT_TOKENS: z.coerce.number().int().min(1024).default(32768),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).default(8192),
  LLM_ENABLE_THINKING: bool(true),
  // 모델을 메모리에 올리는 동안 기다릴 최대 시간(초). 큰 모델을 처음 쓸 때 몇 분 걸릴 수 있다
  LLM_LOAD_TIMEOUT_SEC: z.coerce.number().int().min(30).default(900),
  // 생각 과정의 첫 문장을 미리 채워서 그 언어로 생각하게 만든다 (한국어로 물었을 때만). 비우면 끔
  LLM_THINKING_PREFIX: z.string().default(''),
  // 위 기능을 쓸 모델 (모델 ID 앞부분, 쉼표로 구분). <think> 형식으로 생각하는 모델에만 써야 한다
  LLM_THINKING_PREFIX_MODELS: z.string().default('qwen3'),

  // 같은 IP(학교 공유기 등)에서 여러 명이 쓸 수 있으니 필요하면 늘리세요
  LOGIN_FAIL_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(5),
  REGISTER_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
  MESSAGE_RATE_PER_MIN: z.coerce.number().int().min(1).default(10),
  DAILY_MESSAGE_LIMIT: z.coerce.number().int().min(1).default(200),
  // 5시간 동안 쓸 수 있는 토큰(질문+답변) 기본값. 관리자 화면에서 바꾸면 그 값이 우선한다
  TOKEN_LIMIT_DEFAULT: z.coerce.number().int().min(0).default(100_000),

  // 답변 하나를 만드는 동안 AI 가 쓸 수 있는 도구 호출 최대 횟수 (무한 반복 방지)
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(20),

  // 구글 로그인·Gmail 연결 (Google Cloud Console 의 OAuth 클라이언트). 비우면 구글 기능을 끈다
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // 구글이 로그인 뒤 돌려보낼 주소. 구글 콘솔의 "승인된 리디렉션 URI" 와 글자까지 똑같아야 한다
  // 예) http://localhost:4100/api/auth/google/callback 또는 https://chat.example.com/api/auth/google/callback
  GOOGLE_REDIRECT_URI: z.string().default(''),

  // 첨부 파일을 저장할 폴더 (비우면 레포 안의 data/uploads)
  UPLOAD_DIR: z.string().default(''),
  // 파일 하나의 최대 크기 (MB)
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(15),
  // 질문 하나에 붙인 문서들에서 AI 에게 넘길 글자 수 (길면 질문과 관련된 부분만 고른다)
  ATTACH_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(100_000).default(8000),

  // ── 디스코드 봇 (사용자가 설정에서 자기 봇을 연결) ──
  // false 면 사용자가 봇을 연결해도 켜지 않는다 (관리자용 비상 스위치)
  DISCORD_BOTS_ENABLED: bool(true),
  // 봇을 부르는 디스코드 사용자 한 명당 제한 (비용은 봇 주인의 사용량에서 나가므로 남용을 막는다)
  DISCORD_MESSAGES_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(20),
  DISCORD_MESSAGES_PER_DAY: z.coerce.number().int().min(1).max(100_000).default(100),
  // 시험할 때만 바꾼다
  DISCORD_API_BASE: z.string().default('https://discord.com/api/v10'),
  // 프로젝트 자료에서 AI 에게 넘길 글자 수 (자료가 많으면 질문과 관련된 부분만 고른다)
  PROJECT_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(100_000).default(5000),

  // 웹 검색: none(끔) | searxng(직접 설치, 키 없음) | tavily | brave (둘은 API 키 필요)
  WEB_SEARCH_PROVIDER: z.enum(['none', 'searxng', 'tavily', 'brave']).default('none'),
  // searxng 주소 (예: http://127.0.0.1:8888)
  WEB_SEARCH_URL: z.string().default(''),
  WEB_SEARCH_API_KEY: z.string().default(''),
  // 검색 한 번에 AI 에게 보여 줄 결과 수
  WEB_SEARCH_RESULTS: z.coerce.number().int().min(1).max(20).default(8),
  // 페이지 하나를 읽을 때 AI 에게 넘길 본문 최대 글자 수 (대화 길이를 아끼려고)
  WEB_FETCH_MAX_CHARS: z.coerce.number().int().min(1000).max(50_000).default(6000),
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(1).default(8000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('환경 변수 설정이 올바르지 않아요:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('.env.example 을 복사해서 .env 를 만들고 값을 채워 주세요.');
  process.exit(1);
}

export interface ModelOption {
  id: string;
  label: string;
}

function parseModels(list: string, fallback: string): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const item of list.split(',')) {
    const [rawId = '', ...rest] = item.split('=');
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: rest.join('=').trim() || id });
  }
  return models.length ? models : [{ id: fallback, label: fallback }];
}

const models = parseModels(parsed.data.LLM_MODELS, parsed.data.LLM_MODEL);

export const config = {
  ...parsed.data,
  MODELS: models,
  // LLM_MODEL 이 목록에 있으면 그게 기본, 없으면 목록의 첫 번째
  LLM_MODEL: models.some((m) => m.id === parsed.data.LLM_MODEL) ? parsed.data.LLM_MODEL : models[0]!.id,
  ADMIN_EMAIL: parsed.data.ADMIN_EMAIL.trim().toLowerCase(),
  CONTACT_EMAIL: parsed.data.CONTACT_EMAIL.trim(),
  LLM_BASE_URL: parsed.data.LLM_BASE_URL.replace(/\/+$/, ''),
  WEB_SEARCH_URL: parsed.data.WEB_SEARCH_URL.replace(/\/+$/, ''),
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export const paths = {
  migrations: path.resolve(here, '../migrations'),
  webDist: path.resolve(here, '../../web/dist'),
  uploads: parsed.data.UPLOAD_DIR ? path.resolve(parsed.data.UPLOAD_DIR) : path.resolve(here, '../../../data/uploads'),
};

export const DEFAULT_TITLE = '새 대화';
