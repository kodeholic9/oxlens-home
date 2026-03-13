# OxLENS HOME

WebRTC 기반 실시간 미디어 시스템 프론트엔드 (oxlens-sfu-server SFU 클라이언트 SDK + UI).

## 프로젝트 구조

```
oxlens-home/ (GitHub: oxlens-home.git)
├── core/                  SDK 코어 모듈 (v0.6.1+)
│   ├── constants.js       공용 상수 (OP, CONN, MUTE, FLOOR, DEVICE_KIND)
│   ├── client.js          OxLensClient Facade (Public API + Mute FSM)
│   ├── signaling.js       WS 시그널링 + Floor Control FSM
│   ├── media-session.js   Publish/Subscribe 2PC + WebRTC
│   ├── device-manager.js  장치 열거/전환/핫플러그 감지
│   ├── telemetry.js       Stats 수집 + 서버 전송
│   ├── sdp-builder.js     Fake remote SDP 조립
│   └── sdp-builder.test.mjs
├── client/                서비스 사용자용 UI
│   ├── index.html         PTT/Conference 클라이언트 UI
│   └── app.js             UI 로직 (SDK 이벤트 구독 기반)
├── admin/                 관리자 대시보드
│   ├── index.html         실시간 텔레메트리 모니터링
│   └── app.js             스냅샷 내보내기 및 관제
├── index.html             0xLENS 통합 랜딩 페이지 (Portal)
├── deploy-oxlens.sh       셸 기반 자동 배포 스크립트 (Patch/Status)
└── README.md
```

## 서버

- **oxlens-sfu-server** — Rust + Tokio + Axum 기반 SFU 서버
- 경로: `D:\X.WORK\GitHub\repository\oxlens-sfu-server\`

## SDK 아키텍처 (v0.6.1)

### 모듈 구조

```
OxLensClient (Facade)
  ├── Signaling        WS 연결 + 패킷 dispatch + Floor 4-state FSM
  ├── MediaSession     Publish/Subscribe 2PC + getUserMedia
  ├── DeviceManager    장치 열거/전환/핫플러그 감지
  └── Telemetry        getStats 수집 + 서버 전송
```

### 장치 관리 (DeviceManager)

- 장치 열거: `enumerateDevices()` 래핑 → `{ audioinput[], audiooutput[], videoinput[] }`
- 입력 전환: `setAudioInput(deviceId)` / `setVideoInput(deviceId)` → `getUserMedia` + `replaceTrack`
- 출력 전환: `setAudioOutput(deviceId)` → `setSinkId()` (등록된 audio element 일괄 적용)
- 핫플러그: `ondevicechange` → 장치 리스트 갱신 + 분리된 장치 자동 fallback

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

### SDK Public API

```js
// 연결
sdk.connect()
sdk.disconnect()

// 방
sdk.listRooms()
sdk.createRoom(name, capacity, mode)
sdk.joinRoom(roomId, enableVideo)
sdk.leaveRoom()

// 미디어
sdk.toggleMute(kind)
sdk.switchCamera()

// 장치
sdk.getDevices(kind?)
sdk.refreshDevices()
sdk.setAudioInput(deviceId)
sdk.setAudioOutput(deviceId)
sdk.setVideoInput(deviceId)
sdk.addOutputElement(el)
sdk.removeOutputElement(el)

// Floor Control (PTT)
sdk.floorRequest()
sdk.floorRelease()
```

### SDK 이벤트

| Event              | 설명                                               |
| ------------------ | -------------------------------------------------- |
| `conn:state`       | 연결 상태 변경                                     |
| `join:phase`       | 입장 단계 (media → signaling)                      |
| `room:joined`      | 방 입장 완료                                       |
| `room:left`        | 방 퇴장                                            |
| `room:event`       | 참가자 입/퇴장                                     |
| `media:local`      | 로컬 스트림 획득                                   |
| `media:track`      | 리모트 트랙 수신                                   |
| `media:ice`        | ICE 연결 상태                                      |
| `media:conn`       | PeerConnection 연결 상태 (ICE+DTLS 통합)           |
| `floor:state`      | Floor FSM 전이 (idle/requesting/talking/listening) |
| `floor:granted`    | 발화권 획득                                        |
| `floor:idle`       | 채널 비어있음                                      |
| `floor:revoke`     | 서버 강제 회수                                     |
| `mute:changed`     | Mute 상태 변경                                     |
| `ptt:escalated`    | PTT hard mute 에스컬레이션                         |
| `track:state`      | 리모트 mute/unmute 브로드캐스트                    |
| `device:changed`   | 장치 전환 완료                                     |
| `device:list`      | 장치 목록 변경 (핫플러그)                          |
| `device:disconnected` | 사용 중 장치 분리 → 기본으로 fallback           |
| `device:error`     | 장치 전환 실패                                     |
| `error`            | 에러                                               |

## 클라이언트 UI 기능

- **연결 상태 배지**: 아이콘 + 색상 (OFF → 연결 중 → READY)
- **방 입장 단계 토스트**: 우측 상단 스택 — 미디어 준비 → 서버 입장 → 미디어 연결 → 완료
- **전원/방참여 버튼**: 활성 시 녹색 glow, 입장 중 노란 펄스
- **상태별 입력 잠금**: 연결 시 서버/ID 비활성, 입장 시 방 선택 비활성
- **컨트롤 잠금**: 1.5초 롱프레스 → 포켓 오작동 방지 (프로그레스 링)
- **장치 선택**: 설정 패널에서 마이크/스피커/카메라 실시간 전환
- **연결/입장 실패 모달**: 닫기 + 재시도

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
5. 설정 패널: 장치 전환 → 즉시 반영 확인
6. 컨트롤 잠금: 1.5초 롱프레스 → 버튼 비활성 확인

---

*author: kodeholic (powered by Claude)*
