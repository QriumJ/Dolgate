import { Terminal } from '@xterm/xterm';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginCommandBlock,
  clearCommandBlocks,
  createConptyBlockRealigner,
  finishCommandBlock,
  getCommandBlockAtLine,
  getCommandBlockRange,
  getCommandBlocks,
  getCommandBlocksVersion,
  jumpToAdjacentCommandBlock,
  noteContinuationPrompt,
  noteInsertedCommand,
  notePromptCommandStart,
  noteReportedCommand,
  noteScreenErased,
  readBlockOutput,
  realignCommandBlocks,
  unescapeReportedCommand,
  subscribeToCommandBlocks,
} from './terminal-command-blocks';

interface FakeMarker {
  id: number;
  line: number;
  onDispose(callback: () => void): void;
  dispose(): void;
}

interface FakeDecoration {
  element: HTMLElement | undefined;
  disposed: boolean;
  /** 액센트 바가 덮는 행 수(블록 범위 검증용). */
  height: number;
  onRender(callback: (element: HTMLElement) => void): void;
  dispose(): void;
}

/**
 * xterm 의 marker/decoration/buffer 중 이 모듈이 실제로 쓰는 표면만 흉내 내는 테스트용 터미널.
 * 스크롤백 절삭(마커 dispose)과 대체화면 전환을 직접 유발할 수 있게 만든다.
 */
function createFakeTerminal(rows: string[] = [], wrappedLines: number[] = []) {
  let markerId = 0;
  const markers: FakeMarker[] = [];
  const decorations: FakeDecoration[] = [];
  const buffer = {
    type: 'normal' as 'normal' | 'alternate',
    baseY: 0,
    cursorX: 0,
    cursorY: 0,
    viewportY: 0,
    getLine(line: number) {
      const text = rows[line];
      if (text === undefined) {
        return undefined;
      }
      // xterm 의 셀 모델을 최소한만 흉내 낸다. NUL 은 "쓰인 적 없는 칸"(넓은 글자가 행 끝에
      // 못 들어갔을 때 xterm 이 채우는 것)으로, xterm 처럼 공백으로 렌더되지만 코드가 0 이라
      // 사용자가 친 공백과 구분된다.
      return {
        translateToString: (trimRight: boolean, from = 0, to = text.length) => {
          const slice = text.slice(from, to).replace(/\u0000/g, ' ');
          return trimRight ? slice.replace(/\s+$/, '') : slice;
        },
        isWrapped: wrappedLines.includes(line),
        length: text.length,
        getCell: (x: number) => ({ getCode: () => text.charCodeAt(x) || 0 }),
      };
    },
  };
  const scrolledTo: number[] = [];
  const writeParsedListeners: (() => void)[] = [];

  const terminal = {
    rows: 24,
    buffer: { get active() { return buffer; } },
    onWriteParsed(listener: () => void) {
      writeParsedListeners.push(listener);
      return {
        dispose() {
          writeParsedListeners.splice(writeParsedListeners.indexOf(listener), 1);
        },
      };
    },
    registerMarker(offset = 0) {
      markerId += 1;
      const disposeCallbacks: (() => void)[] = [];
      const marker: FakeMarker = {
        id: markerId,
        line: buffer.baseY + buffer.cursorY + offset,
        onDispose(callback) {
          disposeCallbacks.push(callback);
        },
        dispose() {
          if (marker.line === -1) {
            return;
          }
          marker.line = -1;
          for (const callback of disposeCallbacks) {
            callback();
          }
        },
      };
      markers.push(marker);
      return marker;
    },
    registerDecoration(options: { height?: number }) {
      const element = document.createElement('div');
      const decoration: FakeDecoration = {
        element,
        disposed: false,
        height: options.height ?? 1,
        // 실제 xterm 은 뷰포트에 들어올 때 렌더하지만, 테스트에서는 즉시 렌더된 것으로 본다.
        onRender(callback) {
          callback(element);
        },
        dispose() {
          decoration.disposed = true;
        },
      };
      decorations.push(decoration);
      return decoration;
    },
    scrollToLine(line: number) {
      scrolledTo.push(line);
    },
  };

  return {
    terminal: terminal as unknown as Terminal,
    buffer,
    markers,
    decorations,
    scrolledTo,
    /** xterm 이 쓰기 데이터를 다 파싱했다고 알린다. */
    fireWriteParsed() {
      for (const listener of [...writeParsedListeners]) {
        listener();
      }
    },
  };
}

const SESSION = 'session-blocks-test';

afterEach(() => {
  clearCommandBlocks(SESSION);
});

describe('terminal-command-blocks', () => {
  it('B→C→D 로 명령 블록을 만들고 프롬프트 뒤 명령 텍스트를 읽는다', () => {
    const fake = createFakeTerminal(['user@host:~$ ls -la']);
    fake.buffer.cursorY = 0;
    fake.buffer.cursorX = 13;
    notePromptCommandStart(SESSION, fake.terminal);

    // 명령 실행 시작 시점에는 커서가 다음 줄로 내려가 있다.
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, '/home/user');

    const running = getCommandBlocks(SESSION);
    expect(running).toHaveLength(1);
    expect(running[0].state).toBe('running');
    expect(running[0].command).toBe('ls -la');
    expect(running[0].cwd).toBe('/home/user');

    finishCommandBlock(SESSION, fake.terminal, 0);
    const finished = getCommandBlocks(SESSION);
    expect(finished[0].state).toBe('ok');
    expect(finished[0].exitCode).toBe(0);
    expect(finished[0].durationMs).not.toBeNull();
  });

  // 서브셸(`docker exec`·`bash`)에 들어가면 바깥 셸의 D 는 그 셸을 빠져나올 때까지 오지 않는다.
  // 그동안 안쪽 셸이 자기 블록을 만들면 바깥 블록 안에 안쪽 블록이 들어앉아 화면이 중첩된 것처럼
  // 보였다 — 셸은 앞 명령이 끝나기 전에 다음 명령을 시작하지 못하므로, 새 C 가 오면 앞 블록은
  // 끝난 것으로 본다.
  it('실행 중 블록이 남아 있는데 새 명령이 시작되면 앞 블록을 닫는다', () => {
    const fake = createFakeTerminal(['$ docker exec -it web bash', '', '$ ls'], [0, 2]);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    expect(getCommandBlocks(SESSION)[0].state).toBe('running');

    // 안쪽 셸에 통합이 붙어 자기 명령을 시작한다. 바깥 D 는 아직 오지 않았다.
    fake.buffer.cursorY = 2;
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 3;
    beginCommandBlock(SESSION, fake.terminal, null);

    const blocks = getCommandBlocks(SESSION);
    expect(blocks).toHaveLength(2);
    // 앞 블록은 닫혔고, 종료 코드는 모르므로 싣지 않는다.
    expect(blocks[0].state).toBe('ok');
    expect(blocks[0].exitCode).toBeNull();
    expect(blocks[1].state).toBe('running');
  });

  // 아래 셋은 "화면에서 읽은 명령"이 실제 입력과 어긋나는 경우들이다. 그대로 재실행하면
  // 사용자가 친 적 없는 명령이 실행되므로 commandUnreliable 로 표시해 막아야 한다.
  it('행 예산을 넘겨 잘리면 재실행 불가로 표시한다', () => {
    const rows = ['$ long-command'];
    for (let index = 1; index < 30; index += 1) {
      rows.push(`part-${index}`);
    }
    const fake = createFakeTerminal(rows, [...Array(29).keys()].map((n) => n + 1));
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    // 명령이 25 행에 걸쳐 있다 → MAX_COMMAND_ROWS(20) 를 넘는다.
    fake.buffer.cursorY = 25;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toContain('long-command');
    expect(block.commandUnreliable).toBe(true);
  });

  it('접힘이 아닌 새 줄(여러 줄 입력)은 줄바꿈으로 잇고 재실행 불가로 표시한다', () => {
    // 이어 붙이면 "cat <<EOFline1EOF" 라는, 사용자가 친 적 없는 한 줄이 된다.
    const fake = createFakeTerminal(['$ cat <<EOF', 'line1', 'EOF']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 3;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('cat <<EOF\nline1\nEOF');
    expect(block.commandUnreliable).toBe(true);
  });

  it('앱이 넣은 원문과 화면이 같으면 여러 줄도 재실행할 수 있다', () => {
    // 우리가 괄호 붙여넣기로 넣으면 bash 는 PS2 를 찍지 않는다(readline 버퍼 안의 개행).
    // 화면에는 오염 없는 값이 그대로 있는데도 "증명할 수 없다" 로 막혀 있었다 — 방금 우리가
    // 넣은 그 문자열이면 대조가 증명이 된다.
    const fake = createFakeTerminal(['$ cat \\', 'test.txt']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    noteInsertedCommand(SESSION, 'cat \\\ntest.txt');
    fake.buffer.cursorY = 2;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('cat \\\ntest.txt');
    expect(block.commandUnreliable).toBe(false);
  });

  it('넣은 뒤 줄을 고쳤으면 대조가 어긋나 그대로 막힌다', () => {
    // 추측으로 재실행을 열어 주지 않는다.
    const fake = createFakeTerminal(['$ cat \\', 'other.txt']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    noteInsertedCommand(SESSION, 'cat \\\ntest.txt');
    fake.buffer.cursorY = 2;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('cat \\\nother.txt');
    expect(block.commandUnreliable).toBe(true);
  });

  it('넣은 원문은 한 블록에만 쓰인다 — 다음 명령에 붙지 않는다', () => {
    const first = createFakeTerminal(['$ cat \\', 'test.txt']);
    first.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, first.terminal);
    noteInsertedCommand(SESSION, 'cat \\\ntest.txt');
    first.buffer.cursorY = 2;
    beginCommandBlock(SESSION, first.terminal, null);

    // 사용자가 이번에는 직접 여러 줄을 쳤다(PS2 보고 없음) → 다시 막혀야 한다.
    const second = createFakeTerminal(['$ cat \\', 'test.txt']);
    second.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, second.terminal);
    second.buffer.cursorY = 2;
    beginCommandBlock(SESSION, second.terminal, null);

    const blocks = getCommandBlocks(SESSION);
    expect(blocks[blocks.length - 1].commandUnreliable).toBe(true);
  });

  it('접힘 경계에서 명령에 속한 공백을 잘라먹지 않는다', () => {
    // 다음 행이 접힘이면 이 행은 폭을 가득 채운 것 — trimRight 를 하면 단어가 붙어 버린다.
    const fake = createFakeTerminal(['$ echo a   ', 'b'], [1]);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 2;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('echo a   b');
    expect(block.commandUnreliable).toBe(false);
  });

  it('0 이 아닌 종료코드는 failed 로 표시하고 액센트 색을 갱신한다', () => {
    const fake = createFakeTerminal(['$ boom']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);

    const dot = () => fake.decorations[0].element?.firstElementChild as HTMLElement | undefined;
    const runningColor = dot()?.style.backgroundColor;
    finishCommandBlock(SESSION, fake.terminal, 127);

    const [block] = getCommandBlocks(SESSION);
    expect(block.state).toBe('failed');
    expect(block.exitCode).toBe(127);
    // 데코레이션을 새로 만들지 않고 같은 요소의 점 색만 갱신한다.
    expect(fake.decorations).toHaveLength(1);
    expect(dot()?.style.backgroundColor).not.toBe(runningColor);
  });

  // Ctrl+C 로 끊은 명령(130)·pager 를 닫은 명령(141)은 실패가 아니다 — 빨간 점을 찍으면
  // `tail -f`·`top` 처럼 끊는 게 정상인 명령이 매번 실패처럼 보인다.
  it.each([130, 141])('%i 로 끝난 명령은 interrupted 로, 실패와 다른 색으로 표시한다', (code) => {
    const failedFake = createFakeTerminal(['$ boom']);
    failedFake.buffer.cursorX = 2;
    notePromptCommandStart('failed-session', failedFake.terminal);
    failedFake.buffer.cursorY = 1;
    beginCommandBlock('failed-session', failedFake.terminal, null);
    finishCommandBlock('failed-session', failedFake.terminal, 1);
    const failedColor = (failedFake.decorations[0].element?.firstElementChild as HTMLElement)
      .style.backgroundColor;

    const fake = createFakeTerminal(['$ tail -f syslog']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    finishCommandBlock(SESSION, fake.terminal, code);

    const [block] = getCommandBlocks(SESSION);
    expect(block.state).toBe('interrupted');
    expect(block.exitCode).toBe(code);
    const dot = fake.decorations[0].element?.firstElementChild as HTMLElement;
    expect(dot.style.backgroundColor).not.toBe(failedColor);
    clearCommandBlocks('failed-session');
  });

  it('점 마커는 명령 줄 한 행에만 찍고, 출력 끝 행은 기록만 해 둔다', () => {
    const fake = createFakeTerminal(['$ build']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);

    // 출력이 5줄(2~6행) 나온 뒤 종료. D 가 올 때 커서는 그 아래 새 행 첫 칸에 있다 — 셸이 거기에
    // 다음 프롬프트를 그린다.
    fake.buffer.cursorY = 7;
    fake.buffer.cursorX = 0;
    finishCommandBlock(SESSION, fake.terminal, 0);

    const [block] = getCommandBlocks(SESSION);
    // 범위는 마지막 출력 행까지다(다음 프롬프트 행은 아니다). 마커 자체는 1행이다.
    expect(block.endLine).toBe(6);
    expect(fake.decorations).toHaveLength(1);
    expect(fake.decorations[0].height).toBe(1);
    // 점은 셀 영역 바깥(거터)에 놓여 글자와 겹치지 않는다.
    expect(fake.decorations[0].element?.style.left).toBe('-10px');
  });

  it('대체화면(vim 등)에서는 블록을 만들지 않는다', () => {
    const fake = createFakeTerminal(['$ vim']);
    fake.buffer.type = 'alternate';

    notePromptCommandStart(SESSION, fake.terminal);
    beginCommandBlock(SESSION, fake.terminal, null);

    expect(getCommandBlocks(SESSION)).toHaveLength(0);
    expect(fake.markers).toHaveLength(0);
  });

  it('명령 없이 프롬프트만 다시 그려지면 블록이 늘지 않는다', () => {
    const fake = createFakeTerminal(['$ ', '$ ', '$ real']);
    // 빈 Enter 로 프롬프트가 두 번 다시 그려진 뒤에야 실제 명령이 실행된다.
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 2;
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 3;
    beginCommandBlock(SESSION, fake.terminal, null);

    const blocks = getCommandBlocks(SESSION);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe('real');
  });

  // `clear` 는 화면과 스크롤백을 함께 지운다 = 마커가 전부 사라진다. 그때 기록까지 지우면
  // 히스토리가 통째로 날아간다 — 셸의 history 도 clear 로 지워지지 않는다.
  it('마커가 사라져도 기록은 남고 위치만 잃는다', () => {
    const fake = createFakeTerminal(['$ old']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    finishCommandBlock(SESSION, fake.terminal, 0);

    // xterm 이 스크롤백을 절삭하거나 clear 로 마커를 폐기하는 상황.
    fake.markers[0].dispose();

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('old');
    expect(block.exitCode).toBe(0);
    // 거터 점은 사라진다 — 그 행이 실제로 없어졌다.
    expect(fake.decorations[0].disposed).toBe(true);
    expect(block.marker.line).toBe(-1);
    // 위치를 쓰는 쪽은 그 블록을 건너뛴다.
    expect(getCommandBlockRange(block)).toBeNull();
    expect(getCommandBlockAtLine(SESSION, 0)).toBeNull();
  });

  it('D 와 A 가 한 청크로 와도 실행 중이던 블록을 닫는다', () => {
    const fake = createFakeTerminal(['$ first', '$ second']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);

    // bash/zsh 는 같은 훅에서 D 를 먼저 내보내고 곧바로 다음 프롬프트(A/B)를 그린다.
    finishCommandBlock(SESSION, fake.terminal, 0);
    notePromptCommandStart(SESSION, fake.terminal);

    const blocks = getCommandBlocks(SESSION);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].state).toBe('ok');
  });

  it('이전/다음 명령으로 점프하고, 대상이 없으면 false 를 돌려준다', () => {
    const fake = createFakeTerminal([]);
    for (const line of [10, 20, 30]) {
      fake.buffer.cursorY = line;
      notePromptCommandStart(SESSION, fake.terminal);
      fake.buffer.cursorY = line + 1;
      beginCommandBlock(SESSION, fake.terminal, null);
      finishCommandBlock(SESSION, fake.terminal, 0);
    }

    fake.buffer.viewportY = 25;
    expect(jumpToAdjacentCommandBlock(SESSION, fake.terminal, 'previous')).toBe(true);
    expect(fake.scrolledTo.at(-1)).toBe(20);

    expect(jumpToAdjacentCommandBlock(SESSION, fake.terminal, 'next')).toBe(true);
    expect(fake.scrolledTo.at(-1)).toBe(30);

    // 마지막 명령보다 아래에서는 이동할 곳이 없다 → 키를 셸로 흘려보내야 한다.
    fake.buffer.viewportY = 999;
    expect(jumpToAdjacentCommandBlock(SESSION, fake.terminal, 'next')).toBe(false);
  });

  it('failedOnly 점프는 실패한 명령만 건너뛴다', () => {
    const fake = createFakeTerminal([]);
    // 10=성공, 20=실패, 30=Ctrl+C 로 끊음(실패 아님), 40=실패
    const exitCodes = [0, 1, 130, 1];
    [10, 20, 30, 40].forEach((line, index) => {
      fake.buffer.cursorY = line;
      notePromptCommandStart(SESSION, fake.terminal);
      fake.buffer.cursorY = line + 1;
      beginCommandBlock(SESSION, fake.terminal, null);
      finishCommandBlock(SESSION, fake.terminal, exitCodes[index]);
    });

    fake.buffer.viewportY = 25;
    expect(
      jumpToAdjacentCommandBlock(SESSION, fake.terminal, 'next', { failedOnly: true }),
    ).toBe(true);
    // 30(Ctrl+C)을 건너뛰고 40(실패)으로 간다.
    expect(fake.scrolledTo.at(-1)).toBe(40);

    expect(
      jumpToAdjacentCommandBlock(SESSION, fake.terminal, 'previous', { failedOnly: true }),
    ).toBe(true);
    expect(fake.scrolledTo.at(-1)).toBe(20);
  });

  it('대체화면에서는 점프하지 않고 키를 셸에 넘긴다', () => {
    const fake = createFakeTerminal([]);
    fake.buffer.cursorY = 5;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 6;
    beginCommandBlock(SESSION, fake.terminal, null);

    fake.buffer.type = 'alternate';
    expect(jumpToAdjacentCommandBlock(SESSION, fake.terminal, 'previous')).toBe(false);
    expect(fake.scrolledTo).toHaveLength(0);
  });

  it('행으로 블록을 찾고, 실행 중인 블록은 명령 줄 이후 전부를 소유한다', () => {
    const fake = createFakeTerminal([]);
    // 블록 1: 명령 줄 0, 출력 끝 5 (완료). D 는 그 아래 6번 행 첫 칸에서 온다 — 셸이 거기에
    // 둘째 프롬프트를 그린다.
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    fake.buffer.cursorY = 6;
    fake.buffer.cursorX = 0;
    finishCommandBlock(SESSION, fake.terminal, 0);
    // 블록 2: 명령 줄 6 (아직 실행 중)
    fake.buffer.cursorY = 6;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 7;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [first, second] = getCommandBlocks(SESSION);
    expect(getCommandBlockAtLine(SESSION, 3)?.id).toBe(first.id);
    expect(getCommandBlockAtLine(SESSION, 5)?.id).toBe(first.id);
    // 첫 블록 끝(5)과 둘째 명령 줄(6) 사이는 둘째 소유.
    expect(getCommandBlockAtLine(SESSION, 6)?.id).toBe(second.id);
    // 실행 중이라 한참 아래 행도 둘째가 가진다.
    expect(getCommandBlockAtLine(SESSION, 999)?.id).toBe(second.id);
    // 첫 명령 줄보다 위에는 블록이 없다.
    expect(getCommandBlockAtLine(SESSION, -1)).toBeNull();
  });

  // 블록의 끝은 다음 프롬프트 행이 아니라 마지막 출력 행이다. hover 영역이 다음 프롬프트까지
  // 덮어 보이던 것이 이 한 행 차이였다.
  it('D 가 새 행 첫 칸에서 오면 블록은 그 위 행에서 끝난다', () => {
    const fake = createFakeTerminal(['$ pwd', '/home/ec2-user', '$ ']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    // 출력 한 줄 뒤 커서는 2번 행 첫 칸 — 셸이 거기에 프롬프트를 그린다.
    fake.buffer.cursorY = 2;
    fake.buffer.cursorX = 0;
    finishCommandBlock(SESSION, fake.terminal, 0);

    const [block] = getCommandBlocks(SESSION);
    expect(block.endLine).toBe(1);
    expect(getCommandBlockAtLine(SESSION, 1)?.id).toBe(block.id);
    // 다음 프롬프트 행은 이 블록이 아니다.
    expect(getCommandBlockAtLine(SESSION, 2)).toBeNull();
  });

  it('출력이 개행 없이 끝나면 커서가 있는 그 행까지가 출력이다', () => {
    const fake = createFakeTerminal(['$ printf hi', 'hi$ ']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    // `hi` 뒤에 개행이 없어 커서는 1번 행 2열이다 — bash 는 그 자리에 바로 프롬프트를 이어 그린다.
    fake.buffer.cursorY = 1;
    fake.buffer.cursorX = 2;
    finishCommandBlock(SESSION, fake.terminal, 0);

    expect(getCommandBlocks(SESSION)[0].endLine).toBe(1);
  });

  it('출력이 없으면 명령 줄이 곧 끝이다 — 그 위로는 올라가지 않는다', () => {
    const fake = createFakeTerminal(['$ ls', '$ ']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    fake.buffer.cursorY = 1;
    fake.buffer.cursorX = 0;
    finishCommandBlock(SESSION, fake.terminal, 0);

    const [block] = getCommandBlocks(SESSION);
    expect(block.endLine).toBe(0);
    expect(block.endLine).toBe(block.marker.line);
  });

  it('출력을 읽을 때 접힌 줄은 한 줄로 잇고 끝 빈 줄은 버린다', () => {
    // 3번 행은 2번 행이 화면 폭에 걸려 접힌 것 → 원래 한 줄.
    const fake = createFakeTerminal(
      ['$ cat log', 'first line', 'wrapped-start', 'wrapped-end', '', ''],
      [3],
    );
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    // 마지막 출력(빈 줄 둘 포함)이 5번 행까지고, 커서는 그 아래 6번 행 첫 칸이다.
    fake.buffer.cursorY = 6;
    fake.buffer.cursorX = 0;
    finishCommandBlock(SESSION, fake.terminal, 0);

    const [block] = getCommandBlocks(SESSION);
    expect(readBlockOutput(SESSION, fake.terminal, block)).toBe(
      'first line\nwrapped-startwrapped-end',
    );
  });

  it('세션 정리 시 마커와 데코레이션을 모두 폐기한다', () => {
    const fake = createFakeTerminal(['$ x']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);

    clearCommandBlocks(SESSION);

    expect(getCommandBlocks(SESSION)).toHaveLength(0);
    expect(fake.decorations[0].disposed).toBe(true);
    expect(fake.markers.every((marker) => marker.line === -1)).toBe(true);
  });

  it('블록이 여러 개여도 하나도 남기지 않고 폐기한다', () => {
    // marker.dispose() 는 onDispose 를 동기로 불러 blocks 에서 자신을 빼낸다. 순회 중에
    // 배열이 줄어들면 한 칸씩 건너뛰어 절반이 살아남는다(터미널은 재연결 후에도 살아 있어
    // 마커·데코레이션이 그대로 누적된다).
    const fake = createFakeTerminal(['$ a', '$ b', '$ c', '$ d']);
    for (let row = 0; row < 4; row += 1) {
      fake.buffer.cursorY = row;
      fake.buffer.cursorX = 2;
      notePromptCommandStart(SESSION, fake.terminal);
      beginCommandBlock(SESSION, fake.terminal, null);
    }
    expect(getCommandBlocks(SESSION)).toHaveLength(4);

    clearCommandBlocks(SESSION);

    expect(getCommandBlocks(SESSION)).toHaveLength(0);
    expect(fake.markers.filter((marker) => marker.line !== -1)).toEqual([]);
    expect(fake.decorations.filter((decoration) => !decoration.disposed)).toEqual([]);
  });
});

/**
 * 위 테스트들은 가짜 터미널을 쓰기 때문에 "xterm 이 marker/decoration 을 실제로 허용하는가"
 * 같은 제약은 잡지 못한다(실제로 allowProposedApi 누락을 놓쳐 터미널이 멈춘 적이 있다).
 * 그래서 실제 xterm 인스턴스로도 한 번 확인한다.
 */
describe('terminal-command-blocks (실제 xterm)', () => {
  function openRealTerminal(allowProposedApi: boolean) {
    if (!window.matchMedia) {
      // jsdom 에는 matchMedia 가 없어 xterm 의 DPR 모니터가 생성 중 터진다.
      (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi });
    terminal.open(container);
    return { terminal, container };
  }

  it('allowProposedApi 가 켜져 있으면 실제 xterm 에서 블록과 데코레이션이 만들어진다', () => {
    const session = 'real-xterm-ok';
    const { terminal, container } = openRealTerminal(true);

    notePromptCommandStart(session, terminal);
    beginCommandBlock(session, terminal, null);
    finishCommandBlock(session, terminal, 0);

    const blocks = getCommandBlocks(session);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].state).toBe('ok');
    expect(blocks[0].decoration).not.toBeNull();

    clearCommandBlocks(session);
    terminal.dispose();
    container.remove();
  });

  it('proposed API 가 막혀 있어도 예외를 밖으로 던지지 않는다(터미널이 멈추면 안 됨)', () => {
    const session = 'real-xterm-blocked';
    const { terminal, container } = openRealTerminal(false);

    expect(() => {
      notePromptCommandStart(session, terminal);
      beginCommandBlock(session, terminal, null);
      finishCommandBlock(session, terminal, 0);
    }).not.toThrow();

    clearCommandBlocks(session);
    terminal.dispose();
    container.remove();
  });

  it('한 세션에서 난 오류가 다른 세션의 추적까지 끄지 않는다', () => {
    // 예전에는 비활성화가 전역이라, 탭 하나에서 예외가 한 번 나면 그 창의 모든 탭과 이후
    // 모든 세션에서 앱을 다시 켤 때까지 기능이 죽었다(사용자에겐 아무 표시도 없이).
    const broken = openRealTerminal(false);
    notePromptCommandStart('poisoner', broken.terminal);
    beginCommandBlock('poisoner', broken.terminal, null);
    expect(getCommandBlocks('poisoner')).toHaveLength(0);

    const healthy = openRealTerminal(true);
    notePromptCommandStart('bystander', healthy.terminal);
    beginCommandBlock('bystander', healthy.terminal, null);
    expect(getCommandBlocks('bystander')).toHaveLength(1);

    clearCommandBlocks('poisoner');
    clearCommandBlocks('bystander');
    broken.terminal.dispose();
    broken.container.remove();
    healthy.terminal.dispose();
    healthy.container.remove();
  });
});

describe('terminal-command-blocks (셸 훅 잡음)', () => {
  const HOOK_SESSION = 'session-hook-noise';

  it('명령과 133;C 사이의 빈 줄은 재실행 불가로 만들지 않는다', () => {
    // preexec·PS0 훅이 무언가를 출력했다 지운 자리다. 명령 자체는 온전한데 이걸로
    // unreliable 을 세우면 그 사용자의 모든 명령에 "재실행 불가" 배지가 붙는다.
    const fake = createFakeTerminal(['$ ls -la', '']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(HOOK_SESSION, fake.terminal);
    fake.buffer.cursorY = 2;
    beginCommandBlock(HOOK_SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(HOOK_SESSION);
    expect(block.command).toBe('ls -la');
    expect(block.commandUnreliable).toBe(false);
    clearCommandBlocks(HOOK_SESSION);
  });
});

// 세션 패널 히스토리가 이 구독으로 갱신을 받는다. 목록 배열은 제자리에서 바뀌므로(참조 불변)
// 버전 숫자가 스냅샷 역할을 한다 — 이게 안 오르면 패널이 영원히 첫 화면을 보여 준다.
describe('블록 목록 구독', () => {
  function runCommand(fake: ReturnType<typeof createFakeTerminal>, row: number) {
    fake.buffer.cursorY = row;
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = row + 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    finishCommandBlock(SESSION, fake.terminal, 0);
  }

  it('명령이 시작·종료될 때마다 버전이 오르고 구독자가 불린다', () => {
    const fake = createFakeTerminal(['$ ls', 'out', '$ pwd', 'out']);
    let calls = 0;
    const unsubscribe = subscribeToCommandBlocks(SESSION, () => {
      calls += 1;
    });

    expect(getCommandBlocksVersion(SESSION)).toBe(0);
    runCommand(fake, 0);
    // 시작(C)과 종료(D) 각각 한 번.
    expect(calls).toBe(2);
    expect(getCommandBlocksVersion(SESSION)).toBe(2);

    unsubscribe();
    runCommand(fake, 2);
    // 구독을 끊었으면 더 이상 불리지 않지만 버전은 계속 오른다.
    expect(calls).toBe(2);
    expect(getCommandBlocksVersion(SESSION)).toBe(4);
  });

  it('마커가 사라지면 알린다 — 목록은 그대로다(위치만 잃는다)', () => {
    const fake = createFakeTerminal(['$ ls', 'out']);
    runCommand(fake, 0);
    let calls = 0;
    const unsubscribe = subscribeToCommandBlocks(SESSION, () => {
      calls += 1;
    });

    fake.markers[0].dispose();
    expect(calls).toBe(1);
    expect(getCommandBlocks(SESSION)).toHaveLength(1);
    unsubscribe();
  });

  it('세션이 정리되면 알리고 버전이 0 으로 돌아간다', () => {
    const fake = createFakeTerminal(['$ ls', 'out']);
    runCommand(fake, 0);
    let calls = 0;
    const unsubscribe = subscribeToCommandBlocks(SESSION, () => {
      calls += 1;
    });

    clearCommandBlocks(SESSION);
    expect(calls).toBeGreaterThan(0);
    // 세션 객체가 사라지므로 버전 조회는 0 — 구독자의 스냅샷이 달라져 다시 그린다.
    expect(getCommandBlocksVersion(SESSION)).toBe(0);
    unsubscribe();
  });

  it('구독자가 던져도 명령 추적은 계속된다', () => {
    // 이 알림은 xterm 의 OSC 핸들러 안에서 나간다 — 여기서 예외가 새면 파싱 루프가 끊긴다.
    const fake = createFakeTerminal(['$ ls', 'out']);
    const unsubscribe = subscribeToCommandBlocks(SESSION, () => {
      throw new Error('boom');
    });
    expect(() => runCommand(fake, 0)).not.toThrow();
    expect(getCommandBlocks(SESSION)).toHaveLength(1);
    unsubscribe();
  });
});

// 셸이 명령 원문을 알려주면(OSC 133;E) 화면을 읽지 않는다. 화면 읽기의 두 한계(보조 프롬프트
// 혼입·행 예산 잘림)가 그대로 사라지는 경로다.
describe('셸이 알려 준 명령 원문', () => {
  it('화면 대신 그 값을 쓰고 재실행을 막지 않는다', () => {
    // 화면에는 PS2 가 섞여 있지만(`heredoc> `) E 가 있으면 그것을 무시한다.
    const fake = createFakeTerminal(['% cat <<EOF', 'heredoc> line1', 'heredoc> EOF']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    noteReportedCommand(SESSION, 'cat <<EOF\\nline1\\nEOF');
    fake.buffer.cursorY = 3;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('cat <<EOF\nline1\nEOF');
    expect(block.commandUnreliable).toBe(false);
  });

  it('한 번 쓰면 버린다 — 다음 명령에 붙지 않는다', () => {
    const fake = createFakeTerminal(['$ first', 'out', '$ second', 'out']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    noteReportedCommand(SESSION, 'reported');
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    finishCommandBlock(SESSION, fake.terminal, 0);

    fake.buffer.cursorY = 2;
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 3;
    beginCommandBlock(SESSION, fake.terminal, null);

    const blocks = getCommandBlocks(SESSION);
    expect(blocks[0].command).toBe('reported');
    // 두 번째는 화면에서 읽는다.
    expect(blocks[1].command).toBe('second');
  });

  it('새 프롬프트가 뜨면 쓰이지 않은 값을 버린다', () => {
    // 명령이 실행되지 않고 프롬프트만 다시 뜨는 경우(빈 엔터·Ctrl-C).
    const fake = createFakeTerminal(['$ typed', 'out']);
    noteReportedCommand(SESSION, 'stale');
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    beginCommandBlock(SESSION, fake.terminal, null);
    expect(getCommandBlocks(SESSION)[0].command).toBe('typed');
  });
});

describe('unescapeReportedCommand', () => {
  it('개행과 역슬래시를 되돌린다', () => {
    expect(unescapeReportedCommand('a\\nb')).toBe('a\nb');
    expect(unescapeReportedCommand('back\\\\slash')).toBe('back\\slash');
  });

  it('사용자가 친 \\n 을 개행으로 오해하지 않는다', () => {
    // 셸이 역슬래시를 먼저 두 배로 만들어 보내므로 이 조합이 구분된다.
    expect(unescapeReportedCommand('echo back\\\\nline')).toBe('echo back\\nline');
  });

  it('우리가 만들지 않은 조합은 그대로 둔다', () => {
    expect(unescapeReportedCommand('grep \\d')).toBe('grep \\d');
  });
});

// bash 는 명령 원문을 알려줄 수 없어(133;E 불가) 화면을 읽는다. 그러면 화면에 찍힌 PS2 가
// 섞이는데(`cat \\` 다음 줄이 `> test.txt`), 이어 붙이면 `cat > test.txt` — 리다이렉트가 되어
// 파일이 비고 셸이 stdin 을 기다린다. 그래서 PS2 에도 마커를 붙여 셸이 프롬프트 폭을 알려준다.
describe('이어지는 줄의 프롬프트(OSC 133;B;2)', () => {
  it('알려 준 폭만큼 잘라내 PS2 가 섞이지 않는다', () => {
    const fake = createFakeTerminal(['$ cat \\', '> test.txt']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);

    // 이어지는 줄: PS2("> ")가 그려진 뒤 마커가 온다 → 커서는 2열.
    fake.buffer.cursorY = 1;
    fake.buffer.cursorX = 2;
    noteContinuationPrompt(SESSION, fake.terminal);

    fake.buffer.cursorY = 2;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('cat \\\ntest.txt');
    // 오염이 없으니 재실행을 막지 않는다.
    expect(block.commandUnreliable).toBe(false);
  });

  it('heredoc 본문도 같은 방식으로 복원된다', () => {
    const fake = createFakeTerminal(['$ cat <<EOF', '> line1', '> EOF']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    for (const row of [1, 2]) {
      fake.buffer.cursorY = row;
      fake.buffer.cursorX = 2;
      noteContinuationPrompt(SESSION, fake.terminal);
    }
    fake.buffer.cursorY = 3;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('cat <<EOF\nline1\nEOF');
    expect(block.commandUnreliable).toBe(false);
  });

  it('마커가 없는 줄은 예전처럼 믿을 수 없다고 본다', () => {
    // 예전 세션·통합이 없는 셸. 한 줄만 알려 주고 다음 줄은 안 알려 주는 경우도 포함.
    const fake = createFakeTerminal(['$ cat <<EOF', '> line1', '> EOF']);
    fake.buffer.cursorX = 2;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = 1;
    fake.buffer.cursorX = 2;
    noteContinuationPrompt(SESSION, fake.terminal);
    fake.buffer.cursorY = 3;
    beginCommandBlock(SESSION, fake.terminal, null);

    const [block] = getCommandBlocks(SESSION);
    expect(block.command).toBe('cat <<EOF\nline1\n> EOF');
    expect(block.commandUnreliable).toBe(true);
  });

  it('첫 프롬프트를 못 받았으면 무시한다', () => {
    // 기준이 없는 이어지는 줄은 쓸 수 없다.
    const fake = createFakeTerminal(['> orphan']);
    fake.buffer.cursorX = 2;
    expect(() => noteContinuationPrompt(SESSION, fake.terminal)).not.toThrow();
    expect(getCommandBlocks(SESSION)).toHaveLength(0);
  });
});

/**
 * Windows 로컬 셸은 ConPTY 안에서 돈다. ConPTY 는 리사이즈 때 자기 화면 사본을 다시 접어 위쪽부터
 * 다시 그리는데, 접는 기준이 xterm 과 달라 글자는 옮겨 가고 xterm 마커는 제자리에 남는다(실측: 한국어
 * Windows PowerShell 의 `ls` 뒤 최대화에서 21행). 가짜 터미널의 마커는 움직이지 않으므로 행 텍스트만
 * 바꿔 그 상황을 만든다.
 */
describe('ConPTY 가 다시 그린 뒤 블록 위치 맞추기', () => {
  const PROMPT = 'PS C:\\> ';

  /** promptLine 의 프롬프트 뒤 명령을 B→C→D 로 기록한다. 출력은 outputEnd 바로 위 줄까지다. */
  function recordCommand(
    fake: ReturnType<typeof createFakeTerminal>,
    promptLine: number,
    outputEnd: number,
  ) {
    fake.buffer.cursorY = promptLine;
    fake.buffer.cursorX = PROMPT.length;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = promptLine + 1;
    fake.buffer.cursorX = 0;
    beginCommandBlock(SESSION, fake.terminal, null);
    fake.buffer.cursorY = outputEnd;
    finishCommandBlock(SESSION, fake.terminal, 0);
  }

  /** 다음 프롬프트를 띄운다(B 만 오고 아직 실행하지 않은 상태). */
  function showPrompt(fake: ReturnType<typeof createFakeTerminal>, line: number) {
    fake.buffer.cursorY = line;
    fake.buffer.cursorX = PROMPT.length;
    notePromptCommandStart(SESSION, fake.terminal);
  }

  function setUpTwoCommands() {
    const rows = [
      `${PROMPT}ls`,
      'a',
      '', // ConPTY 는 자기 사본에서 앞 줄에서 접힌 칸으로 안다 — 넓어지면 사라진다.
      `${PROMPT}echo hi`,
      'hi',
      PROMPT,
    ];
    const fake = createFakeTerminal(rows);
    recordCommand(fake, 0, 3);
    recordCommand(fake, 3, 5);
    showPrompt(fake, 5);
    return { rows, fake };
  }

  /** ConPTY 가 넓어진 화면을 다시 그린 결과: 빈 행이 사라져 그 아래가 한 줄씩 올라가고 커서도 올라간다. */
  function repaintAfterWiden(rows: string[], fake: ReturnType<typeof createFakeTerminal>) {
    rows.splice(2, 1);
    rows.push('');
    fake.buffer.cursorY = 4;
  }

  it('명령 줄이 올라가면 블록과 입력 중인 프롬프트를 그 줄로 옮긴다', () => {
    const { rows, fake } = setUpTwoCommands();
    const [first, second] = getCommandBlocks(SESSION);
    const oldDecoration = fake.decorations[1];

    repaintAfterWiden(rows, fake);
    expect(rows[second.marker.line]).toBe('hi');

    expect(realignCommandBlocks(SESSION, fake.terminal)).toBe(1);
    expect(first.marker.line).toBe(0);
    expect(second.marker.line).toBe(2);
    // 출력 끝도 같이 옮겨야 hover 영역이 다음 프롬프트를 덮지 않는다.
    expect(second.endLine).toBe(3);
    // 옛 점은 치우고 새 줄에 다시 단다.
    expect(oldDecoration.disposed).toBe(true);
    expect(second.decoration).not.toBeNull();
    expect(second.decoration).not.toBe(oldDecoration);

    // 프롬프트를 안 옮기면 다음 명령이 빈 줄에서 읽혀 명령도 점 위치도 틀린다.
    rows[4] = `${PROMPT}pwd`;
    fake.buffer.cursorY = 5;
    fake.buffer.cursorX = 0;
    beginCommandBlock(SESSION, fake.terminal, null);
    const next = getCommandBlocks(SESSION)[2];
    expect(next.command).toBe('pwd');
    expect(next.marker.line).toBe(4);
  });

  it('옮긴 뒤 옛 마커가 사라져도 블록의 점은 남는다', () => {
    const { rows, fake } = setUpTwoCommands();
    const second = getCommandBlocks(SESSION)[1];
    const oldMarker = second.marker;

    repaintAfterWiden(rows, fake);
    realignCommandBlocks(SESSION, fake.terminal);

    oldMarker.dispose();
    expect(second.decoration).not.toBeNull();
  });

  // 같은 명령을 연달아 쳤고, 줄이 아래로 밀리면서(창을 좁힐 때) 뒤 블록의 마커가 앞 블록의 명령 줄에
  // 겹쳤다. 텍스트만 보면 맞아 보이지만 그 줄은 앞 블록 것이다 — 더 최근 블록부터 찾아야 섞이지 않는다.
  it('같은 명령을 연달아 쳤어도 서로의 줄로 가지 않는다', () => {
    const rows = [`${PROMPT}ls`, 'x', `${PROMPT}ls`, 'y', PROMPT];
    const fake = createFakeTerminal(rows);
    recordCommand(fake, 0, 2);
    recordCommand(fake, 2, 4);
    showPrompt(fake, 4);
    const [first, second] = getCommandBlocks(SESSION);

    rows.unshift('older-1', 'older-2');
    fake.buffer.cursorY = 6;
    expect(rows[second.marker.line]).toBe(`${PROMPT}ls`);

    expect(realignCommandBlocks(SESSION, fake.terminal)).toBe(2);
    expect(first.marker.line).toBe(2);
    expect(second.marker.line).toBe(4);
  });

  it('명령 줄을 찾지 못하면 옮기지 않는다', () => {
    const rows = [`${PROMPT}ls`, 'a', PROMPT];
    const fake = createFakeTerminal(rows);
    recordCommand(fake, 0, 2);
    showPrompt(fake, 2);
    const [block] = getCommandBlocks(SESSION);

    rows[0] = 'overwritten';
    expect(realignCommandBlocks(SESSION, fake.terminal)).toBe(0);
    expect(block.marker.line).toBe(0);
  });

  it('리사이즈 뒤 출력이 조용해지면 한 번 맞추고, 기다리는 시간이 지나면 더는 맞추지 않는다', () => {
    vi.useFakeTimers();
    try {
      const { rows, fake } = setUpTwoCommands();
      const second = getCommandBlocks(SESSION)[1];
      const realigner = createConptyBlockRealigner(fake.terminal, () => SESSION);

      realigner.noteResize();
      repaintAfterWiden(rows, fake);
      fake.fireWriteParsed();
      vi.advanceTimersByTime(40);
      // 재그리기가 여러 청크로 오면 마지막 청크 뒤까지 미룬다.
      fake.fireWriteParsed();
      vi.advanceTimersByTime(40);
      expect(second.marker.line).toBe(3);
      vi.advanceTimersByTime(10);
      expect(second.marker.line).toBe(2);

      // 리사이즈가 없었는데 화면이 바뀐 것은 맞추지 않는다(명령 출력일 뿐이다).
      vi.advanceTimersByTime(3000);
      rows.unshift('later');
      fake.buffer.cursorY = 5;
      fake.fireWriteParsed();
      vi.advanceTimersByTime(100);
      expect(second.marker.line).toBe(2);

      realigner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Ctrl+L 은 보이는 화면만 지우고(ESC[2J) 맨 위에 프롬프트를 다시 그린다. 출력이 화면보다 길었던
// 블록은 명령 줄이 스크롤백에 남아 마커가 살아 있으므로, 끝을 당기지 않으면 지워진 화면 전체를
// 자기 범위로 잡는다 — 빈 화면에 마우스를 올리면 그 블록 강조와 툴바가 떴다.
describe('화면 전체 지우기 뒤 블록 범위', () => {
  const PROMPT = 'PS> ';

  /** promptLine 의 명령을 B→C 로 시작하고, outputEnd 행 첫 칸에서 D 를 받아 그 위 행에서 끝낸다. */
  function recordCommand(
    fake: ReturnType<typeof createFakeTerminal>,
    promptLine: number,
    outputEnd: number | null,
  ) {
    fake.buffer.cursorY = promptLine;
    fake.buffer.cursorX = PROMPT.length;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = promptLine + 1;
    fake.buffer.cursorX = 0;
    beginCommandBlock(SESSION, fake.terminal, null);
    if (outputEnd !== null) {
      fake.buffer.cursorY = outputEnd;
      finishCommandBlock(SESSION, fake.terminal, 0);
    }
  }

  function setUp() {
    // 0~3: 짧은 명령, 4~12: 화면보다 긴 출력, 13: 프롬프트. 화면(활성 영역)은 8행부터다.
    const rows = [
      `${PROMPT}pwd`,
      'C:\\',
      '',
      '',
      `${PROMPT}seq`,
      ...Array.from({ length: 8 }, (_, index) => String(index + 1)),
      PROMPT,
    ];
    const fake = createFakeTerminal(rows);
    recordCommand(fake, 0, 4);
    recordCommand(fake, 4, 13);
    fake.buffer.baseY = 8;
    fake.buffer.cursorY = 13 - 8;
    return fake;
  }

  it('스크롤백에서 시작해 화면까지 이어진 블록은 지워지는 줄 바로 위에서 끝난다', () => {
    const fake = setUp();
    const [pwd, seq] = getCommandBlocks(SESSION);
    expect(seq.endLine).toBe(12);
    const versionBefore = getCommandBlocksVersion(SESSION);

    noteScreenErased(SESSION, fake.terminal);

    expect(seq.endLine).toBe(7);
    // 스크롤백에 남은 출력은 그대로 그 블록 것이다.
    expect(getCommandBlockAtLine(SESSION, 6)).toBe(seq);
    for (let line = 8; line <= 13; line += 1) {
      expect(getCommandBlockAtLine(SESSION, line)).toBeNull();
    }
    expect(readBlockOutput(SESSION, fake.terminal, seq)).toBe('1\n2\n3');
    // 화면에 닿지 않던 블록은 그대로다.
    expect(pwd.endLine).toBe(3);
    expect(getCommandBlocksVersion(SESSION)).toBe(versionBefore + 1);
  });

  it('지울 블록이 없으면 알리지 않는다', () => {
    const fake = setUp();
    noteScreenErased(SESSION, fake.terminal);
    const versionBefore = getCommandBlocksVersion(SESSION);

    noteScreenErased(SESSION, fake.terminal);
    expect(getCommandBlocksVersion(SESSION)).toBe(versionBefore);
  });

  it('실행 중인 블록은 건드리지 않는다 — 지운 뒤의 출력도 그 명령 것이다', () => {
    const rows = [`${PROMPT}watch`, ...Array.from({ length: 10 }, (_, index) => String(index))];
    const fake = createFakeTerminal(rows);
    recordCommand(fake, 0, null);
    fake.buffer.baseY = 5;
    const [running] = getCommandBlocks(SESSION);

    noteScreenErased(SESSION, fake.terminal);

    expect(running.endLine).toBeNull();
    expect(getCommandBlockAtLine(SESSION, 8)).toBe(running);
  });

  it('대체화면에서 지우는 것은 블록과 무관하다', () => {
    const fake = setUp();
    const seq = getCommandBlocks(SESSION)[1];
    fake.buffer.type = 'alternate';

    noteScreenErased(SESSION, fake.terminal);
    expect(seq.endLine).toBe(12);
  });
});

// PowerShell 의 `cls` 는 ESC[2J 없이 화면을 지운다(맨 위부터 줄마다 ESC[K, 그리고 ESC[3J). 줄마다 지우기는
// 마커를 없애지 않으므로 `cls` 자신의 마커가 살아 있고, 끝날 때 커서는 맨 위다 — 빈 화면 아래쪽 원래
// 명령 줄 자리에 `cls` 의 점이 남았다.
describe('화면을 다시 쓰고 끝난 명령(cls)', () => {
  const PROMPT = 'PS> ';

  /** promptLine 의 명령을 B→C 로 시작한다(아직 끝나지 않았다). */
  function startCommand(fake: ReturnType<typeof createFakeTerminal>, promptLine: number) {
    fake.buffer.cursorY = promptLine;
    fake.buffer.cursorX = PROMPT.length;
    notePromptCommandStart(SESSION, fake.terminal);
    fake.buffer.cursorY = promptLine + 1;
    fake.buffer.cursorX = 0;
    beginCommandBlock(SESSION, fake.terminal, null);
  }

  /** ls(0~1)를 끝내고 cls(2)를 실행 중인 상태. */
  function setUp() {
    const rows = [`${PROMPT}ls`, 'a', `${PROMPT}cls`, ''];
    const fake = createFakeTerminal(rows);
    startCommand(fake, 0);
    fake.buffer.cursorY = 2;
    finishCommandBlock(SESSION, fake.terminal, 0);
    startCommand(fake, 2);
    const [ls, cls] = getCommandBlocks(SESSION);
    expect(cls.command).toBe('cls');
    return { rows, fake, ls, cls };
  }

  it('끝날 때 커서가 명령 줄보다 위로 가 있고 그 사이가 비었으면 그 줄들의 블록 위치를 버린다', () => {
    const { rows, fake, ls, cls } = setUp();

    // cls: 화면을 비우고 커서를 맨 위로 옮긴 뒤 D 가 온다(프롬프트는 그 뒤에 그려진다).
    rows.fill('');
    fake.buffer.cursorY = 0;
    finishCommandBlock(SESSION, fake.terminal, 0);

    expect(ls.marker.line).toBe(-1);
    expect(cls.marker.line).toBe(-1);
    expect(fake.decorations.every((decoration) => decoration.disposed)).toBe(true);
    expect(cls.state).toBe('ok');
    // 기록은 남는다.
    expect(getCommandBlocks(SESSION)).toEqual([ls, cls]);
    for (let line = 0; line < rows.length; line += 1) {
      expect(getCommandBlockAtLine(SESSION, line)).toBeNull();
    }
  });

  // 창 크기를 바꾼 직후 ConPTY 가 화면을 다시 그렸는데 위치를 맞추기 전에 명령이 끝난 경우가 이렇다.
  it('그 사이에 글자가 남아 있으면 지운 것이 아니므로 건드리지 않는다', () => {
    const { fake, ls, cls } = setUp();

    fake.buffer.cursorY = 0;
    finishCommandBlock(SESSION, fake.terminal, 0);

    expect(ls.marker.line).toBe(0);
    expect(cls.marker.line).toBe(2);
    expect(cls.decoration).not.toBeNull();
  });
});

/**
 * 실제 xterm 으로 확인한다. 지운 줄의 마커는 xterm 이 없애고(명령 줄이 화면 안에 있던 블록), 스크롤백에서
 * 시작한 블록은 우리가 끝을 당긴다. 런타임처럼 CSI J 핸들러를 걸어 xterm 의 지우기 직전에 부른다.
 */
describe('화면을 지운 뒤 블록 범위 (실제 xterm)', () => {
  const session = 'screen-erase';

  afterEach(() => {
    clearCommandBlocks(session);
  });

  function createTerminal() {
    const terminal = new HeadlessTerminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true });
    // headless 에는 데코레이션이 없다 — 여기서 보는 것은 마커와 범위다.
    (terminal as unknown as { registerDecoration: () => undefined }).registerDecoration = () =>
      undefined;
    const term = terminal as unknown as Terminal;
    terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
      if (params[0] === 2) {
        noteScreenErased(session, term);
      }
      return false;
    });
    const write = (data: string) =>
      new Promise<void>((resolve) => {
        terminal.write(data, resolve);
      });
    const lineText = (line: number) =>
      terminal.buffer.active.getLine(line)?.translateToString(true);
    return { terminal, term, write, lineText };
  }

  /** 실측한 ConPTY 의 cls: 맨 위로 가서 줄마다 지우고, 스크롤백을 지운 뒤 한 번 더 지우고 맨 위로. */
  async function runConptyCls(
    terminal: HeadlessTerminal,
    term: Terminal,
    write: (data: string) => Promise<void>,
  ) {
    await write('PS> ');
    notePromptCommandStart(session, term);
    await write('cls\r\n');
    beginCommandBlock(session, term, null);
    const blankScreen = `${'\x1b[K\r\n'.repeat(terminal.rows - 1)}\x1b[K\x1b[H`;
    await write(`\x1b[H${blankScreen}\x1b[3J${blankScreen}`);
    finishCommandBlock(session, term, 0);
    await write('PS> ');
    notePromptCommandStart(session, term);
  }

  // 스크롤백이 없으면 ESC[3J 가 지울 것도 없다 — 화면에 있던 블록이 그대로 남아 점이 빈 화면에 찍혔다.
  it('짧은 기록 뒤 cls: 화면에 있던 블록이 모두 위치를 잃는다', async () => {
    const { terminal, term, write } = createTerminal();
    try {
      await write('PS> ');
      notePromptCommandStart(session, term);
      await write('echo a\r\n');
      beginCommandBlock(session, term, null);
      await write('a\r\n');
      finishCommandBlock(session, term, 0);
      expect(terminal.buffer.active.baseY).toBe(0);

      await runConptyCls(terminal, term, write);

      const blocks = getCommandBlocks(session);
      expect(blocks.map((block) => block.command)).toEqual(['echo a', 'cls']);
      expect(blocks.map((block) => block.marker.line)).toEqual([-1, -1]);
      for (let line = 0; line < terminal.rows; line += 1) {
        expect(getCommandBlockAtLine(session, line)).toBeNull();
      }
    } finally {
      terminal.dispose();
    }
  });

  it('긴 출력 뒤 cls: 빈 화면에 cls 의 블록이 남지 않는다', async () => {
    const { terminal, term, write } = createTerminal();
    try {
      await write('PS> ');
      notePromptCommandStart(session, term);
      await write('seq\r\n');
      beginCommandBlock(session, term, null);
      await write('1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n');
      finishCommandBlock(session, term, 0);

      await runConptyCls(terminal, term, write);

      const [seq, cls] = getCommandBlocks(session);
      expect(cls.command).toBe('cls');
      expect(cls.state).toBe('ok');
      // seq 는 스크롤백과 함께, cls 는 화면이 다시 쓰여 위치를 잃는다. 기록은 둘 다 남는다.
      expect(seq.marker.line).toBe(-1);
      expect(cls.marker.line).toBe(-1);
      const baseY = terminal.buffer.active.baseY;
      for (let line = baseY; line < baseY + terminal.rows; line += 1) {
        expect(getCommandBlockAtLine(session, line)).toBeNull();
      }
    } finally {
      terminal.dispose();
    }
  });

  it('Ctrl+L 뒤 빈 화면의 어느 줄도 예전 블록에 걸리지 않는다', async () => {
    const { terminal, term, write, lineText } = createTerminal();
    try {
      await write('PS> ');
      notePromptCommandStart(session, term);
      await write('seq\r\n');
      beginCommandBlock(session, term, null);
      await write('1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n');
      finishCommandBlock(session, term, 0);
      await write('PS> ');
      notePromptCommandStart(session, term);
      await write('echo hi\r\n');
      beginCommandBlock(session, term, null);
      await write('hi\r\n');
      finishCommandBlock(session, term, 0);
      await write('PS> ');
      notePromptCommandStart(session, term);

      // 화면(5행): ['5', '6', 'PS> echo hi', 'hi', 'PS>'] — seq 의 명령 줄은 스크롤백에 있다.
      const baseY = terminal.buffer.active.baseY;
      expect(baseY).toBe(5);
      const [seq, echo] = getCommandBlocks(session);
      expect(getCommandBlockAtLine(session, baseY)).toBe(seq);

      // PowerShell 의 Ctrl+L: ConPTY 가 화면을 지우고 맨 위에 프롬프트를 다시 그린다.
      await write('\x1b[2J\x1b[HPS> ');
      notePromptCommandStart(session, term);

      for (let line = baseY; line < baseY + terminal.rows; line += 1) {
        expect(getCommandBlockAtLine(session, line)).toBeNull();
      }
      // seq 는 명령 줄과 스크롤백에 남은 출력으로 산다.
      expect(lineText(seq.marker.line)).toBe('PS> seq');
      expect(seq.endLine).toBe(baseY - 1);
      expect(readBlockOutput(session, term, seq)).toBe('1\n2\n3\n4');
      // echo 는 명령 줄이 지워져 위치를 잃었다(xterm 이 마커를 없앤다). 기록은 남는다.
      expect(echo.marker.line).toBe(-1);
      expect(getCommandBlocks(session)).toHaveLength(2);
    } finally {
      terminal.dispose();
    }
  });
});

/**
 * 위 테스트는 "다시 그린 결과" 를 손으로 만든다. 여기서는 실제 xterm 에 ConPTY 가 보낸 것과 같은
 * 모양의 바이트를 흘려 넣어 그 결과가 정말 그렇게 되는지 확인한다.
 *
 * 실측한 모양: 한국어 Windows PowerShell 의 `ls` 표는 줄마다 폭보다 1칸 길다. ConPTY 는 그 줄을
 * 폭만큼 채운 줄과 빈 줄, 둘로 보낸다(xterm 버퍼에는 접힘 표시가 없다). 창을 넓히면 ConPTY 는 자기
 * 사본에서 그 둘을 한 줄로 펴고 화면을 위쪽부터 `\e[H … \e[K` 로 다시 그린 뒤 커서를 옮긴다.
 */
describe('ConPTY 가 다시 그린 뒤 블록 위치 맞추기 (실제 xterm)', () => {
  const session = 'conpty-repaint';

  afterEach(() => {
    clearCommandBlocks(session);
  });

  it('넓어진 화면이 다시 그려져도 블록과 다음 명령이 제 줄에 붙는다', async () => {
    const terminal = new HeadlessTerminal({
      cols: 20,
      rows: 6,
      scrollback: 100,
      allowProposedApi: true,
      windowsPty: { backend: 'conpty' },
    });
    // headless 에는 데코레이션이 없다 — 여기서 보는 것은 마커 위치다.
    (terminal as unknown as { registerDecoration: () => undefined }).registerDecoration = () =>
      undefined;
    const term = terminal as unknown as Terminal;
    const write = (data: string) =>
      new Promise<void>((resolve) => {
        terminal.write(data, resolve);
      });
    const lineText = (line: number) =>
      terminal.buffer.active.getLine(line)?.translateToString(true);
    const fullRow = (text: string) => text.padEnd(20, ' ');

    try {
      await write('filler-1\r\nfiller-2\r\n');
      await write('PS> ');
      notePromptCommandStart(session, term);
      await write('ls\r\n');
      beginCommandBlock(session, term, null);
      await write(
        `${fullRow('entry-1')}\r\n\x1b[K\r\n${fullRow('entry-2')}\r\n\x1b[K\r\n${fullRow('entry-3')}\r\n\x1b[K\r\n`,
      );
      finishCommandBlock(session, term, 0);
      await write('PS> ');
      notePromptCommandStart(session, term);
      await write('echo hi\r\n');
      beginCommandBlock(session, term, null);
      await write('hi\r\n');
      finishCommandBlock(session, term, 0);
      await write('PS> ');
      notePromptCommandStart(session, term);

      // 활성 화면(마지막 6행): ['', 'entry-3', '', 'PS> echo hi', 'hi', 'PS> ']
      expect(terminal.buffer.active.baseY).toBe(6);
      const [ls, echo] = getCommandBlocks(session);
      expect(lineText(echo.marker.line)).toBe('PS> echo hi');

      terminal.resize(30, 6);
      // ConPTY 의 사본: 맨 위 행은 앞(이미 스크롤된) 줄의 나머지라 그대로, entry-3 와 그 나머지는
      // 한 줄로 펴지고, 아래에 빈 행이 생긴다. 지금 프롬프트 뒤 공백은 쓰지 않고 지운 뒤 커서만
      // 옮긴다(실측: `PS C:\Users\Computer>\e[K\e[1C`) — B 때 기록한 프롬프트와 줄 끝이 다르다.
      const conptyView = ['', 'entry-3', 'PS> echo hi', 'hi', 'PS>', ''];
      await write(`\x1b[H${conptyView.join('\x1b[K\r\n')}\x1b[K\x1b[5;5H`);

      // 맞추기 전: 글자는 한 행 올라갔고 마커는 제자리다.
      expect(lineText(echo.marker.line)).toBe('hi');

      expect(realignCommandBlocks(session, term)).toBe(1);
      expect(lineText(echo.marker.line)).toBe('PS> echo hi');
      expect(lineText(ls.marker.line)).toBe('PS> ls');

      // 다음 명령도 제 줄에서 읽는다.
      await write('pwd\r\n');
      beginCommandBlock(session, term, null);
      const next = getCommandBlocks(session)[2];
      expect(next.command).toBe('pwd');
      expect(lineText(next.marker.line)).toBe('PS> pwd');
    } finally {
      terminal.dispose();
    }
  });
});
