-- 긴 대화 자동 요약: 앞부분을 요약해 두고, 그 뒤 메시지만 그대로 모델에 보낸다
alter table conversations
  add column summary text,
  -- 이 순서 번호까지의 메시지가 summary 에 담겨 있다
  add column summary_upto_seq bigint;
