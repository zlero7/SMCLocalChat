-- 지정한 채널에서는 @멘션이나 /ask 없이 올라오는 모든 글에 봇이 답한다 (디스코드의 "메시지 내용" 권한이 필요)
alter table discord_bots add column channel_chat boolean not null default true;
