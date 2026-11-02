import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Conversations, Gate, RateLimiter, defang, splitMessage } from '../src/discord/core.js';

describe('메시지 나누기', () => {
  it('짧으면 그대로', () => assert.deepEqual(splitMessage('안녕하세요'), ['안녕하세요']));

  it('긴 글은 한도 이하로 나누고 내용이 빠지지 않는다', () => {
    const text = Array.from({ length: 300 }, (_, i) => `문장 ${i} 입니다.`).join('\n');
    const parts = splitMessage(text, 500);
    assert.ok(parts.length > 1);
    for (const p of parts) assert.ok(p.length <= 500, `${p.length}자`);
    assert.equal(parts.join('\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  });

  it('줄바꿈이 없는 아주 긴 글도 나눈다', () => {
    const parts = splitMessage('가'.repeat(5000), 1900);
    assert.ok(parts.every((p) => p.length <= 1900));
    assert.equal(parts.join('').length, 5000);
  });

  it('코드 블록이 조각 사이에서 끊기면 닫고 다시 연다', () => {
    const code = Array.from({ length: 200 }, (_, i) => `print(${i})`).join('\n');
    const parts = splitMessage('설명입니다.\n```python\n' + code + '\n```\n끝.', 600);
    assert.ok(parts.length > 1);
    for (const p of parts) {
      assert.equal((p.match(/```/g) ?? []).length % 2, 0, `열린 코드 블록이 남음:\n${p.slice(-80)}`);
      assert.ok(p.length <= 600);
    }
    assert.ok(parts[1]!.startsWith('```python'), '다음 조각이 같은 언어로 다시 열려야 함');
  });
});

describe('사용자별 횟수 제한', () => {
  it('시간당·하루 한도를 지키고 시간이 지나면 풀린다', () => {
    let now = 1_000_000;
    const rl = new RateLimiter(3, 5, () => now);
    for (let i = 0; i < 3; i++) assert.equal(rl.take('u1'), null);
    const blocked = rl.take('u1');
    assert.equal(blocked?.reason, 'hour');
    assert.ok(blocked!.retryAfterSec > 3500);
    assert.equal(rl.take('u2'), null, '다른 사람은 영향 없음');
    now += 3600_000 + 1;
    assert.equal(rl.take('u1'), null); // 하루 4번째
    now += 3600_000 + 1;
    assert.equal(rl.take('u1'), null); // 하루 5번째 (마지막)
    now += 3600_000 + 1;
    assert.equal(rl.take('u1')?.reason, 'day', '하루 5번을 다 썼으면 시간당 한도가 풀려도 막힌다');
  });

  it('돌려받으면 한 번이 되살아난다', () => {
    const rl = new RateLimiter(1, 10);
    assert.equal(rl.take('u'), null);
    rl.refund('u');
    assert.equal(rl.take('u'), null);
  });
});

describe('동시 처리 줄 세우기', () => {
  it('동시 한도를 넘으면 기다리고, 대기열이 차면 거절한다', async () => {
    const gate = new Gate(2, 1);
    const r1 = await gate.enter();
    const r2 = await gate.enter();
    assert.ok(r1 && r2);
    let third = false;
    const p3 = gate.enter().then((r) => ((third = true), r));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(third, false, '자리가 없으면 기다려야 함');
    assert.equal(gate.queued, 1);
    assert.equal(await gate.enter(), null, '대기열이 꽉 찼으면 null');
    r1!();
    const r3 = await p3;
    assert.ok(r3);
    r1!(); // 두 번 불러도 자리가 두 번 반납되면 안 됨
    r2!();
    r3!();
    const again = await Promise.all([gate.enter(), gate.enter()]);
    assert.ok(again[0] && again[1]);
    assert.equal(gate.queued, 0);
  });
});

describe('대화 기억', () => {
  it('이어서 기억하고, 오래되면 잊고, 지울 수 있다', () => {
    let now = 0;
    const c = new Conversations(10, 6000, 1000, () => now);
    c.add('k', '질문1', '답1');
    c.add('k', '질문2', '답2');
    assert.deepEqual(c.get('k').map((t) => t.content), ['질문1', '답1', '질문2', '답2']);
    now = 1001;
    assert.deepEqual(c.get('k'), []);
    c.add('k', 'a', 'b');
    c.reset('k');
    assert.deepEqual(c.get('k'), []);
  });

  it('개수와 글자 수가 넘으면 오래된 것부터 버린다', () => {
    const c = new Conversations(4, 100);
    for (let i = 0; i < 5; i++) c.add('k', `질문${i}`, `답${i}`);
    assert.equal(c.get('k').length, 4);
    assert.equal(c.get('k')[0]!.content, '질문3');
    const d = new Conversations(100, 50);
    d.add('k', 'x'.repeat(40), 'y'.repeat(40));
    d.add('k', 'z'.repeat(40), 'w'.repeat(40));
    assert.ok(d.get('k').length <= 2);
  });
});

describe('멘션 무력화', () => {
  it('전체 알림과 사용자 호출을 막는다', () => {
    assert.ok(!defang('@everyone 안녕 @here').match(/@(everyone|here)/));
    assert.ok(!defang('<@123456> <@&99> <@!5>').match(/<@[!&]?\d/));
  });
});

