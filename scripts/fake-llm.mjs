#!/usr/bin/env node
/**
 * 개발·테스트용 가짜 LLM 서버 (OpenAI 호환 /v1/chat/completions)
 *
 *   node scripts/fake-llm.mjs            → http://127.0.0.1:8099/v1
 *   .env 의 LLM_BASE_URL 을 위 주소로 바꾸면 모델 없이도 화면/스트리밍을 확인할 수 있어요.
 *
 * 마지막 사용자 메시지에 이런 문구를 넣으면 동작이 달라져요:
 *   [slow]  → 아주 긴 답변을 천천히 (중단/대기열 테스트용)
 *   [think] → <think>…</think> 태그가 섞인 content 로 응답 (태그 분리 테스트용)
 *   [fail]  → 500 오류 응답
 *   [system] → 받은 시스템 프롬프트를 그대로 답변으로 (응답 스타일·개인 지침 확인용)
 *   [tool:write|escape|list] → (폴더를 연 대화에서) 도구를 부른다. 도구 결과를 받으면 "도구 결과: …" 로 답한다
 */
import http from 'node:http';

const port = Number(process.env.FAKE_LLM_PORT || 8099);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0];

  if (req.method === 'GET' && url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }

  if (req.method === 'POST' && url === '/v1/chat/completions') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const messages = body.messages ?? [];
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    if (last.includes('[fail]')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'boom' } }));
    }

    // 제목 생성 같은 stream:false 호출
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: '테스트 제목' } }] }),
      );
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let closed = false;
    res.on('close', () => (closed = true));
    const chunk = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);

    const slow = last.includes('[slow]');

    const lastMsg = messages.at(-1);
    if (body.tools && lastMsg?.role === 'tool') {
      // 도구 결과를 받은 두 번째 라운드: 결과를 그대로 알려준다
      chunk({ content: `도구 결과: ${lastMsg.content}` });
    } else if (body.tools && /\[tool:(\w+)\]/.test(last)) {
      // [tool:write] → write_file, [tool:escape] → 작업 폴더 밖 읽기, [tool:list] → list_dir
      const kind = /\[tool:(\w+)\]/.exec(last)[1];
      const plan = {
        write: ['write_file', { path: 'made/hello.txt', content: '가짜 모델이 만든 파일' }],
        escape: ['read_file', { path: '../../outside.txt' }],
        list: ['list_dir', { path: '.' }],
      }[kind] ?? ['list_dir', { path: '.' }];
      chunk({ content: '파일 작업을 할게요.' });
      chunk({
        tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: plan[0], arguments: JSON.stringify(plan[1]) } }],
      });
    } else if (last.includes('[system]')) {
      // 받은 시스템 프롬프트를 그대로 돌려준다 (응답 스타일·개인 지침이 들어갔는지 확인용)
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      chunk({ content: `시스템 프롬프트:\n${system}` });
    } else if (last.includes('[think]')) {
      // 태그가 청크 경계에서 잘려도 분리되는지 확인
      for (const piece of ['<thi', 'nk>비밀 ', '생각</th', 'ink>진짜 ', '답변이에요']) {
        if (closed) return;
        chunk({ content: piece });
        await sleep(20);
      }
    } else {
      for (const t of ['먼저 ', '질문을 ', '살펴볼게요.']) {
        chunk({ reasoning_content: t });
        await sleep(30);
      }
      const base = `안녕하세요! 가짜 모델의 답변이에요.\n\n- 받은 질문: ${last.slice(0, 80)}\n- 이전 메시지 수: ${messages.length}\n\n\`\`\`js\nconsole.log('hello');\n\`\`\`\n\n`;
      const words = (slow ? base + '느리게 계속 이어지는 문장입니다. '.repeat(60) : base).split(/(?<=\s)/);
      for (const w of words) {
        if (closed) return;
        chunk({ content: w });
        await sleep(slow ? 120 : 25);
      }
    }

    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 17 } })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    return void res.end();
  }

  res.writeHead(404).end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-llm] http://127.0.0.1:${port}/v1`);
});
