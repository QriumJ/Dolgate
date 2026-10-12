// 동기화 변경 대기 루프 — 데스크톱·모바일 공용.
//
// 서버의 GET /sync/watch(롱폴링)에 붙어 있다가 바뀌었다고 하면 당기고, 다시 붙는다. 플랫폼은
// "어떻게 기다리나(watch)" 와 "어떻게 당기나(onChange)" 만 준다. 서버가 watch 를 모르면 플랫폼의
// watch 가 30초 기다렸다 'changed'(= 지금 당겨라)를 돌려주면 된다 — 루프는 서버 종류를 모른다.
//
// React Native 에서도 돌아야 하므로 AbortSignal.any·AbortSignal.timeout 을 쓰지 않는다.

/** 서버의 변경 대기 시간(20~30초)에 여유를 더한 클라이언트 쪽 상한. 이보다 오래 답이 없으면
 *  연결이 조용히 죽은 것으로 본다(잠자기·네트워크 전환). */
export const SYNC_WATCH_CLIENT_TIMEOUT_MS = 45_000;

/** 서버가 watch 를 모를 때(옛 자체 호스팅) 물러서는 폴링 주기 — 롱폴링 이전과 같다. */
export const SYNC_WATCH_FALLBACK_POLL_MS = 30_000;

/** 실패가 이어질 때 물러서는 시간. 마지막 값은 예전 폴링 주기와 같다. */
export const SYNC_WATCH_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const;

/** 이보다 빨리 끝난 '변경 없음' 은 비정상으로 본다(아래 startSyncWatchLoop 주석). */
const SYNC_WATCH_MIN_HEALTHY_WAIT_MS = 1_000;

export type SyncWatchOutcome = 'changed' | 'unchanged';

/**
 * 한 번 기다린 결과. live 는 서버가 실제로 기다려 주었는가(롱폴링)다 — 아니면(옛 서버) 30초마다
 * 'changed' 가 온다. 데스크톱 렌더러는 이것으로 창 포커스 때 당길지 정한다.
 */
export interface SyncWatchResult {
  outcome: SyncWatchOutcome;
  live: boolean;
}

export interface SyncWatchLoopOptions {
  /** 변경을 기다린다. 끊기거나 실패하면 던진다. 루프가 멈추면 signal 이 abort 된다. */
  watch: (signal: AbortSignal) => Promise<SyncWatchOutcome>;
  /** 바뀌었을 때 당긴다. 당기기에 실패했으면 false 를 돌려준다(또는 던진다). */
  onChange: () => Promise<boolean>;
  /** 테스트용. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface SyncWatchLoop {
  /** 루프를 끝낸다. 진행 중인 대기도 abort 된다. */
  stop(): void;
  /** 실패 뒤 물러나 있는 중이면 바로 다시 시도한다(창 포커스·포그라운드 복귀). 대기 중이면
   *  아무것도 하지 않는다 — 이미 변경을 기다리고 있다. */
  retryNow(): void;
}

/** failures 번째 연속 실패 뒤 물러설 시간. ±20% 흩어 서버 재시작 뒤 기기들이 한꺼번에 몰리지
 *  않게 한다. */
export function syncWatchBackoffMs(
  failures: number,
  random: () => number = Math.random,
): number {
  const index = Math.min(Math.max(failures, 1), SYNC_WATCH_BACKOFF_MS.length) - 1;
  return Math.round(SYNC_WATCH_BACKOFF_MS[index] * (0.8 + random() * 0.4));
}

/**
 * 변경 대기 루프를 시작한다.
 *
 * **실패로 세는 것:** watch 가 던질 때, 당기기가 실패할 때, '변경 없음' 이 1초도 안 돼 돌아올 때.
 * 셋 다 그대로 다시 붙으면 요청이 끝없이 돈다 —
 * - 당기기가 리비전을 못 올리면 다음 watch 가 즉시 또 'changed' 를 돌려준다.
 * - 서버가 내려가는 중이거나 중간 장비가 대기를 바로 끊으면 '변경 없음' 이 즉시 돌아온다.
 * 그래서 이때는 2·5·15·30초로 물러선다. 정상인 대기(바뀌면 그 순간, 아니면 20~30초)는
 * 실패 횟수를 되돌린다.
 */
export function startSyncWatchLoop(options: SyncWatchLoopOptions): SyncWatchLoop {
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  let stopped = false;
  let waiting: AbortController | null = null;
  let backingOff: AbortController | null = null;

  const run = async () => {
    let failures = 0;
    while (!stopped) {
      const controller = new AbortController();
      waiting = controller;
      const startedAt = now();
      let healthy: boolean;
      try {
        const outcome = await options.watch(controller.signal);
        if (stopped) {
          return;
        }
        healthy =
          outcome === 'changed'
            ? await options.onChange()
            : now() - startedAt >= SYNC_WATCH_MIN_HEALTHY_WAIT_MS;
      } catch {
        healthy = false;
      }
      waiting = null;
      if (stopped) {
        return;
      }
      if (healthy) {
        failures = 0;
        continue;
      }
      failures += 1;
      const backoff = new AbortController();
      backingOff = backoff;
      try {
        await sleep(syncWatchBackoffMs(failures, random), backoff.signal);
      } catch {
        // retryNow·stop 이 깨운 것이다.
      }
      backingOff = null;
    }
  };
  void run();

  return {
    stop() {
      stopped = true;
      waiting?.abort();
      backingOff?.abort();
    },
    retryNow() {
      backingOff?.abort();
    },
  };
}

/** signal 이 abort 되면 바로 거절되는 sleep. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
