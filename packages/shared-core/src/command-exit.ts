// 셸 통합(OSC 133;D)이 알려 준 종료 코드를 화면·자동완성·알림이 같은 기준으로 읽게 한다.
// 판정이 자리마다 따로 있으면 같은 명령이 블록에서는 실패, 탭 점에서는 성공으로 갈린다.

/** 명령이 어떻게 끝났나. */
export type CommandExitKind = 'ok' | 'interrupted' | 'failed';

/**
 * 0 이 아니어도 실패로 치지 않는 종료 코드.
 *
 * - 130 = 128 + SIGINT: 사용자가 Ctrl+C 로 끊었다(`tail -f`, `top`, 개발 서버…). 일부러 한 일이다.
 * - 141 = 128 + SIGPIPE: 읽는 쪽이 먼저 닫았다(pager 에서 q, `| head`). 출력이 잘렸을 뿐이다.
 * - -1073741510 = Windows STATUS_CONTROL_C_EXIT: Windows 콘솔에서 누른 Ctrl+C.
 *
 * bash·zsh 도 SIGINT·SIGPIPE 로 끝난 잡에는 메시지를 찍지 않고, Warp 도 같은 세 값을 실패로
 * 그리지 않는다. 그 밖의 시그널(137 KILL, 143 TERM 등)은 무언가가 죽인 것이라 실패로 둔다.
 */
const INTERRUPTED_EXIT_CODES: ReadonlySet<number> = new Set([130, 141, -1073741510]);

/** Ctrl+C 로 끝났다는 종료 코드. */
const CTRL_C_EXIT_CODES: ReadonlySet<number> = new Set([130, -1073741510]);

/**
 * 종료 코드를 분류한다. 코드가 없으면(통합이 코드를 주지 않음) 실패로 보지 않는다 — 모르는 것을
 * 빨갛게 칠하면 멀쩡한 명령이 실패로 보인다.
 */
export function classifyCommandExit(exitCode: number | null): CommandExitKind {
  if (exitCode === null || exitCode === 0) {
    return 'ok';
  }
  return INTERRUPTED_EXIT_CODES.has(exitCode) ? 'interrupted' : 'failed';
}

/**
 * 종료 코드를 목록용으로 짧게 적는다. Ctrl+C 는 `^C` — 터미널이 화면에 찍는 바로 그 표기라
 * 번역할 필요가 없고, 숫자 130 보다 무슨 일이었는지 바로 읽힌다. 나머지는 숫자 그대로.
 */
export function formatCommandExitCode(exitCode: number): string {
  return CTRL_C_EXIT_CODES.has(exitCode) ? '^C' : String(exitCode);
}

/** 종료 코드를 라벨로 적는다(`exit 1`, `exit 141`, `^C`). 블록 툴바·헤더·툴팁용. */
export function formatCommandExitLabel(exitCode: number): string {
  return CTRL_C_EXIT_CODES.has(exitCode) ? '^C' : `exit ${exitCode}`;
}
