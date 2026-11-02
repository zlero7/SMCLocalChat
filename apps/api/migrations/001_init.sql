-- 로컬 LLM 채팅 사이트 초기 스키마
-- 모든 대화/메시지 조회는 user_id 로 소유자를 검사한다.

create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null unique,
  nickname           text not null,
  password_hash      text not null,
  role               text not null default 'user' check (role in ('user', 'admin')),
  custom_instruction text not null default '',
  created_at         timestamptz not null default now()
);

create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index refresh_tokens_user_idx on refresh_tokens (user_id);

create table invite_codes (
  code        text primary key,
  created_by  uuid references users(id) on delete set null,
  used_by     uuid references users(id) on delete set null,
  used_at     timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null default '새 대화',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index conversations_user_updated_idx on conversations (user_id, updated_at desc);

create table messages (
  id               uuid primary key default gen_random_uuid(),
  seq              bigserial not null,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null default '',
  reasoning        text not null default '',
  status           text not null default 'done' check (status in ('done', 'stopped', 'error')),
  model            text,
  token_count      integer,
  created_at       timestamptz not null default now()
);
create index messages_conversation_idx on messages (conversation_id, seq);

create table usage_logs (
  id                bigserial primary key,
  user_id           uuid references users(id) on delete set null,
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,
  duration_ms       integer not null default 0,
  created_at        timestamptz not null default now()
);
create index usage_logs_created_idx on usage_logs (created_at);
