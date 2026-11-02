-- 작업 폴더 (Claude Code 처럼 대화마다 폴더를 정해 그 안의 파일을 AI 가 다룬다)

-- 이 대화의 작업 폴더: 사용자 전용 폴더 안의 상대 경로. null 이면 일반 대화(파일 도구 없음)
alter table conversations add column workspace text;

-- 답변을 만드는 동안 AI 가 한 파일 작업 기록 (화면 표시용)
-- [{ id, name, args, status: 'ok'|'error'|'denied', summary }]
alter table messages add column tools jsonb not null default '[]'::jsonb;
