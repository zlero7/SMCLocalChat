import type { Conversation } from './types';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 사이드바용: 오늘 / 어제 / 지난 7일 / 지난 30일 / 이전 으로 묶는다 (목록은 이미 최신순) */
export function groupConversations(items: Conversation[], now = new Date()) {
  const today = startOfDay(now);
  const DAY = 24 * 60 * 60 * 1000;
  const groups: { label: string; items: Conversation[] }[] = [
    { label: '오늘', items: [] },
    { label: '어제', items: [] },
    { label: '지난 7일', items: [] },
    { label: '지난 30일', items: [] },
    { label: '이전', items: [] },
  ];
  for (const item of items) {
    const t = startOfDay(new Date(item.updatedAt));
    if (t >= today) groups[0]!.items.push(item);
    else if (t >= today - DAY) groups[1]!.items.push(item);
    else if (t >= today - 7 * DAY) groups[2]!.items.push(item);
    else if (t >= today - 30 * DAY) groups[3]!.items.push(item);
    else groups[4]!.items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}
