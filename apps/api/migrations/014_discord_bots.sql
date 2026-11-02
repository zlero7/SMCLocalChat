-- 사용자가 설정에서 직접 연결하는 자기 디스코드 봇 (사용자 한 명당 봇 하나).
-- 봇 토큰은 암호화해서 저장하고, 이 봇이 쓰는 모델 사용량은 그 사용자의 5시간 사용량에서 빠진다.
create table discord_bots (
  user_id           uuid primary key references users(id) on delete cascade,
  -- AES-256-GCM 으로 암호화한 봇 토큰 (원문은 저장하지 않는다)
  token_enc         text not null,
  -- 디스코드가 알려준 봇의 사용자 ID. 같은 봇을 두 계정이 동시에 쓰지 못하게 한다
  bot_id            text not null unique,
  bot_name          text not null,
  enabled           boolean not null default true,
  -- 쉼표로 구분한 디스코드 채널 ID. 비우면 봇이 볼 수 있는 모든 채널
  allowed_channels  text not null default '',
  -- 쉼표로 구분한 디스코드 사용자 ID. 비우면 봇을 부를 수 있는 누구나 (사용량은 봇 주인 몫)
  allowed_users     text not null default '',
  allow_dm          boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
