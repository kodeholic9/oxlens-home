// author: kodeholic (powered by Claude)
// constants.js — Light LiveChat SDK 공용 상수
//
// 여러 모듈(signaling, media-session, telemetry, livechat-sdk)이 공유하는 상수.
// 순환 의존 방지를 위해 독립 파일로 분리.

export const SDK_VERSION = "0.7.0";

// ============================================================
//  Opcodes — light-livechat signaling protocol (2PC/SDP-free)
// ============================================================
export const OP = Object.freeze({
  // Server → Client (Event)
  HELLO: 0,

  // Client → Server (Request)
  HEARTBEAT: 1,
  IDENTIFY: 3,
  ROOM_LIST: 9,
  ROOM_CREATE: 10,
  ROOM_JOIN: 11,
  ROOM_LEAVE: 12,
  PUBLISH_TRACKS: 15,
  TRACKS_ACK: 16,       // subscribe SSRC 확인 응답
  MUTE_UPDATE: 17,
  CAMERA_READY: 18,     // 카메라 웜업 완료 (첫 프레임 → PLI 트리거)
  MESSAGE: 20,
  TELEMETRY: 30,

  // Floor Control (MCPTT/MBCP)
  FLOOR_REQUEST: 40,
  FLOOR_RELEASE: 41,
  FLOOR_PING: 42,

  // Polling & Simulcast
  ROOM_SYNC: 50,             // 참여자+트랙+floor 전체 동기화
  SUBSCRIBE_LAYER: 51,       // Simulcast 레이어 선택

  // Server → Client (Event)
  ROOM_EVENT: 100,
  TRACKS_UPDATE: 101,
  TRACK_STATE: 102,
  MESSAGE_EVENT: 103,
  VIDEO_SUSPENDED: 104,  // 비디오 중단 (카메라 off) — UI avatar 전환
  VIDEO_RESUMED: 105,    // 비디오 재개 (카메라 on) — UI 복원
  TRACKS_RESYNC: 106,    // 트랙 전체 재동기화 (TRACKS_ACK 불일치 시)

  // Floor Control Events
  FLOOR_TAKEN: 141,
  FLOOR_IDLE: 142,
  FLOOR_REVOKE: 143,
});

// ============================================================
//  Connection 상태
// ============================================================
export const CONN = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  IDENTIFIED: "identified",
});

// ============================================================
//  Floor Participant 상태 (MCPTT/MBCP §6.2.4 기반 4-state)
//
//  MBCP §6.2.4 매핑:
//    IDLE + LISTENING = "U: has no permission"
//    REQUESTING       = "U: pending Request"
//    TALKING          = "U: has permission"
//  MBCP "U: pending Release" → WS 기반 즉시 응답으로 생략
//  MBCP "U: queued"          → 큐 미지원, 의도적 생략
// ============================================================
export const FLOOR = Object.freeze({
  IDLE: "idle", // 아무도 안 말함, PTT 가능
  REQUESTING: "requesting", // PTT 눌림, 서버 응답 대기
  TALKING: "talking", // 내가 발화 중
  LISTENING: "listening", // 타인 발화 중, PTT 가능(deny 될 수 있음)
});

// ============================================================
//  Mute 3-state (에스컬레이션 뮤트 상태 머신)
// ============================================================
export const MUTE = Object.freeze({
  UNMUTED: "unmuted",
  SOFT_MUTED: "soft_muted",
  HARD_MUTED: "hard_muted",
});

// ============================================================
//  Timing 상수
// ============================================================
export const FLOOR_PING_MS = 2000;
export const MUTE_ESCALATION_MS = 5000;

// ============================================================
//  DeviceManager 이벤트
// ============================================================
export const DEVICE_KIND = Object.freeze({
  AUDIO_INPUT: "audioinput",
  AUDIO_OUTPUT: "audiooutput",
  VIDEO_INPUT: "videoinput",
});
