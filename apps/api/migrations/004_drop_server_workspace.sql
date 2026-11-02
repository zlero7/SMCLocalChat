-- 서버 전용 작업 폴더 기능을 없애고, 사용자 컴퓨터 폴더(브라우저 권한) 방식으로 바꿨다.
-- 대화마다 서버 폴더를 기억할 필요가 없어졌다. (파일 작업 기록 messages.tools 는 그대로 쓴다)
alter table conversations drop column workspace;
