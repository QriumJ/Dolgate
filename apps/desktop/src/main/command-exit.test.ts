import { describe, expect, it } from "vitest";
import {
  classifyCommandExit,
  formatCommandExitCode,
  formatCommandExitLabel,
} from "@dolssh/shared-core";

describe("classifyCommandExit", () => {
  it("0 과 코드 없음은 성공이다 — 모르는 것을 실패로 칠하지 않는다", () => {
    expect(classifyCommandExit(0)).toBe("ok");
    expect(classifyCommandExit(null)).toBe("ok");
  });

  // 사용자가 Ctrl+C 로 끊은 것(130), pager 를 닫은 것(141), Windows 콘솔의 Ctrl+C.
  it.each([130, 141, -1073741510])("%i 는 실패가 아니라 중단이다", (code) => {
    expect(classifyCommandExit(code)).toBe("interrupted");
  });

  // 일반 오류·없는 명령·실행 권한 없음, 그리고 무언가가 죽인 시그널은 실패로 둔다.
  it.each([1, 2, 126, 127, 137, 143])("%i 는 실패다", (code) => {
    expect(classifyCommandExit(code)).toBe("failed");
  });
});

describe("formatCommandExit*", () => {
  it("Ctrl+C 는 터미널 표기 그대로 ^C, 나머지는 숫자", () => {
    expect(formatCommandExitCode(130)).toBe("^C");
    expect(formatCommandExitCode(-1073741510)).toBe("^C");
    expect(formatCommandExitCode(141)).toBe("141");
    expect(formatCommandExitCode(1)).toBe("1");

    expect(formatCommandExitLabel(130)).toBe("^C");
    expect(formatCommandExitLabel(141)).toBe("exit 141");
    expect(formatCommandExitLabel(127)).toBe("exit 127");
  });
});
