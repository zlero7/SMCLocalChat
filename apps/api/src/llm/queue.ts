import { config } from '../config.js';

interface Waiter {
  grant: () => void;
  reject: (err: Error) => void;
  onPosition: (position: number) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/**
 * 모델 서버에 동시에 보낼 수 있는 생성 수를 제한하는 메모리 큐.
 * 서버가 한 대인 1차 구성용이다. 서버를 여러 대로 늘리면 Redis 등으로 옮긴다.
 */
export class SlotQueue {
  private active = 0;
  private waiting: Waiter[] = [];

  constructor(
    private concurrency: number,
    private maxWaiting: number,
  ) {}

  get activeCount() {
    return this.active;
  }
  get waitingCount() {
    return this.waiting.length;
  }
  get limit() {
    return this.concurrency;
  }

  /** 빈 슬롯이 없고 대기열도 가득 찼는지 */
  isFull() {
    return this.active >= this.concurrency && this.waiting.length >= this.maxWaiting;
  }

  /** 슬롯을 받으면 release 함수를 돌려준다. 기다리는 중 signal 이 abort 되면 reject. */
  acquire(signal: AbortSignal, onPosition: (position: number) => void): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));

      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.pump();
        });
      };

      if (this.active < this.concurrency && this.waiting.length === 0) {
        grant();
        return;
      }

      const waiter: Waiter = {
        grant,
        reject,
        onPosition,
        signal,
        onAbort: () => {
          const idx = this.waiting.indexOf(waiter);
          if (idx !== -1) this.waiting.splice(idx, 1);
          reject(new Error('aborted'));
          this.notify();
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiting.push(waiter);
      onPosition(this.waiting.length);
    });
  }

  private pump() {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next.signal.removeEventListener('abort', next.onAbort);
      next.grant();
    }
    this.notify();
  }

  private notify() {
    this.waiting.forEach((w, i) => w.onPosition(i + 1));
  }
}

export const slotQueue = new SlotQueue(config.LLM_CONCURRENCY, config.LLM_MAX_QUEUE);
