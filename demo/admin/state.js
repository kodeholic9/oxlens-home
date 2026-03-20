// author: kodeholic (powered by Claude)
// admin/state.js — 전역 상태 + 공용 유틸리티
// 모든 모듈이 이 파일에서 상태를 import한다.

// ============================================================
//  DOM 헬퍼
// ============================================================
export const $ = (id) => document.getElementById(id);

// ============================================================
//  전역 상태
// ============================================================

// snapshot / telemetry
export let roomsSnapshot = [];
export const latestTelemetry = new Map();
export const sdpTelemetry = new Map();
export let selectedRoom = null;
export let selectedUser = null;
export let latestServerMetrics = null;

// 시계열 버퍼
export const MAX_HISTORY = 100;
export const telemetryHistory = new Map();
export const sfuHistory = [];

// 스냅샷 로테이션 ring buffer (최근 20개)
export const SNAPSHOT_RING_SIZE = 20;
export const snapshotRing = new Map(); // user_id → { ring: [], cursor: 0 }
export const sfuSnapshotRing = [];     // server_metrics ring

// 이벤트 타임라인 버퍼
export const EVENT_HISTORY_MAX = 50;
export const eventHistory = new Map();

// 참가자 / 방 시각
export const joinedAtMap = new Map();
export const roomCreatedAtMap = new Map();

// server_metrics 이벤트 타임라인
export const SERVER_EVENT_MAX = 100;
export const serverEventLog = [];

// pipeline stats ring buffer (per-participant, counter 누적 → delta 계산)
// key: "room_id:user_id", value: { ring: [{ts, ...counters}], prev: {...} }
export const pipelineRing = new Map();

// ============================================================
//  상태 변경 함수 (let 바인딩은 직접 export 재할당 불가이므로 setter 제공)
// ============================================================
export function setRoomsSnapshot(v) { roomsSnapshot = v; }
export function setSelectedRoom(v) { selectedRoom = v; }
export function setSelectedUser(v) { selectedUser = v; }
export function setLatestServerMetrics(v) { latestServerMetrics = v; }

// ============================================================
//  유틸리티
// ============================================================

/** 경과 시간 포맷: ms → "1h23m", "45m12s", "3m05s", "42s" */
export function fmtElapsed(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

// ============================================================
//  Ring Buffer 헬퍼
// ============================================================

/** user별 telemetry 스냅샷을 ring buffer에 push */
export function pushUserSnapshot(userId, entry) {
  if (!snapshotRing.has(userId)) {
    snapshotRing.set(userId, []);
  }
  const ring = snapshotRing.get(userId);
  ring.push(entry);
  while (ring.length > SNAPSHOT_RING_SIZE) ring.shift();
}

/** SFU server_metrics를 ring buffer에 push */
export function pushSfuSnapshot(entry) {
  sfuSnapshotRing.push(entry);
  while (sfuSnapshotRing.length > SNAPSHOT_RING_SIZE) sfuSnapshotRing.shift();
}

/** user별 ring buffer 조회 (최신 N개) */
export function getUserSnapshots(userId) {
  return snapshotRing.get(userId) || [];
}

// ============================================================
//  전체 상태 초기화 (서버 URL 변경 시)
// ============================================================
export function resetAllState() {
  roomsSnapshot = [];
  latestTelemetry.clear();
  sdpTelemetry.clear();
  telemetryHistory.clear();
  eventHistory.clear();
  sfuHistory.length = 0;
  snapshotRing.clear();
  sfuSnapshotRing.length = 0;
  selectedRoom = null;
  selectedUser = null;
  latestServerMetrics = null;
  joinedAtMap.clear();
  roomCreatedAtMap.clear();
  serverEventLog.length = 0;
  pipelineRing.clear();
}
