-- 기억: 대화에서 알게 된 사용자에 대한 오래 가는 사실. 모든 대화의 시스템 프롬프트에 들어간다
create table memories (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  content                 text not null,
  -- 이 기억을 만든 대화 (사용자가 직접 적었으면 null)
  source_conversation_id  uuid references conversations(id) on delete set null,
  created_at              timestamptz not null default now()
);
create index memories_user_idx on memories (user_id, created_at desc);

-- 기억 기능을 쓸지 (끄면 새로 기억하지도, 기억한 것을 쓰지도 않는다)
alter table users add column memory_enabled boolean not null default true;
