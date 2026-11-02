export interface SplitPiece {
  kind: 'reasoning' | 'delta';
  text: string;
}

const OPEN = '<think>';
const CLOSE = '</think>';

/** 문자열 끝이 tag 의 앞부분과 겹치는 길이 (태그가 청크 경계에서 잘렸을 때 대비) */
function partialSuffixLen(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/**
 * 모델이 content 안에 <think>...</think> 로 생각 과정을 섞어 보내는 경우를 분리한다.
 * (llama.cpp 를 --reasoning-format deepseek 로 띄우면 reasoning_content 로 따로 오므로 이 경로는 보험용)
 */
export class ThinkSplitter {
  private buf = '';

  /** startInThink: 생각 블록 안에서 시작 (<think> 를 미리 채워 보냈을 때) */
  constructor(private inThink = false) {}

  /** 서버가 생각을 별도 필드로 보내 준다면 content 는 답변뿐이므로 생각 블록 밖으로 나온다 */
  exitThink() {
    this.inThink = false;
  }

  push(chunk: string): SplitPiece[] {
    this.buf += chunk;
    const out: SplitPiece[] = [];
    for (;;) {
      const tag = this.inThink ? CLOSE : OPEN;
      const idx = this.buf.indexOf(tag);
      if (idx !== -1) {
        const before = this.buf.slice(0, idx);
        if (before) out.push({ kind: this.inThink ? 'reasoning' : 'delta', text: before });
        this.buf = this.buf.slice(idx + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      const keep = partialSuffixLen(this.buf, tag);
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) out.push({ kind: this.inThink ? 'reasoning' : 'delta', text: emit });
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  flush(): SplitPiece[] {
    const rest = this.buf;
    this.buf = '';
    return rest ? [{ kind: this.inThink ? 'reasoning' : 'delta', text: rest }] : [];
  }
}

/** 제목처럼 한 번에 받은 문자열에서 <think> 블록을 제거 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}
