---
name: oxlens-home
description: |
  OxLens 웹 클라이언트 SDK + 데모 앱 + 어드민 대시보드 + 랜딩페이지.
  "oxlens-home", "livechat-sdk", "sdp-builder", "telemetry", "어드민",
  "media-session", "signaling", "device-manager", "constants.js",
  "ring buffer", "스냅샷", "Contract 체크" 등의 키워드가 나오면 이 가이드를 참조할 것.
---

# OxLens Home — 프로젝트 지침서

## 1. 프로젝트 개요

- **목적**: OxLens 웹 클라이언트 SDK + 데모/어드민 + 랜딩페이지
- **언어**: Vanilla JavaScript (ES Module), HTML/CSS
- **로컬 경로**: `D:\X.WORK\GitHub\repository\oxlens-home\`
- **npm 스코프**: `@oxlens/livechat-sdk` (core/ 디렉토리)
- **라이선스**: Apache 2.0

---

## 2. 소스 구조

```
oxlens-home/
├── index.html              — 랜딩페이지
├── core/                   — @oxlens/livechat-sdk (웹 클라이언트 SDK)
│   ├── client.js           — OxLensClient (EventEmitter facade)
│   ├── signaling.js        — WS 시그널링 + Floor FSM
│   ├── media-session.js    — Publish/Subscribe PC (2PC)
│   ├── sdp-builder.js      — fake SDP 조립 (2PC / SDP-free)
│   ├── telemetry.js        — 클라이언트 텔레메트리 수집
│   ├── device-manager.js   — 장치 열거/전환/핫플러그
│   ├── constants.js        — OP, CONN, FLOOR, MUTE 상수
│   └── sdp-builder.test.mjs
├── demo/
│   ├── client/             — 데모 클라이언트 앱
│   │   ├── app.js
│   │   ├── index.html
│   │   ├── manifest.json
│   │   └── sw.js
│   └── admin/              — 어드민 대시보드 (6파일 ES module)
│       ├── app.js           — 진입점: WS, dispatch, ring buffer
│       ├── state.js         — 전역 상태 + 유틸 + ring buffer 헬퍼
│       ├── render-overview.js — 방 목록 + 개요 테이블
│       ├── render-detail.js   — 상세패널 + 구간손실 + 타임라인
│       ├── render-panels.js   — SFU 지표 + Contract 체크
│       ├── snapshot.js        — 텍스트 스냅샷 + 클립보드
│       └── index.html
├── docs/                   — 기술문서 (HTML export)
├── claude/                 — Claude 세션 컨텍스트 (AI 전용)
└── deploy-home.sh
```

---

## 3. SDK 아키텍처 (core/)

```
OxLensClient (EventEmitter facade)
├── sig: Signaling         — WS + Floor FSM
├── media: MediaSession    — Publish/Subscribe PC (2PC)
├── tel: Telemetry         — stats 수집 (3초 주기)
└── device: DeviceManager  — 장치 열거/전환/핫플러그
```

### 상수 체계 (constants.js)

- `OP` — 시그널링 opcode
- `CONN` — 연결 상태 (DISCONNECTED/CONNECTING/CONNECTED/IDENTIFIED)
- `FLOOR` — PTT 상태 (IDLE/REQUESTING/TALKING/LISTENING)
- `MUTE` — 뮤트 상태 (UNMUTED/SOFT_MUTED/HARD_MUTED)

### Mute 3-state

- Conference: UNMUTED → SOFT_MUTED → HARD_MUTED (에스컬레이션)
- PTT: 선언적 (floor 상태 + videoOff로 자동 결정)

---

## 4. 어드민 대시보드 (demo/admin/)

### 6파일 모듈 구조

| 파일 | 역할 |
|------|------|
| `state.js` | 전역 상태, ring buffer, 유틸 |
| `app.js` | WS 연결, 메시지 dispatch, 초기화 |
| `render-overview.js` | 방 목록, 개요 테이블 |
| `render-detail.js` | 상세패널, 구간손실, 이벤트 타임라인, SDP |
| `render-panels.js` | SFU 지표, Contract 체크 |
| `snapshot.js` | 텍스트 스냅샷, 클립보드 |

수정 시 해당 모듈만 편집. 전체 파일 덮어쓰기 절대 금지 — edit_file 누적 적용 꼬임 전력 있음.

### Ring Buffer (20개 로테이션)

- user별: `snapshotRing` (pub/sub 핵심 delta, 3초마다)
- SFU: `sfuSnapshotRing` (서버 지표)
- 조회: `getUserSnapshots(userId)` → 최근 20개 배열 (60초 분량)

---

## 5. 작업 원칙

### 코딩 규칙

- `author: kodeholic (powered by Claude)` 명시
- ES Module (`import/export`) 사용
- Vanilla JS — 프레임워크 없음
- 매직 넘버 금지 → `constants.js` 사용

### 파일 수정 주의

- admin 파일 수정 시 **최신본 먼저 확인** (`copy_file_user_to_claude`로 가져와서 확인)
- 전체 파일 덮어쓰기 금지 — 부분 edit만 수행
- CHANGELOG.md, GUIDELINES.md는 채팅창에 코드블록으로 안내 → 부장이 직접 적용

### Android Kotlin SDK와의 관계

- Kotlin SDK(`oxlens-sdk-core/platform/android/oxlens-sdk/`)는 home core/를 미러링
- `Constants.kt` ↔ `constants.js` 동기화 유지
- SDP 빌더, 시그널링 opcode, Floor FSM 로직이 양쪽에 존재
- 한쪽 변경 시 다른 쪽 동기화 필요 여부 확인

---

## 6. CHANGELOG 관리

이 레포의 변경 이력은 `CHANGELOG.md`에서 관리한다.
서버 CHANGELOG(`oxlens-sfu-server/CHANGELOG.md`)에는 서버 코드 변경만 기록.

- 서버 + 클라이언트에 걸친 변경: 각 레포 CHANGELOG에 자기 측 변경만 기록
- 텔레메트리처럼 양쪽 관련된 기능은 양쪽 CHANGELOG에 각각 기록하되, 상대 레포 변경 언급

---

## 7. 세션 컨텍스트 관리

### claude/ 디렉토리

`claude/` 디렉토리는 **Claude 세션 간 컨텍스트 유지용** 파일 전용이다.
사람이 읽을 문서(`docs/`)와 구분하여, AI 어시스턴트가 소비하는 파일만 이곳에 둔다.

```
claude/
├── SESSION_CONTEXT_YYYYMMDD.md      — 세션별 작업 기록
├── SESSION_CONTEXT_YYYYMMDD_xxx.md  — 같은 날 복수 세션 시 접미사 구분
└── SESSION_INDEX.md                 — 전체 세션 이력 인덱스 (선택)
```

### 새 세션 시작 프로토콜

1. `claude/` 디렉토리 확인 → 가장 최신 `SESSION_CONTEXT_*.md` 읽기
2. `SESSION_INDEX.md`가 있으면 인덱스 먼저 읽어 전체 흐름 파악
3. "다음 세션 작업" 섹션을 기준으로 작업 시작

### 세션 종료 시 컨텍스트 저장

```markdown
# 세션 컨텍스트 — YYYY-MM-DD (제목)

> 한 줄 요약

## 이번 세션 완료 작업
## 현재 상태
## 변경된 파일
## 다음 세션 작업
## 기술 메모 (필요 시)
## 주의사항 (다음 세션 Claude에게)
```

### 레포 간 세션 컨텍스트

- 서버 작업 → `oxlens-sfu-server/claude/`에 저장
- SDK/Android 작업 → `oxlens-sdk-core/claude/`에 저장
- Home(JS SDK/어드민) 작업 → `oxlens-home/claude/`에 저장
- 복수 레포에 걸친 작업은 **주 작업 레포**에 저장하되, 타 레포 변경사항도 명시

### 토큰 효율

- 세션 시작: 컨텍스트 파일만 로드 (소스는 on-demand)
- admin 6파일 전체 로드 금지 — 수정 대상 파일만 읽기
- 불필요한 과거 세션 파일 로드 금지

---

## 8. 알려진 이슈

- subscribe 트랙 누락: 5인 테스트에서 후입장자의 subscribe에 기존 참가자 누락 (원인 미확정)
- NACK hit rate: `rtx_sent / nack_received`는 BLP 때문에 100% 초과 가능
- delta 미지원 클라이언트 방어 미구현

---

*author: kodeholic (powered by Claude)*
