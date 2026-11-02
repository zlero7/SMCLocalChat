-- 예약 작업에서도 웹 검색을 쓸지
alter table schedules add column web_search boolean not null default false;

-- 예약 실행 결과 답변에 남기는 도구 사용 기록은 messages.tools 를 그대로 쓴다
