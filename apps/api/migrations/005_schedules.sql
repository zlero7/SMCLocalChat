-- 예약 작업: 정해 둔 시각에 서버가 지시를 AI 에게 보내고 결과를 새 대화로 남긴다

create table schedules (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  title                 text not null,
  prompt                text not null,
  -- null 이면 사이트 기본 모델 / 사용자가 고른 기본 스타일
  model                 text,
  style_id              text,
  -- once: run_date 에 한 번, daily: 매일, weekly: weekdays(0=일 ~ 6=토) 에 해당하는 요일마다
  repeat                text not null check (repeat in ('once', 'daily', 'weekly')),
  time_of_day           text not null check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  weekdays              smallint[] not null default '{}',
  run_date              date,
  -- 시각을 해석할 시간대 (사용자 브라우저 기준, 예: Asia/Seoul)
  timezone              text not null,
  enabled               boolean not null default true,
  -- 다음 실행 시각. 꺼져 있거나 한 번짜리가 끝났으면 null
  next_run_at           timestamptz,
  last_run_at           timestamptz,
  last_status           text check (last_status in ('done', 'error', 'skipped')),
  last_message          text,
  last_conversation_id  uuid references conversations(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (repeat <> 'once' or run_date is not null),
  check (repeat <> 'weekly' or cardinality(weekdays) > 0)
);
create index schedules_due_idx on schedules (next_run_at) where enabled;
create index schedules_user_idx on schedules (user_id, created_at);

alter table conversations
  -- 예약 작업이 만든 대화
  add column schedule_id uuid references schedules(id) on delete set null,
  -- 사용자가 아직 열어 보지 않은 새 결과
  add column unread boolean not null default false;
