# Changelog — oxlens-home

All notable changes to this project will be documented in this file.

> JS SDK (core/) + 데모 클라이언트 (demo/client/) + 어드민 대시보드 (demo/admin/)

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.6.0] - 2026-03-21

### Added (Floor v2 + Telemetry Power Stats)

#### Floor Control v2 클라이언트 연동

- 5-state FSM: QUEUED 상태 추가 (IDLE/REQUESTING/QUEUED/TALKING/LISTENING)
- `FLOOR_QUEUE_POS` (op=43) opcode + signaling dispatch
- `floorRequest(priority)` — 우선순위 파라미터 지원 (0~255, 기본 0)
- `floorQueuePos()` — 큐 위치 조회 API
- QUEUED UI: requesting 화면 재활용 + position 표시 + QUEUED 배지
- 긴급발언(ptt-lock) priority=10 전송 → preemption 가능
- Zello race defense 확장: REQUESTING/QUEUED 중 PTT 럀 → 자동 release
- preempted revoke 토스트 메시지

#### Telemetry Power State 메트릭

- `powerStats` 버킷: power state별 (hot/hot_standby/warm/cold) 패킷 통계
  - publish: audio.sent, video.sent, video.kfSent
  - subscribe: audio.recv, video.recv, video.kfRecv
- `ptt_power_change` 이벤트 타임라인 기록 (from/to/ts)
- `keyFramesEncodedDelta` (publish), `keyFramesDecodedDelta` (subscribe) 추가
- 3초 윈도우 flush → 어드민 PTT 진단 패널에서 확인 가능

### Changed

- `core/ptt/floor-fsm.js` 전면 재작성 (4-state → 5-state)
- `core/telemetry.js` 전면 재작성 (powerStats 버킷 + kf delta 추가)
- `demo/client/index.html` ptt-req-label 클래스 추가

---

## [0.5.6] - 2026-03-14

### Changed (admin 리팩토링 + ring buffer + 경로 이동)

#### admin 6파일 ES module 분리

- 기존 `admin/app.js` 1785줄 → 6개 모듈로 분리
- state.js(110), app.js(420), render-overview.js(186), render-detail.js(521), render-panels.js(340), snapshot.js(303)
- 코덱 섹션 `label` 미선언 버그 수정
- `resetAllState()` 함수로 서버 URL 변경 시 전체 초기화

#### 20개 로테이션 ring buffer

- user별 `snapshotRing` + SFU `sfuSnapshotRing` (크기 20, 60초 분량)
- pub/sub 핵심 delta를 3초마다 저장
- `getUserSnapshots(userId)` / `getSfuSnapshots()` 조회 API

#### 경로 이동

- `client/`, `admin/` → `demo/` 하위로 이동
- 상대경로 수정 6곳

### Added

- `LICENSE` (Apache 2.0, Copyright 2026 Tae Goo Kang)

## [0.5.5] - 2026-03-13

### Added (델타 기반 메트릭 + 통합 타임라인)

#### core/telemetry.js

- publish outbound: `packetsSentDelta`, `retransmittedPacketsSentDelta`, `nackCountDelta`
- subscribe inbound: `packetsReceivedDelta`, `packetsLostDelta`, `lossRateDelta`, `nackCountDelta`

#### demo/admin/ (당시 admin/)

- 개요 테이블: 세션 경과 시간, delta 기반 packets/손실율 표시
- 구간 손실: 누적값 → 델타 기반 전면 교체, NACK hit rate 추가
- 통합 타임라인: CLI + SFU 이벤트 ts 기준 병합, 상대 시간 표시
- 스냅샷: SESSION INFO, delta 필드, UNIFIED TIMELINE 섹션 추가

## [0.5.4] - 2026-03-11

### Added (Phase T-6: 인코더 심층 진단 + 구간별 손실 + 이벤트 타임라인)

#### core/telemetry.js

- 구간 A 수집 확장: framesSent, hugeFramesSent, totalEncodeTime, qualityLimitationDurations delta
- 이벤트 타임라인: _eventLog 링버퍼(50개), _detectPublishEvents(6종), _detectSubscribeEvents(5종)

#### demo/admin/

- 참가자 상세: enc-sent gap, huge, enc time, qld delta 표시
- 구간별 손실 Cross-Reference (pub.packetsSent vs sub 매칭)
- 이벤트 타임라인 표시 (아이콘 + 색상 + 시간)
- Contract 체크: encoder_bottleneck 추가
- 스냅샷: PUBLISH enc 진단, LOSS CROSS-REFERENCE, EVENT TIMELINE 섹션

---

*이전 버전 이력은 oxlens-sfu-server CHANGELOG.md v0.5.3 이하 참조 (당시 서버+클라이언트 통합 관리)*

---

*author: kodeholic (powered by Claude)*
