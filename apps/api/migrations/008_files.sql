-- 올린 파일 (메시지 첨부, 나중에 프로젝트 자료). 파일 자체는 UPLOAD_DIR 에, 문서에서 뽑은 글자는 text 에 둔다
create table files (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  mime        text not null,
  size        integer not null,
  kind        text not null check (kind in ('image', 'document')),
  -- 문서에서 뽑은 글자 (이미지는 null)
  text        text,
  -- UPLOAD_DIR 안의 파일 이름
  stored_as   text not null,
  -- 메시지에 붙여 보냈는지 (안 붙인 파일은 하루 뒤 정리)
  attached    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index files_user_idx on files (user_id, created_at);
create index files_unattached_idx on files (created_at) where not attached;
