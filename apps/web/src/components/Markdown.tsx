import { Children, isValidElement, memo, type ReactNode } from 'react';
import 'katex/dist/katex.min.css';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CopyButton } from './CopyButton';

/** ```latex / ```math 코드 블록 안에 수식만 있으면(문서 전체가 아니면) 수식으로 보여준다 */
const MATH_FENCE = /^```[ \t]*(?:latex|tex|math|katex)[ \t]*\n([\s\S]*?)\n?[ \t]*```$/i;
const LATEX_DOCUMENT = /\\(?:documentclass|begin\{document\}|usepackage)/;

/**
 * 모델은 수식을 \( … \), \[ … \] 로도 쓰는데 remark-math 는 $ 만 알아듣는다.
 * 코드 블록·인라인 코드 바깥에서만 $ 형식으로 바꾼다.
 */
function normalizeMath(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) {
        const fence = MATH_FENCE.exec(part);
        return fence && !LATEX_DOCUMENT.test(fence[1]!) ? `$$\n${fence[1]!.trim()}\n$$` : part;
      }
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
    })
    .join('');
}

/** React 노드 트리에서 글자만 뽑는다 (코드 블록 복사용) */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : '';
  const lang = /language-([\w+#-]+)/.exec(className)?.[1];
  const text = extractText(children).replace(/\n$/, '');

  return (
    <div className="my-4 overflow-hidden rounded-xl bg-[#0d1117] ring-1 ring-sand-800">
      <div className="flex items-center justify-between bg-sand-800/70 px-4 py-1.5 text-xs text-sand-400">
        <span>{lang ?? '코드'}</span>
        <CopyButton text={text} label="코드 복사" className="text-sand-400 hover:bg-sand-700 hover:text-sand-100" />
      </div>
      <pre className="overflow-x-auto p-4">{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

// remarkCjkFriendly: **음수(-)**로 처럼 기호 바로 뒤에 한글 조사가 붙어도 굵게 표시되게 한다
// (표준 마크다운 규칙은 이 경우를 굵은 글씨로 인정하지 않는다)
// singleTilde: false: "12~13도"처럼 범위를 뜻하는 물결표가 취소선이 되지 않게 한다 (취소선은 ~~두 개~~ 만)
const remarkPlugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }], remarkCjkFriendly, remarkMath];
// 언어를 적은 코드 블록만 색을 입힌다 (자동 감지는 스트리밍 중에 느리고 틀리기 쉬움)
// 수식은 문법이 틀려도(스트리밍 중 반쯤 온 수식 등) 오류 대신 원문을 빨간색으로 보여준다
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
  [rehypeKatex, { throwOnError: false, strict: false }],
];

/** HTML 은 렌더링하지 않는다(XSS 방지). 마크다운만 표시한다. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});
