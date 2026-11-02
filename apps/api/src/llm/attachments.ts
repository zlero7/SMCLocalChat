import fs from 'node:fs/promises';
import { config } from '../config.js';
import { pool } from '../db.js';
import { storedPath, type AttachmentInfo } from '../files.js';
import type { ChatMessage } from './context.js';
import { selectRelevant } from './relevant.js';

/** 지난 메시지에 붙은 문서는 이만큼만 (앞부분) 다시 보여 준다 */
const OLD_DOC_CHARS = 1200;
/** 그림을 다시 보여 줄 최근 사용자 메시지 수 (그 전 그림은 이름만) */
const IMAGE_LOOKBACK = 3;

export interface HistoryRow {
  role: 'user' | 'assistant';
  content: string;
  attachments?: AttachmentInfo[] | null;
}

/**
 * 대화 기록의 첨부 파일을 모델이 읽을 수 있게 펼친다.
 * - 문서: 마지막 질문에 붙은 것은 ATTACH_CONTEXT_CHARS 까지 (길면 질문과 관련된 부분만), 지난 것은 앞부분만
 * - 이미지: 최근 질문 몇 개 중 그림이 있는 가장 최근 질문의 그림만 실제로 보내고, 나머지는 이름만
 */
export async function expandAttachments(userId: string, rows: (ChatMessage & HistoryRow)[]): Promise<ChatMessage[]> {
  const docIds = new Set<string>();
  for (const r of rows) for (const a of r.attachments ?? []) if (a.kind === 'document') docIds.add(a.id);
  const texts = new Map<string, string>();
  if (docIds.size) {
    const { rows: files } = await pool.query<{ id: string; text: string | null }>(
      'select id, text from files where id = any($1::uuid[]) and user_id = $2',
      [[...docIds], userId],
    );
    for (const f of files) texts.set(f.id, f.text ?? '');
  }

  const userIdx = rows.map((r, i) => (r.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const lastUser = userIdx[userIdx.length - 1] ?? -1;
  const imageMsg = [...userIdx]
    .slice(-IMAGE_LOOKBACK)
    .reverse()
    .find((i) => rows[i]!.attachments?.some((a) => a.kind === 'image'));

  return Promise.all(
    rows.map(async (r, i): Promise<ChatMessage> => {
      const atts = r.attachments ?? [];
      if (r.role !== 'user' || atts.length === 0) return { role: r.role, content: r.content };
      const docs = atts.filter((a) => a.kind === 'document');
      const parts: string[] = [r.content];
      const perDoc = Math.floor(config.ATTACH_CONTEXT_CHARS / Math.max(1, docs.length));
      for (const d of docs) {
        const full = texts.get(d.id);
        if (full === undefined) {
          parts.push(`[첨부 문서: ${d.name} — 파일이 지워져서 읽을 수 없음]`);
          continue;
        }
        if (i === lastUser) {
          const { text, trimmed } = selectRelevant(full, r.content, perDoc);
          parts.push(
            `[첨부 문서: ${d.name}${trimmed ? ` — 전체 ${full.length.toLocaleString()}자 중 질문과 관련된 부분만` : ''}]\n"""\n${text}\n"""`,
          );
        } else {
          const cut = full.length > OLD_DOC_CHARS;
          parts.push(`[앞서 첨부한 문서: ${d.name}${cut ? ' — 앞부분만' : ''}]\n"""\n${full.slice(0, OLD_DOC_CHARS)}${cut ? '\n…' : ''}\n"""`);
        }
      }
      const imgs = atts.filter((a) => a.kind === 'image');
      let images: string[] | undefined;
      if (imgs.length && i === imageMsg) {
        images = (
          await Promise.all(
            imgs.map(async (a) => {
              try {
                const data = await fs.readFile(storedPath({ stored_as: await storedAs(a.id, userId) }));
                return `data:${a.mime};base64,${data.toString('base64')}`;
              } catch {
                return null;
              }
            }),
          )
        ).filter((x): x is string => x !== null);
        const missing = imgs.length - images.length;
        if (missing) parts.push(`[이미지 ${missing}장은 파일이 지워져서 볼 수 없음]`);
      } else if (imgs.length) {
        parts.push(`[앞서 보낸 이미지: ${imgs.map((a) => a.name).join(', ')} — 지금은 볼 수 없으니 필요하면 다시 올려 달라고 하세요]`);
      }
      return { role: 'user', content: parts.filter(Boolean).join('\n\n'), ...(images?.length ? { images } : {}) };
    }),
  );
}

async function storedAs(fileId: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ stored_as: string }>('select stored_as from files where id = $1 and user_id = $2', [
    fileId,
    userId,
  ]);
  if (!rows[0]) throw new Error('없는 파일');
  return rows[0].stored_as;
}
