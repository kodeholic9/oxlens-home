// author: kodeholic (powered by Claude)
// ptt/floor-fsm.js — Floor Control 4-state FSM (MCPTT/MBCP §6.2.4)
//
// 책임:
//   - Floor 4-state 상태 머신 (IDLE → REQUESTING → TALKING ↔ LISTENING)
//   - Floor PING 타이머 (발화 중 2초 주기)
//   - Zello race defense (REQUESTING 중 PTT 뗌)
//   - signaling raw 이벤트 수신 → 상태 전이 → app 이벤트 발신
//
// 수신 이벤트 (signaling.js raw):
//   _floor:taken_raw, _floor:idle_raw, _floor:revoke_raw,
//   _floor:granted_raw, _floor:denied_raw
//
// 발신 이벤트 (app/power-fsm 용):
//   floor:state, floor:granted, floor:taken, floor:idle,
//   floor:revoke, floor:denied, floor:released, floor:pending

import { OP, FLOOR, FLOOR_PING_MS } from "../constants.js";

export class FloorFsm {
  constructor(sdk) {
    this.sdk = sdk;

    this._state = FLOOR.IDLE;
    this._speaker = null;
    this._pendingCancel = false;
    this._pingTimer = null;

    // detach 시 해제할 이벤트 핸들러 참조
    this._handlers = {};
  }

  // ── Getters ──

  get state() { return this._state; }
  get speaker() { return this._speaker; }

  // ── 라이프사이클 ──

  attach() {
    this._handlers = {
      taken:   (d) => this._onFloorTaken(d),
      idle:    (d) => this._onFloorIdle(d),
      revoke:  (d) => this._onFloorRevoke(d),
      granted: (d) => this._onFloorGranted(d),
      denied:  (d) => this._onFloorDenied(d),
    };

    this.sdk.on("_floor:taken_raw",   this._handlers.taken);
    this.sdk.on("_floor:idle_raw",    this._handlers.idle);
    this.sdk.on("_floor:revoke_raw",  this._handlers.revoke);
    this.sdk.on("_floor:granted_raw", this._handlers.granted);
    this.sdk.on("_floor:denied_raw",  this._handlers.denied);
  }

  detach() {
    this._stopPing();

    this.sdk.off("_floor:taken_raw",   this._handlers.taken);
    this.sdk.off("_floor:idle_raw",    this._handlers.idle);
    this.sdk.off("_floor:revoke_raw",  this._handlers.revoke);
    this.sdk.off("_floor:granted_raw", this._handlers.granted);
    this.sdk.off("_floor:denied_raw",  this._handlers.denied);
    this._handlers = {};

    this._state = FLOOR.IDLE;
    this._speaker = null;
    this._pendingCancel = false;
  }

  // ── Public API ──

  /**
   * 발화권 요청 (PTT 누름)
   * IDLE 또는 LISTENING에서만 요청 가능
   */
  request() {
    const roomId = this.sdk._roomId;
    if (!roomId) return;
    if (this._state === FLOOR.TALKING || this._state === FLOOR.REQUESTING) return;

    this._pendingCancel = false;
    this._setState(FLOOR.REQUESTING);
    this.sdk.sig.send(OP.FLOOR_REQUEST, { room_id: roomId });
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

    if (this._state === FLOOR.TALKING) {
      this._stopPing();
      this._speaker = null;
      this.sdk.sig.send(OP.FLOOR_RELEASE, { room_id: roomId });
      this._setState(FLOOR.IDLE);
      this.sdk.emit("floor:released");
    }
  }

  // ── Raw 이벤트 핸들러 ──

  /** Floor Request → Granted 응답 */
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

    this._speaker = d.speaker;
    this._setState(FLOOR.TALKING);
    this._startPing();
    this.sdk.emit("floor:granted", d);
    console.log(`[FLOOR] granted speaker=${d.speaker}`);
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
    if (this._state !== FLOOR.TALKING && this._state !== FLOOR.REQUESTING) {
      this._setState(FLOOR.LISTENING);
    }
    this.sdk.emit("floor:taken", d);
    console.log(`[FLOOR] taken speaker=${d.speaker}`);
  }

  /** FLOOR_IDLE 이벤트 (발화 종료, 채널 비어있음) */
  _onFloorIdle(d) {
    this._stopPing();
    this._speaker = null;
    this._setState(FLOOR.IDLE);
    this.sdk.emit("floor:idle", d);
    console.log(`[FLOOR] idle prev_speaker=${d.prev_speaker}`);
  }

  /** FLOOR_REVOKE 이벤트 (서버 강제 회수) */
  _onFloorRevoke(d) {
    this._stopPing();
    this._speaker = null;
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
