-- 프로젝트: 대화를 주제별로 묶고, 그 안의 모든 대화에 공통 지침과 자료를 준다
create table projects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  -- 이 프로젝트의 모든 대화에 들어가는 지침
  instructions  text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index projects_user_idx on projects (user_id, updated_at desc);

-- 대화가 속한 프로젝트 (프로젝트를 지우면 대화는 남고 프로젝트에서만 빠진다)
alter table conversations add column project_id uuid references projects(id) on delete set null;
create index conversations_project_idx on conversations (project_id, updated_at desc) where project_id is not null;

-- 프로젝트 자료로 올린 파일 (프로젝트를 지우면 같이 지워진다)
alter table files add column project_id uuid references projects(id) on delete cascade;
create index files_project_idx on files (project_id) where project_id is not null;
