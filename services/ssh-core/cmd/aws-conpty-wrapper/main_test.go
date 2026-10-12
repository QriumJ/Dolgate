//go:build windows

package main

import (
	"slices"
	"testing"
)

// --utf8-console 은 띄울 명령 앞에 올 때만 래퍼 옵션이다. 명령 뒤의 인자는 전부 그 명령의 몫이다.
func TestParseArgsReadsUTF8ConsoleOnlyBeforeCommand(t *testing.T) {
	config, err := parseArgs([]string{"--utf8-console", `C:\pwsh.exe`, "-NoLogo"})
	if err != nil {
		t.Fatalf("parseArgs 실패: %v", err)
	}
	if !config.utf8Console {
		t.Error("--utf8-console 을 읽지 않았다")
	}
	if want := []string{`C:\pwsh.exe`, "-NoLogo"}; !slices.Equal(config.command, want) {
		t.Errorf("command = %q, want %q", config.command, want)
	}

	config, err = parseArgs([]string{`C:\powershell.exe`, "--utf8-console"})
	if err != nil {
		t.Fatalf("parseArgs 실패: %v", err)
	}
	if config.utf8Console {
		t.Error("명령의 인자로 넘긴 --utf8-console 을 래퍼 옵션으로 읽었다")
	}
	if want := []string{`C:\powershell.exe`, "--utf8-console"}; !slices.Equal(config.command, want) {
		t.Errorf("command = %q, want %q", config.command, want)
	}
}
