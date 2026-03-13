# SESSION_CONTEXT — 2026-03-14

## 이번 세션(0314)에서 완료한 작업

### 1. admin/app.js 리팩토링 (6파일 ES module 분리)

기존 1785줄 단일 파일 → 6개 모듈로 분리. `index.html`은 이미 `type="module"` 사용 중이라 변경 불필요.

| 파일 | 줄수 | 역할 |
|------|------|------|
| `state.js` | 110 | 전역 상태 + 유틸 + ring buffer 헬퍼 |
| `app.js` | 420 | 진입점: WS연결, 메시지dispatch, ring buffer push, 리사이즈, 초기화 |
| `render-overview.js` | 186 | 방 목록 + 개요 테이블 |
| `render-detail.js` | 521 | 상세패널 + 구간손실 + 타임라인 + SDP + 이벤트헬퍼 |
| `render-panels.js` | 340 | SFU 지표 + Contract 체크 |
| `snapshot.js` | 303 | 텍스트 스냅샷 빌더 + 클립보드 |

- 공유 상태: `state.js`에서 export, let 바인딩은 setter 함수 제공
- 코덱 섹션 `label` 미선언 버그 수정 (`render-detail.js`)
- `resetAllState()` 함수로 서버 URL 변경 시 전체 초기화

### 2. 20개 로테이션 ring buffer

- `state.js`: `snapshotRing` (user별 Map), `sfuSnapshotRing` (SFU), 크기 20 (60초 분량)
- `app.js handleClientTelemetry()`: 3초마다 수신 시 pub/sub 핵심 delta를 `pushUserSnapshot()`
- `app.js handleAdminMessage("server_metrics")`: SFU 지표를 `pushSfuSnapshot()`
- 조회: `getUserSnapshots(userId)` → 최근 20개 배열
- user별 저장 항목: ts, pub(kind/ssrc/pktsDelta/bitrate/nackDelta/retxDelta/fps), pubNet(rtt/bw), sub(kind/ssrc/src/recvDelta/lostDelta/lossRate/jitter/jbDelay/nackDelta/fps/freeze)
- SFU 저장 항목: ts, nack_received, rtx_sent, pli_sent, egress_drop, decrypt, egress_encrypt, tokio_busy

### 3. 경로 이동: client/, admin/ → demo/ 하위

```
oxlens-home/
├── demo/
│   ├── admin/   (6개 JS + index.html)
│   └── client/  (app.js + index.html + img/ + manifest.json + sw.js)
├── core/
├── ...
```

상대경로 수정 6곳:
- `demo/client/app.js`: `../core/` → `../../core/`
- `demo/client/index.html`: `../index.html` → `../../index.html`
- `demo/admin/index.html`: `../index.html` → `../../index.html`
- `index.html` (루트): `./client/` → `./demo/client/` (desktop nav + mobile nav, 4곳)

### 4. 기타

- `index.html` Start Free Trial 버튼 → `./demo/client/index.html` 링크 연결
- LICENSE 추가 (Apache 2.0, Copyright 2026 Tae Goo Kang, 한글 안내 포함)
- 서버 LICENSE 연도 수정: `2024-2026` → `2026`, `(kodeholic)` 표기 추가

---

## 이전 세션(0313)에서 완료한 작업

### 목표
클라이언트 메트릭 강화 — delta 계산 추가, 구간 손실 분리, 통합 타임라인, NACK hit rate

### 완료 (3개 파일)

#### 1. oxlens-sfu-server — handler.rs
- `build_rooms_snapshot()`: participant에 `joined_at`, room에 `created_at` 추가
- snapshot 루트에 `"ts": current_ts()` 추가
- 변경 경로: `src/signaling/handler.rs`

#### 2. oxlens-sfu-server — metrics/mod.rs
- `flush()` 최종 JSON에 `"ts": SystemTime millis` 추가
- 변경 경로: `src/metrics/mod.rs`

#### 3. oxlens-home — core/telemetry.js
publish outbound 추가 필드:
- `packetsSentDelta` — 3초 delta
- `retransmittedPacketsSentDelta` — 3초 delta
- `nackCountDelta` — 3초 delta (내가 받은 NACK)

subscribe inbound 추가 필드:
- `packetsReceivedDelta` — 3초 delta
- `packetsLostDelta` — 3초 delta
- `lossRateDelta` — delta 기반 손실율 (0.0~100.0, 소수점1자리)
- `nackCountDelta` — 3초 delta (내가 보낸 NACK)

`_prevStats.pub` 키 네이밍: `pkt_${ssrc}`, `rtx_${ssrc}`, `nack_${ssrc}`
`_prevStats.sub` 키 네이밍: `recv_${ssrc}`, `lost_${ssrc}`, `nack_${ssrc}`

#### 4. oxlens-home — admin/app.js (통째 덮어쓰기로 적용)

**새 전역 상태:**
```js
const joinedAtMap = new Map();      // user_id → joined_at ms
const roomCreatedAtMap = new Map(); // room_id → created_at ms
const SERVER_EVENT_MAX = 100;
const serverEventLog = [];          // { ts, type, count, ... }
```

**snapshot 처리:**
- `joined_at` → `joinedAtMap`, `created_at` → `roomCreatedAtMap` 저장

**server_metrics 처리:**
- pli_sent, nack_received, rtx_sent, egress_drop, enc/dec_fail, ptt 이벤트 → `serverEventLog` 기록

**개요 테이블 (renderOverview):**
- user 셀에 세션 경과 시간 표시 (회색 소자)
- packets 컬럼: `packetsSentDelta/3s`, `packetsReceivedDelta/3s`
- 손실율: `lossRateDelta` 우선, 없으면 누적 fallback, `△` 표시

**상세 패널 (renderDetail):**
- 상단에 입장 시각 + 경과 시간 블록 추가

**구간 손실 (renderLossCrossRef):**
- 누적값 기반 → 델타 기반으로 전면 교체
- A→SFU 손실율, SFU→B 손실율 분리
- NACK hit rate 추가: `sfu.rtx_sent / sfu.nack_received`
- 색상: hit <50% 빨강, <80% 노랑, ≥80% 초록

**통합 타임라인 (renderEventTimeline):**
- CLI 이벤트 + SFU 이벤트 ts 기준 병합
- 상대 시간 표시 (`+1m23s` 형식, joined_at 기준)
- SFU/CLI 배지로 출처 구분
- SFU 이벤트 헬퍼 3개 추가: `sfuEventIcon`, `sfuEventColorClass`, `sfuEventDescription`

**fmtElapsed 유틸 추가:**
```js
fmtElapsed(ms) // ms → "1h23m" / "45m12s" / "42s"
```

**buildSnapshot (스냅샷 export):**
- `--- SESSION INFO ---` 섹션 추가 (joined_at ISO, elapsed)
- PUBLISH: `pkts_delta`, `nack_delta`, `retx_delta` 추가
- SUBSCRIBE: `recv_delta`, `lost_delta`, `loss_rate▲`, `nack_delta` 추가
- `--- EVENT TIMELINE ---` → `--- UNIFIED TIMELINE ---` (CLI+SFU 병합, ts순)
- LOSS CROSS-REFERENCE: 누적값 → delta 기반, NACK hit rate 포함

---

## 다음 세션 우선순위

### Priority 1 — subscribe 트랙 누락 원인 추적 인프라

5인 Conference 테스트에서 일부 참가자의 subscribe에 기존 참가자가 누락되는 현상 확인됨.
근본 원인 파악을 위해 아래 두 가지 추가 필요:

**A. 서버 ROOM_JOIN 응답 로그 강화 (handler.rs)**
- `handle_room_join`에서 응답 시, existing_tracks에 포함된 user별 트랙 수를 info 로그로 출력
- 형식: `ROOM_JOIN user=U633 room=xxx existing_tracks=6 from=[U411(2), U085(2), U953(2)]`
- 이것만 있으면 "서버가 누락해서 안 보낸 건지, 클라이언트가 못 받은 건지" 즉시 판별

**B. 클라이언트 telemetry에 subscribe 트랙 카운트 추가 (telemetry.js)**
- stats 보고 시 `_subscribeTracks` 배열의 active/inactive 수를 포함
- 형식: `subTracks: { total: 6, active: 4, inactive: 2 }`
- 어드민 패널에서 "방에 4명인데 active가 2" → 즉시 이상 감지 가능
- telemetry는 home(어드민) 에서 관리

### Priority 2 — NACK hit rate 계산식 개선

현재 `rtx_sent / nack_received`는 100% 초과 가능 (Generic NACK의 BLP 비트마스크 때문).
- 대안 A: `rtx_miss == 0 → 100%`, 아니면 `rtx_sent / (rtx_sent + rtx_miss)`
- 대안 B: 100% 캡

### Priority 3 — delta 미지원 클라이언트 방어

delta 필드가 없는 구버전 클라이언트가 섞이면 LOSS CROSS-REFERENCE에서 `pub_delta=0 → A→SFU=100%` 오판 발생.
- pub_delta=0이고 누적 packetsSent>0이면 "N/A (delta 미지원)" 표시

### Priority 4 — oxlens-sdk-core 통합
`OxLensClient` 통합 (`media_mut()`, pre-join track 추가 구조)
이전 세션 컨텍스트: `D:\X.WORK\GitHub\repository\oxlens-sdk-core`

### 백로그
- IDENTIFY 토큰 검증 (서버)
- STATS_REQUEST / STATS_REPORT 시그널링 스키마 구현
- ring buffer 데이터를 활용한 sparkline 미니 차트 (render-detail.js)
- ROOM_SYNC opcode (subscribe 불일치 시 수동/자동 동기화) — Priority 1 원인 파악 후 결정

---

## 주의사항 (다음 세션 Claude에게)

1. **admin은 6파일 모듈 구조** — `demo/admin/` 하위에 `app.js`, `state.js`, `render-overview.js`, `render-detail.js`, `render-panels.js`, `snapshot.js`. 수정 시 해당 모듈만 편집.

2. **admin 파일 수정 시 최신본 먼저 확인** — `copy_file_user_to_claude`로 최신본 가져와서 확인 후 작업. 이전 세션에서 edit_file 누적 적용 꼬인 전력 있음.

3. **telemetry.js `_prevStats` 키 현황** — pub Map: `pub_${ssrc}`(bytes), `pkt_${ssrc}`, `rtx_${ssrc}`, `nack_${ssrc}`. sub Map: `sub_${ssrc}`(bytes), `recv_${ssrc}`, `lost_${ssrc}`, `nack_${ssrc}`. jb Map: `jb_${ssrc}`. qld Map: `qld_${ssrc}`. 중복 없음.

4. **NACK hit rate 한계** — `sfu.rtx_sent / sfu.nack_received`는 방 전체 집계값. user별 귀속 불가. BLP 때문에 100% 초과 가능.

5. **subscribe 트랙 누락 현상** — 5인 테스트에서 후입장자(U633/U398)의 subscribe에 기존 참가자(U411) 누락 확인. 브라우저 새로고침 후 재참여 상황. inactive mid 슬롯 누적 패턴도 관찰됨. 원인 미확정 — Priority 1에서 로그 인프라 추가 후 재현 필요.

6. **경로 변경 반영** — `client/`, `admin/`은 `demo/` 하위로 이동됨. `core/`는 루트에 그대로.

---

*author: kodeholic (powered by Claude) — 2026-03-14*