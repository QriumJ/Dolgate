package http

// WaitersForTest 는 지금 걸려 있는 GET /sync/watch 대기 수다. 외부 테스트(http_test)가 대기가
// 실제로 걸린 뒤에 push 하도록 기다리는 데 쓴다. 테스트 빌드에만 있다.
func (h *SyncWatchHub) WaitersForTest() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	total := 0
	for _, entry := range h.users {
		total += entry.waiters
	}
	return total
}
