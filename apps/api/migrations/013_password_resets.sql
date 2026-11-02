-- 관리자가 만들어 주는 일회용 비밀번호 재설정 링크 (이메일 발송이 없으므로 관리자가 전달한다)
create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  -- 링크에 든 토큰의 sha256 (원문은 저장하지 않는다)
  token_hash  text not null unique,
  created_by  uuid references users(id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index password_resets_user_idx on password_resets (user_id);
