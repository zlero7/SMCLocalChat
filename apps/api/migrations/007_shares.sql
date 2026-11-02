-- 사용자 메시지에 붙인 파일 목록 [{id, name, kind, mime, size}] (파일 자체는 files 표)
alter table messages add column attachments jsonb not null default '[]';

-- 대화 공유 링크: 링크를 아는 사람은 로그인 없이 그 대화를 읽을 수 있다 (공유한 시점까지의 메시지만)
create table shares (
  token            text primary key,
  conversation_id  uuid not null unique references conversations(id) on delete cascade,
  user_id          uuid not null references users(id) on delete cascade,
  -- 이 순서 번호까지의 메시지만 보여 준다 (공유 뒤에 이어진 대화는 보이지 않음)
  upto_seq         bigint not null,
  created_at       timestamptz not null default now()
);
