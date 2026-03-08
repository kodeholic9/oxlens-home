# OxLENS HOME

WebRTC 기반 실시간 미디어 시스템 프론트엔드 (oxlens-sfu-server SFU 클라이언트 SDK + UI).

## 프로젝트 구조

```
oxlens-home/ (GitHub: oxlens-home.git)
├── common/                SDK 코어 모듈 (v0.6.0+)
│   ├── constants.js       공용 상수 (OP, CONN, MUTE, FLOOR)
│   ├── livechat-sdk.js    SDK Facade (Public API + Mute FSM)
│   ├── signaling.js       WS 시그널링 + Floor Control FSM
│   ├── media-session.js   Publish/Subscribe 2PC + WebRTC
│   ├── telemetry.js       Stats 수집 + 서버 전송
│   ├── sdp-builder.js     Fake remote SDP 조립
│   └── sdp-builder.test.mjs
├── client/                [구 livechat-client] 서비스 사용자용 UI
│   ├── index.html         PTT/Conference 클라이언트 UI
│   └── app.js             UI 로직 (SDK 이벤트 구독 기반)
├── admin/                 [구 livechat-admin] 관리자 대시보드
│   ├── index.html         실시간 텔레메트리 모니터링
│   └── app.js             스냅샷 내보내기 및 관제
├── index.html             0xLENS 통합 랜딩 페이지 (Portal)
├── deploy-oxlens.sh       셸 기반 자동 배포 스크립트 (Patch/Status)
└── README.md
```

## 서버

- **oxlens-sfu=server** — Rust + Tokio + Axum 기반 SFU 서버
- 경로: `D:\X.WORK\GitHub\repository\oxlens-sfu-server\`

## SDK 아키텍처 (v0.6.0)

### 모듈 구조

```
LiveChatSDK (Facade)
  ├── Signaling        WS 연결 + 패킷 dispatch + Floor 4-state FSM
  ├── MediaSession     Publish/Subscribe 2PC + getUserMedia
  └── Telemetry        getStats 수집 + 서버 전송
```

### Mute 제어 이원화

| 모드       | audio 소유          | video 소유          | 방식                                |
| ---------- | ------------------- | ------------------- | ----------------------------------- |
| Conference | Conference Mute FSM | Conference Mute FSM | 3-state (UNMUTED → SOFT → HARD)     |
| PTT        | Floor (SDK 자동)    | 사용자 toggle 허용  | 선언적 계산 (`_applyPttMediaState`) |

**PTT 선언적 모델:**

```
변수 2개:
  floor === TALKING?     ← 서버 결정
  _userVideoOff?         ← 사용자 toggle

_applyPttMediaState() 매번 계산:
  audio = talking
  video = talking && !videoOff

트랙 상태 3-state:
  "live" → "soft_off" → (60s) → "hard_off"
```

### 프로토콜

```
Client → Server: { op, pid, d }
Server → Client: { op, pid, ok: true/false, d }   (응답)
Server → Client: { op, pid, d }                    (이벤트)
```

### SDK 이벤트

| Event           | 설명                                               |
| --------------- | -------------------------------------------------- |
| `conn:state`    | 연결 상태 변경                                     |
| `room:joined`   | 방 입장 완료                                       |
| `room:left`     | 방 퇴장                                            |
| `room:event`    | 참가자 입/퇴장                                     |
| `media:local`   | 로컬 스트림 획득                                   |
| `media:track`   | 리모트 트랙 수신                                   |
| `media:ice`     | ICE 연결 상태                                      |
| `floor:state`   | Floor FSM 전이 (idle/requesting/talking/listening) |
| `floor:granted` | 발화권 획득                                        |
| `floor:idle`    | 채널 비어있음                                      |
| `floor:revoke`  | 서버 강제 회수                                     |
| `mute:changed`  | Mute 상태 변경                                     |
| `ptt:escalated` | PTT hard mute 에스컬레이션                         |
| `track:state`   | 리모트 mute/unmute 브로드캐스트                    |
| `error`         | 에러                                               |

## 실행

```bash
# oxlens-sfu-server 서버 실행
cd oxlens-sfu-server
RUST_LOG=debug cargo run

```

## 테스트 (2탭)

1. 탭 A: 연결 → 방 입장
2. 탭 B: 연결 → 같은 방 입장
3. 양쪽에서 상대방 타일 확인 + 오디오/비디오 확인
4. PTT 방: 화면 길게 눌러 발화 → 발화 종료 후 자동 mute 확인
