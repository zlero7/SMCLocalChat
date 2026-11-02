import { loadRunnerConnection, pingRunner, runOnRunner, RunnerError } from './runner';
import type { ToolPreview } from './types';

/**
 * 사용자 컴퓨터의 폴더를 AI 가 다루게 하는 부분 (브라우저 File System Access API).
 *
 * - 사용자가 "내 컴퓨터 폴더 열기"로 폴더를 고르면 브라우저가 권한을 묻고, 그 폴더의 핸들을 받는다.
 * - AI 의 도구 호출은 서버를 거쳐 여기로 오고, 이 폴더 핸들 안에서만 실행된다.
 *   (핸들 밖으로는 브라우저가 원래 접근을 막는다. 여기서도 .. 와 절대 경로는 거절한다)
 * - 크롬·엣지(컴퓨터)에서, HTTPS 또는 localhost 로 접속했을 때만 쓸 수 있다.
 * - 도구 이름·인자는 서버의 apps/api/src/llm/tools.ts 와 맞춰야 한다.
 */

// lib.dom 에 아직 없거나 버전마다 다른 File System Access API 부분
type DirHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
  queryPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

export interface LocalFolder {
  name: string;
  handle: DirHandle;
}

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);

/** 이 브라우저에서 쓸 수 있는지. 안 되면 이유를 돌려준다 */
export function localFolderUnsupportedReason(): string | null {
  if (!('showDirectoryPicker' in window)) return '크롬이나 엣지(컴퓨터)에서만 쓸 수 있어요.';
  if (!window.isSecureContext) return '사이트가 HTTPS 주소일 때만 쓸 수 있어요 (이 PC 의 localhost 는 가능).';
  return null;
}

/** 폴더 고르기 창을 띄운다. 취소하면 null */
export async function pickLocalFolder(): Promise<LocalFolder | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker;
    const handle = await picker({ mode: 'readwrite', id: 'chat-site-folder' });
    console.info('[folder] 고른 폴더:', handle.name);
    return { name: handle.name, handle };
  } catch (err) {
    // 사용자가 취소해도, 브라우저가 권한을 막아도 AbortError 가 올 수 있어서 기록은 남긴다
    console.warn('[folder] 폴더 고르기 실패:', (err as Error).name, (err as Error).message);
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  }
}

/** 읽기·쓰기 권한이 있는지 확인하고, 없으면 (interactive 일 때) 다시 묻는다 */
export async function ensurePermission(folder: LocalFolder, interactive: boolean): Promise<boolean> {
  const mode = { mode: 'readwrite' as const };
  if ((await folder.handle.queryPermission(mode)) === 'granted') return true;
  if (!interactive) return false;
  return (await folder.handle.requestPermission(mode)) === 'granted';
}

// ───────── 대화별 폴더 기억 (IndexedDB: 폴더 핸들은 여기에만 저장할 수 있다) ─────────

const DB_NAME = 'chat-site';
const STORE = 'local-folders';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** 이 대화에서 쓸 폴더를 이 브라우저에 기억한다 (null 이면 지운다) */
export async function saveConversationFolder(convId: string, folder: LocalFolder | null): Promise<void> {
  try {
    if (folder) await withStore('readwrite', (s) => s.put(folder.handle, convId));
    else await withStore('readwrite', (s) => s.delete(convId));
  } catch {
    /* 기억하지 못해도 지금 화면에서는 계속 쓸 수 있다 */
  }
}

export async function loadConversationFolder(convId: string): Promise<LocalFolder | null> {
  try {
    const handle = await withStore<DirHandle | undefined>('readonly', (s) => s.get(convId) as IDBRequest<DirHandle | undefined>);
    return handle ? { name: handle.name, handle } : null;
  } catch {
    return null;
  }
}

// ───────── 경로 ─────────

class ToolError extends Error {}

/** "src/a.py" → ['src', 'a.py']. 폴더 밖으로 나가는 경로는 거절 */
function splitPath(rel: unknown, name = 'path'): string[] {
  if (typeof rel !== 'string') throw new ToolError(`${name} 값이 필요해요`);
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new ToolError('절대 경로는 쓸 수 없어요. 작업 폴더 기준 경로를 써 주세요');
  }
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new ToolError('상위 폴더(..)로는 갈 수 없어요');
  return parts;
}

const show = (parts: string[]) => parts.join('/') || '.';

async function getDir(root: DirHandle, parts: string[], create = false): Promise<DirHandle> {
  let dir = root;
  for (let i = 0; i < parts.length; i++) {
    try {
      dir = (await dir.getDirectoryHandle(parts[i]!, { create })) as DirHandle;
    } catch (err) {
      const where = show(parts.slice(0, i + 1));
      if ((err as Error).name === 'TypeMismatchError') throw new ToolError(`폴더가 아니에요: ${where}`);
      throw new ToolError(`없는 폴더예요: ${where}`);
    }
  }
  return dir;
}

async function getFile(root: DirHandle, parts: string[], create = false): Promise<FileSystemFileHandle> {
  if (parts.length === 0) throw new ToolError('파일 경로가 필요해요');
  const dir = await getDir(root, parts.slice(0, -1), create);
  try {
    return await dir.getFileHandle(parts.at(-1)!, { create });
  } catch (err) {
    if ((err as Error).name === 'TypeMismatchError') throw new ToolError(`파일이 아니라 폴더예요: ${show(parts)}`);
    throw new ToolError(`없는 파일이에요: ${show(parts)}`);
  }
}

async function readTextFile(root: DirHandle, parts: string[]): Promise<string> {
  const file = await (await getFile(root, parts)).getFile();
  if (file.size > MAX_READ_BYTES) throw new ToolError(`파일이 너무 커요 (${Math.round(file.size / 1024)}KB, 최대 1MB)`);
  const head = new Uint8Array(await file.slice(0, 8000).arrayBuffer());
  if (head.includes(0)) throw new ToolError(`텍스트가 아닌 파일이라 읽을 수 없어요: ${show(parts)}`);
  return file.text();
}

async function writeTextFile(root: DirHandle, parts: string[], content: string): Promise<void> {
  if (new Blob([content]).size > MAX_WRITE_BYTES) throw new ToolError('한 번에 쓸 수 있는 크기(1MB)를 넘어요');
  const handle = await getFile(root, parts, true);
  const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  await writable.write(content);
  await writable.close();
}

async function fileExists(root: DirHandle, parts: string[]): Promise<boolean> {
  try {
    await getFile(root, parts);
    return true;
  } catch {
    return false;
  }
}

/** 도우미가 켜져 있고, 지금 연 폴더와 같은 폴더를 지켜보는지 확인한다 */
async function requireRunner(root: DirHandle) {
  const conn = loadRunnerConnection();
  if (!conn) {
    throw new ToolError('프로그램 실행 도우미가 연결되어 있지 않아요. 사용자에게 설정의 "프로그램 실행"에서 도우미를 켜고 연결해 달라고 안내해 주세요');
  }
  try {
    const info = await pingRunner(conn);
    if (info.folder !== root.name) {
      throw new ToolError(`도우미는 "${info.folder}" 폴더에서 켜져 있는데 지금 연 폴더는 "${root.name}" 예요. 같은 폴더에서 도우미를 다시 켜 달라고 안내해 주세요`);
    }
  } catch (err) {
    if (err instanceof RunnerError) throw new ToolError(err.message);
    throw err;
  }
  return conn;
}

/** 와일드카드(* ?)가 있으면 이름 전체 맞추기, 없으면 이름에 들어 있는지 */
function nameMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim().toLowerCase();
  if (!/[*?]/.test(p)) return (n) => n.toLowerCase().includes(p);
  const re = new RegExp('^' + p.replace(/[.+^$\{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return (n) => re.test(n.toLowerCase());
}

/** 폴더 안을 재귀로 훑는다 (폴더·파일 모두). 너무 깊으면 멈춘다 */
async function* walkAll(dir: DirHandle, prefix: string[], depth = 0): AsyncGenerator<{ parts: string[]; kind: 'file' | 'directory' }> {
  if (depth > 12) return;
  for await (const [name, h] of dir.entries()) {
    yield { parts: [...prefix, name], kind: h.kind };
    if (h.kind === 'directory' && !SKIP_DIRS.has(name)) yield* walkAll(h as DirHandle, [...prefix, name], depth + 1);
  }
}

async function exists(root: DirHandle, parts: string[]): Promise<'file' | 'directory' | null> {
  try {
    await getFile(root, parts);
    return 'file';
  } catch {
    /* 파일이 아님 */
  }
  try {
    await getDir(root, parts);
    return 'directory';
  } catch {
    return null;
  }
}

async function copyEntry(from: DirHandle, fromName: string, to: DirHandle, toName: string, kind: 'file' | 'directory', budget: { left: number }) {
  if (--budget.left < 0) throw new ToolError('복사할 파일이 너무 많아요 (최대 5000개)');
  if (kind === 'file') {
    const src = await (await from.getFileHandle(fromName)).getFile();
    const dst = (await to.getFileHandle(toName, { create: true })) as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> };
    const w = await dst.createWritable();
    await src.stream().pipeTo(w);
    return;
  }
  const srcDir = (await from.getDirectoryHandle(fromName)) as DirHandle;
  const dstDir = (await to.getDirectoryHandle(toName, { create: true })) as DirHandle;
  for await (const [name, h] of srcDir.entries()) await copyEntry(srcDir, name, dstDir, name, h.kind, budget);
}

/** 옮기기(remove=true, 이름 바꾸기 포함)와 복사. 복사에 성공한 뒤에만 원본을 지운다 */
async function transfer(root: DirHandle, a: Args, remove: boolean): Promise<ToolRunResult> {
  const from = splitPath(a.from, 'from');
  const to = splitPath(a.to, 'to');
  if (!from.length || !to.length) throw new ToolError('작업 폴더 자체는 옮기거나 복사할 수 없어요');
  const kind = await exists(root, from);
  if (!kind) throw new ToolError('없는 경로예요: ' + show(from));
  if (show(from) === show(to)) throw new ToolError('지금 경로와 새 경로가 같아요');
  if (kind === 'directory' && to.length > from.length && from.every((p, i) => to[i] === p)) {
    throw new ToolError('폴더를 자기 자신의 안으로는 옮기거나 복사할 수 없어요');
  }
  if (await exists(root, to)) throw new ToolError('이미 있는 경로예요: ' + show(to) + '. 다른 이름을 쓰거나 먼저 지워 주세요');
  const srcParent = await getDir(root, from.slice(0, -1));
  const dstParent = await getDir(root, to.slice(0, -1), true);
  await copyEntry(srcParent, from.at(-1)!, dstParent, to.at(-1)!, kind, { left: 5000 });
  if (remove) await srcParent.removeEntry(from.at(-1)!, { recursive: true });
  const rename = from.slice(0, -1).join('/') === to.slice(0, -1).join('/');
  const verb = !remove ? '복사했습니다' : rename ? '이름을 바꿨습니다' : '옮겼습니다';
  return ok(verb + ': ' + show(from) + ' → ' + show(to), show(from) + ' → ' + show(to) + (remove ? (rename ? ' (이름 바꿈)' : ' (옮김)') : ' (복사)'));
}

async function* walk(dir: DirHandle, prefix: string[], depth = 0): AsyncGenerator<{ parts: string[]; handle: FileSystemFileHandle }> {
  if (depth > 12) return;
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') {
      if (!SKIP_DIRS.has(name)) yield* walk(h as DirHandle, [...prefix, name], depth + 1);
    } else {
      yield { parts: [...prefix, name], handle: h as FileSystemFileHandle };
    }
  }
}

// ───────── 도구 ─────────

export interface ToolRunResult {
  status: 'ok' | 'error';
  result: string;
  summary: string;
}

const ok = (result: string, summary: string): ToolRunResult => ({ status: 'ok', result, summary });

type Args = Record<string, unknown>;
const optInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string') throw new ToolError(`${name} 값이 필요해요`);
  return v;
};

const TOOLS: Record<string, (root: DirHandle, a: Args) => Promise<ToolRunResult>> = {
  async list_dir(root, a) {
    const parts = splitPath(a.path ?? '.');
    const dir = await getDir(root, parts);
    const lines: string[] = [];
    if (a.recursive === true) {
      for await (const e of walkAll(dir, parts)) {
        if (lines.length >= 500) break;
        lines.push(e.kind === 'directory' ? '[폴더] ' + show(e.parts) + '/' : '[파일] ' + show(e.parts));
      }
      lines.sort((x, y) => x.slice(5).localeCompare(y.slice(5), 'ko'));
      const more = lines.length >= 500 ? '\n…500개까지만 보여 줘요. 하위 폴더를 따로 열어 보세요' : '';
      return ok((lines.length ? lines.join('\n') : '(비어 있음)') + more, show(parts) + ' 전체 — ' + lines.length + '개');
    }
    for await (const [name, h] of dir.entries()) {
      if (lines.length >= 500) break;
      const p = show([...parts, name]);
      if (h.kind === 'directory') lines.push(`[폴더] ${p}/`);
      else lines.push(`[파일] ${p} (${(await (h as FileSystemFileHandle).getFile()).size}바이트)`);
    }
    lines.sort((x, y) => (x.startsWith('[폴더]') === y.startsWith('[폴더]') ? x.localeCompare(y, 'ko') : x.startsWith('[폴더]') ? -1 : 1));
    return ok(lines.length ? lines.join('\n') : '(비어 있음)', `${show(parts)} — ${lines.length}개`);
  },

  async find_files(root, a) {
    const pattern = str(a.pattern, 'pattern');
    if (!pattern.trim()) throw new ToolError('찾을 이름이 비어 있어요');
    const match = nameMatcher(pattern);
    const base = splitPath(a.path ?? '.');
    const hits: string[] = [];
    let scanned = 0;
    for await (const e of walkAll(await getDir(root, base), base)) {
      if (++scanned > 20000 || hits.length >= 200) break;
      if (match(e.parts.at(-1)!)) hits.push((e.kind === 'directory' ? '[폴더] ' : '[파일] ') + show(e.parts));
    }
    return ok(hits.length ? hits.join('\n') : '(찾은 결과 없음)', '"' + pattern + '" — ' + hits.length + '개');
  },

  async read_file(root, a) {
    const parts = splitPath(a.path);
    const lines = (await readTextFile(root, parts)).split(/\r?\n/);
    const start = Math.max(1, optInt(a.start_line) ?? 1);
    const end = Math.min(lines.length, optInt(a.end_line) ?? lines.length);
    const numbered = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
      .join('\n');
    return ok(`(${show(parts)}, 전체 ${lines.length}줄)\n${numbered}`, `${show(parts)} (${lines.length}줄)`);
  },

  async search_files(root, a) {
    const query = str(a.query, 'query').toLowerCase();
    if (!query.trim()) throw new ToolError('찾을 글자가 비어 있어요');
    const base = splitPath(a.path ?? '.');
    const hits: string[] = [];
    let scanned = 0;
    for await (const f of walk(await getDir(root, base), base)) {
      if (++scanned > 3000 || hits.length >= 80) break;
      const file = await f.handle.getFile();
      if (file.size > MAX_READ_BYTES) continue;
      const head = new Uint8Array(await file.slice(0, 8000).arrayBuffer());
      if (head.includes(0)) continue;
      const lines = (await file.text()).split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 80; i++) {
        if (lines[i]!.toLowerCase().includes(query)) hits.push(`${show(f.parts)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
      }
    }
    return ok(hits.length ? hits.join('\n') : '(찾은 결과 없음)', `"${a.query}" — ${hits.length}곳`);
  },

  async write_file(root, a) {
    const parts = splitPath(a.path);
    const content = str(a.content, 'content');
    const existed = await fileExists(root, parts);
    await writeTextFile(root, parts, content);
    const n = content.split('\n').length;
    return ok(`${existed ? '덮어썼습니다' : '만들었습니다'}: ${show(parts)} (${n}줄)`, `${show(parts)} ${existed ? '덮어씀' : '만듦'} (${n}줄)`);
  },

  async edit_file(root, a) {
    const parts = splitPath(a.path);
    const oldText = str(a.old_text, 'old_text');
    const newText = str(a.new_text, 'new_text');
    if (!oldText) throw new ToolError('바꿀 원래 글자(old_text)가 비어 있어요');
    const raw = await readTextFile(root, parts);
    const count = raw.split(oldText).length - 1;
    if (count === 0) throw new ToolError('바꿀 원래 글자를 파일에서 찾지 못했어요. 파일을 다시 읽고 정확히 복사해 주세요');
    const all = a.replace_all === true;
    if (count > 1 && !all) {
      throw new ToolError(`바꿀 원래 글자가 ${count}군데 있어요. 앞뒤 줄을 더 넣어 한 곳만 가리키게 하거나, 모두 바꾸려면 replace_all 을 true 로 해 주세요`);
    }
    await writeTextFile(root, parts, all ? raw.split(oldText).join(newText) : raw.replace(oldText, () => newText));
    const many = all && count > 1 ? ` (${count}곳)` : '';
    return ok(`고쳤습니다: ${show(parts)}${many}`, `${show(parts)} 고침${many}`);
  },

  async make_dir(root, a) {
    const parts = splitPath(a.path);
    if (!parts.length) throw new ToolError('폴더 이름이 필요해요');
    await getDir(root, parts, true);
    return ok(`폴더를 만들었습니다: ${show(parts)}`, `${show(parts)}/ 만듦`);
  },

  async run_command(root, a) {
    const command = str(a.command, 'command').trim();
    if (!command) throw new ToolError('실행할 명령이 비어 있어요');
    const cwd = show(splitPath(a.cwd ?? '.'));
    const conn = await requireRunner(root);
    const timeoutSec = Math.min(600, Math.max(1, optInt(a.timeout_sec) ?? 120));
    let r;
    try {
      r = await runOnRunner(conn, { command, cwd, timeoutSec });
    } catch (err) {
      if (err instanceof RunnerError) throw new ToolError(err.message);
      throw err;
    }
    const os = r.platform === 'win32' ? 'Windows(cmd)' : r.platform === 'darwin' ? 'macOS(sh)' : 'Linux(sh)';
    const code = r.timedOut ? '시간 초과로 끔' : `종료 코드 ${r.exitCode ?? r.signal}`;
    const head = `(${os}, ${code}, ${(r.ms / 1000).toFixed(1)}초, 위치: ${cwd})
$ ${command}
`;
    const out = r.output.trim() ? r.output : '(출력 없음)';
    return {
      status: r.exitCode === 0 && !r.timedOut ? 'ok' : 'error',
      result: head + out,
      summary: `${command.length > 60 ? command.slice(0, 60) + '…' : command} — ${code}`,
    };
  },

  move_path: (root, a) => transfer(root, a, true),
  copy_path: (root, a) => transfer(root, a, false),

  async delete_path(root, a) {
    const parts = splitPath(a.path);
    if (!parts.length) throw new ToolError('작업 폴더 자체는 지울 수 없어요');
    const parent = await getDir(root, parts.slice(0, -1));
    try {
      await parent.removeEntry(parts.at(-1)!, { recursive: true });
    } catch (err) {
      if ((err as Error).name === 'NotFoundError') throw new ToolError(`없는 경로예요: ${show(parts)}`);
      throw err;
    }
    return ok(`지웠습니다: ${show(parts)}`, `${show(parts)} 지움`);
  },
};

const errorResult = (err: unknown): ToolRunResult => {
  const message =
    err instanceof ToolError
      ? err.message
      : (err as Error).name === 'NotAllowedError'
        ? '폴더 권한이 없어요. 폴더를 다시 열어 주세요'
        : `파일 작업 중 문제가 생겼어요 (${(err as Error).message})`;
  return { status: 'error', result: `오류: ${message}`, summary: message };
};

/** AI 의 도구 호출을 이 폴더에서 실행한다. 실패해도 예외 대신 error 결과를 돌려준다 (모델이 고쳐서 다시 시도하게) */
export async function runLocalTool(folder: LocalFolder, name: string, args: Args): Promise<ToolRunResult> {
  const run = TOOLS[name];
  if (!run) return { status: 'error', result: `알 수 없는 도구예요: ${name}`, summary: `알 수 없는 도구 ${name}` };
  try {
    return await run(folder.handle, args);
  } catch (err) {
    return errorResult(err);
  }
}

/** 쓰기 작업을 허용하기 전에 보여줄 미리보기. 만들 수 없으면 오류 결과 */
export async function buildPreview(folder: LocalFolder, name: string, a: Args): Promise<ToolPreview | ToolRunResult> {
  try {
    const parts = name === 'move_path' || name === 'copy_path' || name === 'run_command' ? [] : splitPath(a.path);
    const path = show(parts);
    switch (name) {
      case 'write_file': {
        const content = str(a.content, 'content');
        return { kind: 'write', path, exists: await fileExists(folder.handle, parts), content: content.slice(0, 6000), truncated: content.length > 6000 };
      }
      case 'edit_file':
        return { kind: 'edit', path, oldText: str(a.old_text, 'old_text'), newText: str(a.new_text, 'new_text') };
      case 'make_dir':
        return { kind: 'mkdir', path };
      case 'run_command': {
        const command = str(a.command, 'command').trim();
        if (!command) throw new ToolError('실행할 명령이 비어 있어요');
        const cwd = show(splitPath(a.cwd ?? '.'));
        await requireRunner(folder.handle); // 도우미가 안 켜져 있으면 허용을 묻기 전에 알려 준다
        return { kind: 'run', path: cwd, command, timeoutSec: Math.min(600, Math.max(1, optInt(a.timeout_sec) ?? 120)) };
      }
      case 'move_path':
      case 'copy_path': {
        const from = splitPath(a.from, 'from');
        const to = splitPath(a.to, 'to');
        if (!from.length || !to.length) throw new ToolError('작업 폴더 자체는 옮기거나 복사할 수 없어요');
        const kind = await exists(folder.handle, from);
        if (!kind) throw new ToolError('없는 경로예요: ' + show(from));
        if (await exists(folder.handle, to)) throw new ToolError('이미 있는 경로예요: ' + show(to));
        return { kind: 'move', path: show(from), to: show(to), isDir: kind === 'directory', copy: name === 'copy_path' };
      }
      case 'delete_path': {
        if (!parts.length) throw new ToolError('작업 폴더 자체는 지울 수 없어요');
        const parent = await getDir(folder.handle, parts.slice(0, -1));
        let isDir = false;
        try {
          await parent.getDirectoryHandle(parts.at(-1)!);
          isDir = true;
        } catch {
          await getFile(folder.handle, parts); // 없으면 여기서 "없는 파일" 오류
        }
        return { kind: 'delete', path, isDir };
      }
      default:
        throw new ToolError(`알 수 없는 도구예요: ${name}`);
    }
  } catch (err) {
    return errorResult(err);
  }
}
