import { ApiError, authedFetch } from './api';
import type { Attachment } from './types';

/** 한 메시지에 붙일 수 있는 파일 수 (서버와 같게) */
export const MAX_ATTACHMENTS = 5;
/** 파일 하나의 최대 크기 (서버 MAX_UPLOAD_MB 와 같게) */
export const MAX_FILE_MB = 15;
/** 이미지는 긴 변을 이만큼으로 줄여서 올린다 (모델이 보는 데 충분하고, 대화 길이를 아낀다) */
const IMAGE_MAX_SIDE = 1280;

export const ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.txt,.md,.csv,.tsv,.json,.xml,.yaml,.yml,.log,' +
  '.py,.js,.ts,.tsx,.jsx,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.sql,.sh,.css,.html,.kt,.swift';

const isImage = (f: File) => /^image\/(png|jpeg|webp|gif)$/.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);

/** 큰 이미지는 브라우저에서 줄인다 (작은 이미지는 그대로) */
async function shrinkImage(file: File): Promise<File> {
  if (/gif$/i.test(file.type)) return file; // 움직이는 그림은 그대로 (첫 장만 줄이면 다른 그림이 된다)
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // 브라우저가 못 여는 그림은 서버가 판단하게 둔다
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  // 투명한 부분은 흰 배경으로 (JPEG 는 투명을 못 담는다)
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

/** 파일 하나를 올리고 서버가 정한 정보(id, 종류)를 받는다 */
export async function uploadFile(original: File, signal?: AbortSignal): Promise<Attachment> {
  const file = isImage(original) ? await shrinkImage(original) : original;
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new ApiError(`파일이 너무 커요 (최대 ${MAX_FILE_MB}MB)`, 413);
  const res = await authedFetch('/files', {
    method: 'POST',
    // JSON 으로 해석되지 않게 언제나 바이너리로 보낸다 (진짜 형식은 서버가 내용으로 판단)
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
    signal,
  });
  const data = (await res.json().catch(() => null)) as { file?: Attachment; error?: string } | null;
  if (!res.ok || !data?.file) {
    throw new ApiError(res.status === 413 ? `파일이 너무 커요 (최대 ${MAX_FILE_MB}MB)` : (data?.error ?? '파일을 올리지 못했어요'), res.status);
  }
  return data.file;
}

/** 로그인 토큰을 붙여 파일을 받아 브라우저 주소(blob:)로 만든다 (이미지 보기·내려받기용) */
const blobCache = new Map<string, Promise<string>>();
export function fileObjectUrl(id: string): Promise<string> {
  let p = blobCache.get(id);
  if (!p) {
    p = authedFetch(`/files/${id}`).then(async (res) => {
      if (!res.ok) throw new ApiError('파일을 열 수 없어요', res.status);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => blobCache.delete(id));
    blobCache.set(id, p);
  }
  return p;
}

/** 파일 내려받기 */
export async function downloadFile(a: Pick<Attachment, 'id' | 'name'>): Promise<void> {
  const url = await fileObjectUrl(a.id);
  const link = document.createElement('a');
  link.href = url;
  link.download = a.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 입력창에 붙여 둔 파일 (올리는 중 / 다 올림 / 실패) */
export interface PendingFile {
  localId: string;
  name: string;
  size: number;
  image: boolean;
  status: 'uploading' | 'ready' | 'error';
  /** 다 올리면 서버가 준 정보 */
  attachment?: Attachment;
  error?: string;
  /** 이미지 미리보기 (내 컴퓨터 파일로 만든 blob: 주소) */
  preview?: string;
}

export const newPendingFile = (file: File): PendingFile => ({
  localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name: file.name,
  size: file.size,
  image: isImage(file),
  status: 'uploading',
  preview: isImage(file) ? URL.createObjectURL(file) : undefined,
});

export const formatSize =(bytes: number) =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
