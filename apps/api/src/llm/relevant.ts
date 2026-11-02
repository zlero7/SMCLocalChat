/**
 * 긴 문서에서 질문과 관련된 부분만 골라 정해진 글자 수 안에 담는다.
 * (임베딩 모델 없이: 질문의 두 글자 묶음·영어 단어가 많이 겹치는 문단을 고른다)
 */

const CHUNK_CHARS = 700;

/** 문단 단위로 자르되, 너무 짧은 문단은 붙이고 너무 긴 문단은 나눈다 */
export function splitChunks(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (p.length > CHUNK_CHARS * 1.5) {
      if (cur) chunks.push(cur);
      cur = '';
      for (let i = 0; i < p.length; i += CHUNK_CHARS) chunks.push(p.slice(i, i + CHUNK_CHARS));
      continue;
    }
    if (cur && cur.length + p.length > CHUNK_CHARS) {
      chunks.push(cur);
      cur = p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 질문에서 찾을 조각: 한글은 두 글자 묶음, 영어·숫자는 단어 */
function terms(query: string): Set<string> {
  const out = new Set<string>();
  const lower = query.toLowerCase();
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) out.add(word);
  for (const run of lower.match(/[가-힣]+/g) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function score(chunk: string, t: Set<string>): number {
  const lower = chunk.toLowerCase();
  let s = 0;
  for (const term of t) if (lower.includes(term)) s++;
  return s;
}

/**
 * 여러 문서에서 질문과 관련된 문단을 골라 maxChars 안에 담는다 (프로젝트 자료용).
 * 다 들어가면 전부, 아니면 관련 높은 문단부터. 문서마다 원래 순서를 지키고 문서 이름을 붙인다.
 */
export function selectFromDocs(
  docs: { name: string; text: string }[],
  query: string,
  maxChars: number,
): { text: string; trimmed: boolean } {
  const total = docs.reduce((s, d) => s + d.text.length + d.name.length + 20, 0);
  if (total <= maxChars) {
    return { text: docs.map((d) => `### 자료: ${d.name}\n${d.text}`).join('\n\n'), trimmed: false };
  }
  const t = terms(query);
  const all = docs.flatMap((d, di) => splitChunks(d.text).map((c, ci) => ({ di, ci, c, s: score(c, t) + (ci === 0 ? 0.3 : 0) })));
  all.sort((a, b) => b.s - a.s || a.di - b.di || a.ci - b.ci);
  const picked: typeof all = [];
  let used = 0;
  for (const chunk of all) {
    const cost = chunk.c.length + 10;
    if (used + cost > maxChars) continue;
    picked.push(chunk);
    used += cost;
  }
  picked.sort((a, b) => a.di - b.di || a.ci - b.ci);
  const parts: string[] = [];
  let lastDoc = -1;
  let lastChunk = -1;
  for (const p of picked) {
    if (p.di !== lastDoc) {
      parts.push(`### 자료: ${docs[p.di]!.name} (관련 부분)`);
      lastChunk = -1;
    }
    if (lastChunk !== -1 && p.ci !== lastChunk + 1) parts.push('…');
    parts.push(p.c);
    lastDoc = p.di;
    lastChunk = p.ci;
  }
  return { text: parts.join('\n\n'), trimmed: true };
}

/**
 * text 가 maxChars 보다 길면 query 와 관련된 문단만 골라 원래 순서대로 이어 붙인다.
 * 관련 문단이 없으면 앞부분을 쓴다. 고른 결과와, 줄였는지를 돌려준다.
 */
export function selectRelevant(text: string, query: string, maxChars: number): { text: string; trimmed: boolean } {
  if (text.length <= maxChars) return { text, trimmed: false };
  const chunks = splitChunks(text);
  const t = terms(query);
  const ranked = chunks
    .map((c, i) => ({ i, c, s: score(c, t) + (i === 0 ? 0.5 : 0) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  if (ranked.every((r) => r.s < 1)) return { text: text.slice(0, maxChars), trimmed: true };
  const picked: { i: number; c: string }[] = [];
  let used = 0;
  for (const r of ranked) {
    if (used + r.c.length > maxChars) continue;
    picked.push(r);
    used += r.c.length + 5;
  }
  picked.sort((a, b) => a.i - b.i);
  const parts: string[] = [];
  let prev = -1;
  for (const p of picked) {
    if (prev !== -1 && p.i !== prev + 1) parts.push('…');
    else if (prev === -1 && p.i > 0) parts.push('…');
    parts.push(p.c);
    prev = p.i;
  }
  if (prev < chunks.length - 1) parts.push('…');
  return { text: parts.join('\n\n'), trimmed: true };
}
