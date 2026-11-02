-- 5시간 사용량 제한(관리자 설정)과 응답 스타일

-- 관리자가 화면에서 바꾸는 사이트 설정 (예: 기본 사용량 제한)
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table users
  -- 5시간 동안 쓸 수 있는 토큰 수. null 이면 사이트 기본값, 0 이면 사용 막음
  add column token_limit integer check (token_limit is null or token_limit >= 0),
  -- 지금 사용량 창이 시작된 시각. 이 시각부터 5시간이 지나면 다음 메시지에서 새 창이 시작된다
  add column usage_window_start timestamptz,
  -- 고른 응답 스타일: 기본 제공 스타일 id 또는 user_styles.id
  add column style_id text not null default 'default';

-- 사용자가 직접 만든 응답 스타일
create table user_styles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  instruction  text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index user_styles_user_idx on user_styles (user_id, created_at);

-- 사용자별 사용량 합계를 빠르게 구하기 위해
create index usage_logs_user_created_idx on usage_logs (user_id, created_at);
