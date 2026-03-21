// author: kodeholic (powered by Claude)
// ptt/floor-fsm.js — Floor Control 5-state FSM (MCPTT/MBCP §6.2.4 + Queue)
//
// 책임:
//   - Floor 5-state 상태 머신 (IDLE → REQUESTING → TALKING/QUEUED ↔ LISTENING)
//   - Floor PING 타이머 (발화 중 2초 주기)
//   - QUEUED 상태 (큐 대기) — release로 취소, queue pop으로 granted 전이
//   - Zello race defense (REQUESTING 중 PTT 뗌)
//   - signaling raw 이벤트 수신 → 상태 전이 → app 이벤트 발신
//
// 수신 이벤트 (signaling.js raw):
//   _floor:taken_raw, _floor:idle_raw, _floor:revoke_raw,
//   _floor:granted_raw, _floor:denied_raw, _floor:queued_raw
//
// 발신 이벤트 (app/power-fsm 용):
//   floor:state, floor:granted, floor:taken, floor:idle,
//   floor:revoke, floor:denied, floor:released, floor:pending, floor:queued

import { OP, FLOOR, FLOOR_PING_MS } from "../constants.js";

export class FloorFsm {
  constructor(sdk) {
    this.sdk = sdk;

    this._state = FLOOR.IDLE;
    this._speaker = null;
    this._pendingCancel = false;
    this._pingTimer = null;

    // Queue 상태 (QUEUED 상태일 때만 유효)
    this._queuePosition = 0;
    this._queuePriority = 0;

    // detach 시 해제할 이벤트 핸들러 참조
    this._handlers = {};
  }

  // ── Getters ──

  get state() { return this._state; }
  get speaker() { return this._speaker; }
  get queuePosition() { return this._queuePosition; }
  get queuePriority() { return this._queuePriority; }

  // ── 라이프사이클 ──

  attach() {
    this._handlers = {
      taken:   (d) => this._onFloorTaken(d),
      idle:    (d) => this._onFloorIdle(d),
      revoke:  (d) => this._onFloorRevoke(d),
      granted: (d) => this._onFloorGranted(d),
      denied:  (d) => this._onFloorDenied(d),
      queued:  (d) => this._onFloorQueued(d),
    };

    this.sdk.on("_floor:taken_raw",   this._handlers.taken);
    this.sdk.on("_floor:idle_raw",    this._handlers.idle);
    this.sdk.on("_floor:revoke_raw",  this._handlers.revoke);
    this.sdk.on("_floor:granted_raw", this._handlers.granted);
    this.sdk.on("_floor:denied_raw",  this._handlers.denied);
    this.sdk.on("_floor:queued_raw",  this._handlers.queued);
  }

  detach() {
    this._stopPing();

    this.sdk.off("_floor:taken_raw",   this._handlers.taken);
    this.sdk.off("_floor:idle_raw",    this._handlers.idle);
    this.sdk.off("_floor:revoke_raw",  this._handlers.revoke);
    this.sdk.off("_floor:granted_raw", this._handlers.granted);
    this.sdk.off("_floor:denied_raw",  this._handlers.denied);
    this.sdk.off("_floor:queued_raw",  this._handlers.queued);
    this._handlers = {};

    this._state = FLOOR.IDLE;
    this._speaker = null;
    this._pendingCancel = false;
    this._queuePosition = 0;
    this._queuePriority = 0;
  }

  // ── Public API ──

  /**
   * 발화권 요청 (PTT 누름)
   * IDLE 또는 LISTENING에서만 요청 가능
   * @param {number} priority - 우선순위 0~255 (기본 0)
   */
  request(priority = 0) {
    const roomId = this.sdk._roomId;
    if (!roomId) return;
    if (this._state === FLOOR.TALKING || this._state === FLOOR.REQUESTING || this._state === FLOOR.QUEUED) return;

    this._pendingCancel = false;
    this._setState(FLOOR.REQUESTING);
    this.sdk.sig.send(OP.FLOOR_REQUEST, { room_id: roomId, priority });
    this.sdk.emit("floor:pending");
  }

  /**
   * 발화권 해제 (PTT 뗌)
   */
  release() {
    const roomId = this.sdk._roomId;
    if (!roomId) return;

    if (this._state === FLOOR.REQUESTING) {
      // Zello race defense: 서버 응답 전에 PTT 뗌
      this._pendingCancel = true;
      this.sdk.sig.send(OP.FLOOR_RELEASE, { room_id: roomId });
      this._setState(this._speaker ? FLOOR.LISTENING : FLOOR.IDLE);
      this.sdk.emit("floor:released");
      console.log("[FLOOR] release (pending cancel — Zello race defense)");
      return;
    }

    if (this._state === FLOOR.QUEUED) {
      // 큐 대기 중 PTT 뗌 → 큐 취소
      this._queuePosition = 0;
      this._queuePriority = 0;
      this.sdk.sig.send(OP.FLOOR_RELEASE, { room_id: roomId });
      this._setState(this._speaker ? FLOOR.LISTENING : FLOOR.IDLE);
      this.sdk.emit("floor:released");
      console.log("[FLOOR] release (queue cancel)");
      return;
    }

    if (this._state === FLOOR.TALKING) {
      this._stopPing();
      this._speaker = null;
      this.sdk.sig.send(OP.FLOOR_RELEASE, { room_id: roomId });
      this._setState(FLOOR.IDLE);
      this.sdk.emit("floor:released");
    }
  }

  // ── Raw 이벤트 핸들러 ──

  /** Floor Request → Granted 응답 (직접 grant 또는 queue pop) */
  _onFloorGranted(d) {
    if (!d.granted) return;

    // Zello race defense: Granted 도착했지만 이미 사용자가 PTT 뗌
    if (this._pendingCancel) {
      console.log("[FLOOR] granted arrived but pendingCancel=true → auto-release");
      this._pendingCancel = false;
      const roomId = this.sdk._roomId;
      if (roomId) this.sdk.sig.send(OP.FLOOR_RELEASE, { room_id: roomId });
      return;
    }

    const fromQueue = this._state === FLOOR.QUEUED;
    this._speaker = d.speaker;
    this._queuePosition = 0;
    this._queuePriority = 0;
    this._setState(FLOOR.TALKING);
    this._startPing();
    this.sdk.emit("floor:granted", d);
    console.log(`[FLOOR] granted speaker=${d.speaker} (from=${fromQueue ? "queue_pop" : "direct"})`);
  }

  /** Floor Request → Queued 응답 (큐 삽입) */
  _onFloorQueued(d) {
    // Zello race defense: Queued 도착했지만 이미 사용자가 PTT 뗌
    if (this._pendingCancel) {
      console.log("[FLOOR] queued arrived but pendingCancel=true → auto-release");
      this._pendingCancel = false;
      const roomId = this.sdk._roomId;
      if (roomId) this.sdk.sig.send(OP.FLOOR_RELEASE, { room_id: roomId });
      return;
    }

    this._queuePosition = d.position || 1;
    this._queuePriority = d.priority || 0;
    this._setState(FLOOR.QUEUED);
    this.sdk.emit("floor:queued", {
      position: this._queuePosition,
      priority: this._queuePriority,
      queue_size: d.queue_size || 0,
    });
    console.log(`[FLOOR] queued position=${d.position} priority=${d.priority} queue_size=${d.queue_size}`);
  }

  /** Floor Request → Denied 응답 */
  _onFloorDenied(d) {
    this._setState(this._speaker ? FLOOR.LISTENING : FLOOR.IDLE);
    this.sdk.emit("floor:denied", d);
    console.log(`[FLOOR] denied code=${d.code} msg=${d.msg}`);
  }

  /** FLOOR_TAKEN 이벤트 (타인 발화 시작) */
  _onFloorTaken(d) {
    this._speaker = d.speaker;
    if (this._state !== FLOOR.TALKING && this._state !== FLOOR.REQUESTING && this._state !== FLOOR.QUEUED) {
      this._setState(FLOOR.LISTENING);
    }
    this.sdk.emit("floor:taken", d);
    console.log(`[FLOOR] taken speaker=${d.speaker} priority=${d.priority ?? "?"}`);
  }

  /** FLOOR_IDLE 이벤트 (발화 종료, 채널 비어있음) */
  _onFloorIdle(d) {
    this._stopPing();
    this._speaker = null;
    // QUEUED 상태는 유지 (queue pop 대기 — 서버가 pop하면 granted가 옴)
    if (this._state !== FLOOR.QUEUED) {
      this._setState(FLOOR.IDLE);
    }
    this.sdk.emit("floor:idle", d);
    console.log(`[FLOOR] idle prev_speaker=${d.prev_speaker}`);
  }

  /** FLOOR_REVOKE 이벤트 (서버 강제 회수) */
  _onFloorRevoke(d) {
    this._stopPing();
    this._speaker = null;
    this._queuePosition = 0;
    this._queuePriority = 0;
    this._setState(FLOOR.IDLE);
    this.sdk.emit("floor:revoke", d);
    console.log(`[FLOOR] revoke cause=${d.cause}`);
  }

  // ── Floor PING 타이머 ──

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      const roomId = this.sdk._roomId;
      if (this._state === FLOOR.TALKING && roomId) {
        this.sdk.sig.send(OP.FLOOR_PING, { room_id: roomId });
      }
    }, FLOOR_PING_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ── 상태 유틸 ──

  _setState(next) {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    this.sdk.emit("floor:state", { state: next, prev, speaker: this._speaker });
  }
}
