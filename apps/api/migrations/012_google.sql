-- 구글 로그인과 Gmail 연결

-- 구글로만 가입한 계정은 비밀번호가 없다
alter table users alter column password_hash drop not null;
-- 이 계정에 연결된 구글 계정 (구글 로그인용, 구글이 주는 바뀌지 않는 사용자 번호)
alter table users add column google_sub text unique;

-- Gmail 읽기 권한 (사용자당 하나). 구글의 리프레시 토큰은 암호화해서 저장한다
create table google_accounts (
  user_id            uuid primary key references users(id) on delete cascade,
  google_sub         text not null,
  email              text not null,
  scopes             text not null,
  refresh_token_enc  text not null,
  connected_at       timestamptz not null default now()
);

-- 예약 작업에서도 Gmail 을 쓸지
alter table schedules add column gmail boolean not null default false;
