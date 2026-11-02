// 디스코드 봇의 파일 처리: 첨부 내려받기·읽기, 길이 맞추기, 모델이 올리는 파일
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_ASK_WITH_FILES,
  MAX_ATTACHMENTS,
  buildUserTurn,
  downloadFile,
  fitHistory,
  handleSendFile,
  isDiscordCdn,
  prepareAttachments,
  safeFileName,
  type OutFile,
} from '../src/discord/attach.js';
import { wantsContent } from '../src/discord/manager.js';

// 1x1 짜리 진짜 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server: http.Server;
let base = '';
before(async () => {
  server = http.createServer((req, res) => {
    const files: Record<string, [string, Buffer | string]> = {
      '/note.txt': ['text/plain', '회의록\n오늘 결정: 출시일은 11월 3일로 한다.\n담당은 민수.'],
      '/pic.png': ['image/png', PNG],
      '/fake.png': ['image/png', Buffer.from('이건 사실 글이에요')],
      '/old.hwp': ['application/octet-stream', Buffer.from('hwp')],
      '/big.txt': ['text/plain', 'x'.repeat(200_000)],
    };
    const f = files[req.url ?? ''];
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/' });
      return void res.end();
    }
    if (!f) {
      res.writeHead(404);
      return void res.end();
    }
    res.writeHead(200, { 'Content-Type': f[0] });
    res.end(f[1]);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const insecure = { allowInsecure: true };
const file = (name: string, path: string, size = 100) => ({ name, url: base + path, size });

describe('첨부 주소 검사', () => {
  it('디스코드 첨부 서버만 허용한다', () => {
    assert.equal(isDiscordCdn('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1'), true);
    assert.equal(isDiscordCdn('https://media.discordapp.net/attachments/1/2/a.png'), true);
    for (const bad of ['http://cdn.discordapp.com/a.png', 'https://evil.example/a.png', 'https://cdn.discordapp.com.evil.example/a.png', 'http://127.0.0.1/a', 'file:///etc/passwd', '그냥 글']) {
      assert.equal(isDiscordCdn(bad), false, bad);
    }
  });

  it('허용되지 않은 주소는 내려받기 전에 거절한다', async () => {
    await assert.rejects(downloadFile('http://127.0.0.1:1/x', 1000), /첨부 주소가 아니에요/);
  });
});

describe('첨부 내려받기·읽기', () => {
  it('크기 제한을 넘으면 읽다가 멈춘다, 리다이렉트는 따라가지 않는다', async () => {
    await assert.rejects(downloadFile(base + '/big.txt', 1000, insecure), /너무 커요/);
    await assert.rejects(downloadFile(base + '/redirect', 1000, insecure));
    assert.equal((await downloadFile(base + '/note.txt', 10_000, insecure)).length > 10, true);
  });

  it('텍스트는 글로, 이미지는 data 주소로 바꾼다', async () => {
    const p = await prepareAttachments([file('note.txt', '/note.txt'), file('pic.png', '/pic.png')], insecure);
    assert.equal(p.docs.length, 1);
    assert.match(p.docs[0]!.text, /출시일은 11월 3일/);
    assert.equal(p.images.length, 1);
    assert.match(p.images[0]!, /^data:image\/png;base64,/);
    assert.deepEqual(p.names, ['note.txt', 'pic.png']);
    assert.deepEqual(p.notes, []);
  });

  it('읽을 수 없는 파일은 이유를 알려 주고 나머지는 계속 읽는다', async () => {
    const p = await prepareAttachments([file('old.hwp', '/old.hwp'), file('fake.png', '/fake.png'), file('missing.txt', '/nope.txt'), file('note.txt', '/note.txt')], insecure);
    assert.equal(p.docs.length, 1, '읽을 수 있는 건 읽는다');
    assert.equal(p.notes.length, 3);
    const huge = await prepareAttachments([file('huge.txt', '/big.txt', 999_999_999)], insecure);
    p.notes.push(...huge.notes);
    assert.match(p.notes.join('\n'), /한글\(HWP\)/);
    assert.match(p.notes.join('\n'), /이미지 파일이 아니거나/);
    assert.match(p.notes.join('\n'), /내려받지 못했어요 \(404\)/);
    assert.match(p.notes.join('\n'), /너무 커서/);
  });

  it(`첨부는 ${MAX_ATTACHMENTS}개까지만 읽는다`, async () => {
    const p = await prepareAttachments(Array.from({ length: 6 }, (_, i) => file(`n${i}.txt`, '/note.txt')), insecure);
    assert.equal(p.docs.length, MAX_ATTACHMENTS);
    assert.match(p.notes[0]!, /앞의 4개만/);
  });
});

describe('모델에게 보낼 글 만들기 · 길이 맞추기', () => {
  const prep = (text: string) => ({ images: [], docs: [{ name: 'a.txt', text }], notes: [], names: ['a.txt'] });

  it('짧은 문서는 통째로, 이미지는 그림 조각으로 붙는다', () => {
    const t = buildUserTurn('요약해 줘', { ...prep('내용입니다'), images: ['data:image/png;base64,AAAA'] }, 5000);
    assert.ok(Array.isArray(t.content));
    const parts = t.content as { type: string; text?: string }[];
    assert.match(parts[0]!.text!, /첨부 문서: a\.txt[\s\S]*내용입니다/);
    assert.equal(parts[1]!.type, 'image_url');
    assert.equal(t.remember, '요약해 줘\n[첨부: a.txt]', '대화 기억에는 이름만 남긴다');
  });

  it('긴 문서는 질문과 관련된 부분만, 예산 안에서 넣는다', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `관련 없는 이야기 ${i} `.repeat(6)).join('\n\n');
    const long = `${filler}\n\n환불 규정: 구매 후 7일 안에 환불할 수 있습니다.\n\n${filler}`;
    const t = buildUserTurn('환불 규정이 뭐야', prep(long), 1500);
    assert.equal(typeof t.content, 'string');
    assert.match(t.content as string, /7일 안에 환불/);
    assert.match(t.content as string, /질문과 관련된 부분만/);
    assert.ok(t.tokens < 2500, `토큰이 너무 많음: ${t.tokens}`);
  });

  it('읽지 못한 파일 안내가 모델에게도 전해진다', () => {
    const t = buildUserTurn('봐 줘', { images: [], docs: [], notes: ['a.hwp: 한글 파일은 못 읽어요'], names: ['a.hwp'] }, 1000);
    assert.match(t.content as string, /\[첨부 안내: a\.hwp/);
  });

  it('지난 대화는 오래된 것부터 버려서 예산에 맞춘다', () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `메시지${i} ` + '가'.repeat(300) }));
    const fit = fitHistory(turns, 700);
    assert.ok(fit.length < turns.length);
    assert.equal(fit.at(-1)!.content.startsWith('메시지5'), true, '가장 최근 것이 남는다');
    assert.deepEqual(fitHistory(turns, 100_000), turns);
    assert.deepEqual(fitHistory(turns, 0), []);
  });

  it('파일만 올리고 질문이 없을 때의 기본 질문이 있다', () => assert.match(DEFAULT_ASK_WITH_FILES, /첨부/));
});

describe('모델이 올리는 파일(send_file)', () => {
  it('파일 이름을 안전하게 고친다', () => {
    assert.equal(safeFileName('report.md'), 'report.md');
    assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd.txt', '경로 문자는 모두 바뀐다');
    assert.ok(!/[\\/]/.test(safeFileName('a/b\\c.txt')));
    assert.equal(safeFileName(''), 'file.txt');
    assert.equal(safeFileName(undefined), 'file.txt');
    assert.equal(safeFileName('메모'), '메모.txt', '확장자가 없으면 .txt');
    assert.equal(safeFileName('virus.exe'), 'virus.txt', '실행 파일 종류는 글 파일로 바꾼다');
    assert.equal(safeFileName('run.BAT'), 'run.txt');
    assert.equal(safeFileName('.hidden'), 'hidden.txt');
    assert.ok(safeFileName('가'.repeat(300) + '.md').length <= 80);
    assert.ok(safeFileName('가'.repeat(300) + '.md').endsWith('.md'));
  });

  it('정상 호출은 파일을 모으고, 같은 이름은 번호를 붙인다', () => {
    const out: OutFile[] = [];
    assert.match(handleSendFile(JSON.stringify({ filename: 'a.py', content: 'print("안녕")' }), out), /"a\.py".*올렸어요/);
    handleSendFile(JSON.stringify({ filename: 'a.py', content: 'x' }), out);
    assert.deepEqual(out.map((f) => f.name), ['a.py', 'a (2).py']);
    assert.equal(out[0]!.data.toString('utf8'), 'print("안녕")');
  });

  it('잘못된 호출은 오류 글을 돌려주고 파일을 만들지 않는다', () => {
    const out: OutFile[] = [];
    assert.match(handleSendFile('{깨진', out), /JSON/);
    assert.match(handleSendFile(JSON.stringify({ filename: 'a.txt' }), out), /비어 있어요/);
    assert.match(handleSendFile(JSON.stringify({ filename: 'a.txt', content: 'x'.repeat(1_100_000) }), out), /너무 커요/);
    assert.equal(out.length, 0);
  });

  it('한 답변에 4개까지만', () => {
    const out: OutFile[] = [];
    for (let i = 0; i < 4; i++) handleSendFile(JSON.stringify({ filename: `f${i}.txt`, content: 'x' }), out);
    assert.match(handleSendFile(JSON.stringify({ filename: 'f5.txt', content: 'x' }), out), /4개까지만/);
    assert.equal(out.length, 4);
  });
});

describe('채널 대화 모드', () => {
  it('지정한 채널이 있고 설정이 켜져 있을 때만 메시지 내용 권한을 쓴다', () => {
    assert.equal(wantsContent({ channel_chat: true, allowed_channels: '123456789012345678' }), true);
    assert.equal(wantsContent({ channel_chat: true, allowed_channels: '' }), false, '채널을 안 정했으면 필요 없다');
    assert.equal(wantsContent({ channel_chat: false, allowed_channels: '123456789012345678' }), false);
  });
});
