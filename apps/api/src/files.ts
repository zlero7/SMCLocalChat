import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { paths } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';

/** 문서에서 뽑아 저장하는 글자의 최대 길이 */
const MAX_STORED_CHARS = 300_000;

export type FileKind = 'image' | 'document';

export interface FileRow {
  id: string;
  user_id: string;
  name: string;
  mime: string;
  size: number;
  kind: FileKind;
  text: string | null;
  stored_as: string;
  attached: boolean;
  created_at: Date;
}

/** 메시지에 붙여 저장하는 파일 정보 (messages.attachments) */
export interface AttachmentInfo {
  id: string;
  name: string;
  kind: FileKind;
  mime: string;
  size: number;
}

export const toAttachment = (f: Pick<FileRow, 'id' | 'name' | 'kind' | 'mime' | 'size'>): AttachmentInfo => ({
  id: f.id,
  name: f.name,
  kind: f.kind,
  mime: f.mime,
  size: f.size,
});

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const TEXT_EXTS = new Set(
  (
    'txt md markdown csv tsv json jsonl xml yaml yml log ini toml conf cfg env sql ' +
    'py js mjs cjs ts tsx jsx java kt kts c h cpp hpp cc cs go rs rb php swift sh bash ps1 bat ' +
    'css scss less html htm vue svelte r m lua dart scala gradle properties srt vtt tex'
  ).split(' '),
);
const UNSUPPORTED: Record<string, string> = {
  hwp: '한글(HWP) 파일은 아직 못 읽어요. 한글에서 PDF 나 워드(.docx)로 저장해서 올려 주세요.',
  hwpx: '한글(HWPX) 파일은 아직 못 읽어요. 한글에서 PDF 나 워드(.docx)로 저장해서 올려 주세요.',
  doc: '옛 워드(.doc) 파일은 못 읽어요. 워드에서 .docx 로 저장해서 올려 주세요.',
  xlsx: '엑셀 파일은 아직 못 읽어요. CSV 로 저장해서 올려 주세요.',
  xls: '엑셀 파일은 아직 못 읽어요. CSV 로 저장해서 올려 주세요.',
  pptx: '파워포인트 파일은 아직 못 읽어요. PDF 로 저장해서 올려 주세요.',
  ppt: '파워포인트 파일은 아직 못 읽어요. PDF 로 저장해서 올려 주세요.',
};

const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/** 파일 내용이 정말 그 형식인지 앞부분으로 확인한다 (이름만 바꾼 파일을 거른다) */
function looksLike(kind: 'png' | 'jpeg' | 'webp' | 'gif' | 'pdf' | 'zip', b: Buffer): boolean {
  switch (kind) {
    case 'png':
      return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpeg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'webp':
      return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    case 'gif':
      return b.toString('latin1', 0, 4) === 'GIF8';
    case 'pdf':
      return b.toString('latin1', 0, 5) === '%PDF-';
    case 'zip':
      return b[0] === 0x50 && b[1] === 0x4b;
  }
}

/** 텍스트 파일 글자 (UTF-8, 안 되면 EUC-KR). 글이 아닌 파일이면 null */
function decodeText(b: Buffer): string | null {
  if (b.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, '');
  } catch {
    try {
      return new TextDecoder('euc-kr', { fatal: true }).decode(b);
    } catch {
      return null;
    }
  }
}

const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** 올린 파일을 검사하고 종류·글자를 정한다 */
export async function inspectUpload(name: string, data: Buffer): Promise<{ kind: FileKind; mime: string; text: string | null }> {
  const ext = extOf(name);
  if (UNSUPPORTED[ext]) throw new HttpError(400, UNSUPPORTED[ext]!);
  if (IMAGE_TYPES[ext]) {
    const sig = ext === 'jpg' ? 'jpeg' : (ext as 'png' | 'jpeg' | 'webp' | 'gif');
    if (!looksLike(sig, data)) throw new HttpError(400, '이미지 파일이 아니거나 깨진 파일이에요.');
    return { kind: 'image', mime: IMAGE_TYPES[ext]!, text: null };
  }
  if (ext === 'pdf') {
    if (!looksLike('pdf', data)) throw new HttpError(400, 'PDF 파일이 아니거나 깨진 파일이에요.');
    let text = '';
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const result = await extractText(pdf, { mergePages: false });
      text = (Array.isArray(result.text) ? result.text : [result.text])
        .map((page, i) => `[${i + 1}쪽]\n${tidy(page)}`)
        .join('\n\n');
    } catch {
      throw new HttpError(400, 'PDF 를 읽지 못했어요 (암호가 걸렸거나 깨진 파일일 수 있어요).');
    }
    if (text.replace(/\[\d+쪽\]/g, '').trim().length < 20) {
      throw new HttpError(400, '이 PDF 에서는 글자를 뽑지 못했어요. 스캔한 문서(그림으로 된 PDF)라면 쪽마다 이미지로 올려 주세요.');
    }
    return { kind: 'document', mime: 'application/pdf', text };
  }
  if (ext === 'docx') {
    if (!looksLike('zip', data)) throw new HttpError(400, '워드 파일이 아니거나 깨진 파일이에요.');
    try {
      const { value } = await mammoth.extractRawText({ buffer: data });
      if (!value.trim()) throw new Error('빈 문서');
      return {
        kind: 'document',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        text: tidy(value),
      };
    } catch {
      throw new HttpError(400, '워드 파일에서 글자를 뽑지 못했어요.');
    }
  }
  if (TEXT_EXTS.has(ext) || ext === '') {
    const text = decodeText(data);
    if (text === null) throw new HttpError(400, '글로 된 파일이 아니에요. 이미지·PDF·워드·텍스트 파일만 올릴 수 있어요.');
    if (!text.trim()) throw new HttpError(400, '빈 파일이에요.');
    return { kind: 'document', mime: 'text/plain', text: tidy(text) };
  }
  throw new HttpError(400, `.${ext} 파일은 올릴 수 없어요. 이미지(PNG·JPG·WEBP·GIF), PDF, 워드(.docx), 텍스트·코드 파일만 돼요.`);
}

/** 파일을 저장하고 표에 기록한다 */
export async function saveUpload(userId: string, rawName: string, data: Buffer): Promise<FileRow> {
  // 경로 문자나 제어 문자는 빼고, 너무 긴 이름은 자른다
  const name = (rawName.replace(/[\\/\u0000-\u001f]/g, '_').trim() || '파일').slice(0, 200);
  if (data.length === 0) throw new HttpError(400, '빈 파일이에요.');
  const info = await inspectUpload(name, data);
  const text = info.text && info.text.length > MAX_STORED_CHARS ? info.text.slice(0, MAX_STORED_CHARS) : info.text;
  await fs.mkdir(paths.uploads, { recursive: true });
  const { rows } = await pool.query<FileRow>(
    `insert into files (user_id, name, mime, size, kind, text, stored_as)
     values ($1, $2, $3, $4, $5, $6, gen_random_uuid()::text)
     returning *`,
    [userId, name, info.mime, data.length, info.kind, text],
  );
  const row = rows[0]!;
  try {
    await fs.writeFile(path.join(paths.uploads, row.stored_as), data);
  } catch (err) {
    await pool.query('delete from files where id = $1', [row.id]);
    throw err;
  }
  return row;
}

export const storedPath = (f: Pick<FileRow, 'stored_as'>) => path.join(paths.uploads, f.stored_as);

/** 이 사용자의 파일들 (없거나 남의 파일이면 404) */
export async function getOwnedFiles(userId: string, ids: string[]): Promise<FileRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<FileRow>('select * from files where id = any($1::uuid[]) and user_id = $2', [ids, userId]);
  if (rows.length !== new Set(ids).size) throw new HttpError(404, '첨부 파일을 찾을 수 없어요. 다시 올려 주세요.');
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!);
}

/**
 * 메시지에 붙이지 않고 하루가 지난 파일을 지운다.
 * 계정이 지워져 표에서 사라진 파일(주인 없는 파일)도 폴더에서 지운다.
 */
export async function cleanupUnattached(): Promise<number> {
  const { rows } = await pool.query<{ stored_as: string }>(
    `delete from files where not attached and created_at < now() - interval '1 day' returning stored_as`,
  );
  await Promise.all(rows.map((r) => fs.rm(storedPath(r), { force: true }).catch(() => {})));

  let orphans = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(paths.uploads);
  } catch {
    return rows.length; // 아직 폴더가 없다
  }
  const known = new Set((await pool.query<{ stored_as: string }>('select stored_as from files')).rows.map((r) => r.stored_as));
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (known.has(name)) continue;
    const full = path.join(paths.uploads, name);
    try {
      // 방금 올라가는 중인 파일은 건드리지 않는다
      if ((await fs.stat(full)).mtimeMs > hourAgo) continue;
      await fs.rm(full, { force: true });
      orphans++;
    } catch {
      /* 다음에 다시 */
    }
  }
  return rows.length + orphans;
}
