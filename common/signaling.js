// author: kodeholic (powered by Claude)
// signaling.js — WebSocket 시그널링 + Floor Control FSM
//
// 책임:
//   - WebSocket 연결/해제/송수신
//   - Heartbeat 타이머
//   - 패킷 dispatch (이벤트/응답 분기)
//   - Floor Control 4-state 상태 머신 (MCPTT/MBCP §6.2.4)
//   - Floor PING 타이머
//
// sdk 참조를 통해:
//   - sdk.emit() — 앱으로 이벤트 전파
//   - sdk._onJoinOk() / sdk._onTracksUpdate() — 미디어/텔레메트리 조율

import { OP, CONN, FLOOR, FLOOR_PING_MS } from "./constants.js";

export class Signaling {
  constructor(sdk) {
    this.sdk = sdk;

    this._ws = null;
    this._pid = 0;
    this._hbTimer = null;
    this._connState = CONN.DISCONNECTED;

    // --- Floor Control (MCPTT/MBCP 4-state) ---
    this._floorState = FLOOR.IDLE;
    this._speaker = null; // 현재 발화자 user_id (null = nobody)
    this._pendingCancel = false; // Zello race defense: REQUESTING 중 PTT 뗌
    this._floorPingTimer = null;
    this._roomMode = "conference";
  }

  // ── Getters ──

  get connState() {
    return this._connState;
  }
  get floorState() {
    return this._floorState;
  }
  get speaker() {
    return this._speaker;
  }
  get roomMode() {
    return this._roomMode;
  }

  // ── WebSocket 연결 ──

  connect() {
    this._setConnState(CONN.CONNECTING);
    try {
      this._ws = new WebSocket(this.sdk.url);
    } catch (e) {
      this._setConnState(CONN.DISCONNECTED);
      this.sdk.emit("ws:error", { reason: e.message });
      return;
    }

    this._ws.onopen = () => {
      this._setConnState(CONN.CONNECTED);
      this.sdk.emit("ws:connected");
    };
    this._ws.onclose = (e) => {
      this._clearHeartbeat();
      this._setConnState(CONN.DISCONNECTED);
      this.sdk.emit("ws:disconnected", { code: e.code, reason: e.reason });
    };
    this._ws.onerror = () => console.error("[SIG] WebSocket error");
    this._ws.onmessage = (e) => {
      try {
        const pkt = JSON.parse(e.data);
        // console.log("→", pkt);
        this._handlePacket(pkt);
      } catch (err) {
        console.error(`[SIG] packet parse error: ${err.message}`);
      }
    };
  }

  disconnect() {
    this._clearHeartbeat();
    this._stopFloorPing();
    this._resetFloor();
    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onclose = null;
      this._ws.onerror = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }
    this._pid = 0;
    this._roomMode = "conference";
    // ws.onclose=null로 밀었으므로 onclose 콜백 안 옴 → 직접 상태 전이
    this._setConnState(CONN.DISCONNECTED);
  }

  // ── 송수신 ──

  send(op, data) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const pkt = { op, pid: this._nextPid(), d: data || {} };
    // console.log("←", pkt);
    this._ws.send(JSON.stringify(pkt));
  }

  ack(op, pid) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const pkt = { op, pid, ok: true, d: {} };
    this._ws.send(JSON.stringify(pkt));
  }

  _nextPid() {
    return ++this._pid;
  }

  // ── Heartbeat ──

  _startHeartbeat(interval) {
    this._clearHeartbeat();
    this._hbTimer = setInterval(() => this.send(OP.HEARTBEAT, {}), interval);
  }

  _clearHeartbeat() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
  }

  // ── 패킷 분기 ──

  _handlePacket(pkt) {
    const { op, pid, ok, d } = pkt;

    if (ok === undefined || ok === null) {
      this._handleEvent(op, pid, d);
      return;
    }

    if (ok === true) {
      this._handleResponse(op, pid, d);
    } else {
      this._handleError(op, pid, d);
    }
  }

  _handleEvent(op, pid, d) {
    switch (op) {
      case OP.HELLO:
        this._startHeartbeat(d.heartbeat_interval);
        this.send(OP.IDENTIFY, {
          token: this.sdk.token,
          user_id: this.sdk.userId,
        });
        break;

      case OP.ROOM_EVENT:
        this.ack(op, pid);
        this.sdk.emit("room:event", d);
        break;

      case OP.TRACKS_UPDATE:
        this.ack(op, pid);
        this.sdk._onTracksUpdate(d);
        break;

      case OP.TRACK_STATE:
        this.ack(op, pid);
        this.sdk.emit("track:state", d);
        break;

      case OP.MESSAGE_EVENT:
        this.ack(op, pid);
        this.sdk.emit("message", d);
        break;

      // --- Floor Control Events ---
      case OP.FLOOR_TAKEN:
        this.ack(op, pid);
        this._onFloorTaken(d);
        break;

      case OP.FLOOR_IDLE:
        this.ack(op, pid);
        this._onFloorIdle(d);
        break;

      case OP.FLOOR_REVOKE:
        this.ack(op, pid);
        this._onFloorRevoke(d);
        break;

      default:
        console.warn(`[SIG] unknown event op=${op}`);
    }
  }

  _handleResponse(op, _pid, d) {
    switch (op) {
      case OP.HEARTBEAT:
        break;

      case OP.IDENTIFY:
        this.sdk.userId = d.user_id;
        this._setConnState(CONN.IDENTIFIED);
        this.sdk.emit("identified", d);
        break;

      case OP.ROOM_LIST:
        this.sdk.emit("room:list", d);
        break;

      case OP.ROOM_CREATE:
        this.sdk.emit("room:created", d);
        break;

      case OP.ROOM_JOIN:
        this._roomMode = d.mode || "conference";
        this.sdk._onJoinOk(d);
        break;

      case OP.ROOM_LEAVE:
        this.sdk.emit("room:leaveAck", d);
        break;

      case OP.PUBLISH_TRACKS:
        console.log("[SIG] publish_tracks registered:", d);
        break;

      case OP.MUTE_UPDATE:
        console.log("[SIG] mute_update ack:", d);
        break;

      case OP.MESSAGE:
        this.sdk.emit("message:ack", d);
        break;

      // --- Floor Control Responses ---
      case OP.FLOOR_REQUEST:
        this._onFloorGranted(d);
        break;

      case OP.FLOOR_RELEASE:
        console.log("[SIG] floor:release ack");
        break;

      case OP.FLOOR_PING:
        break;

      default:
        this.sdk.emit("ack", { op, d });
    }
  }

  _handleError(op, _pid, d) {
    if (op === OP.FLOOR_REQUEST) {
      this._onFloorDenied(d);
    } else {
      this.sdk.emit("error", { op, ...d });
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Floor Control FSM (MCPTT/MBCP §6.2.4 간소화 4-state)
  //
  //  상태: IDLE → REQUESTING → TALKING → IDLE
  //                    ↘ DENIED → IDLE/LISTENING
  //        IDLE ←→ LISTENING (FLOOR_TAKEN / FLOOR_IDLE)
  // ════════════════════════════════════════════════════════════

  /**
   * 발화권 요청 (PTT 누름)
   * IDLE 또는 LISTENING에서만 요청 가능
   */
  floorRequest() {
    const roomId = this.sdk._roomId;
    if (!roomId || this._roomMode !== "ptt") return;
    if (
      this._floorState === FLOOR.TALKING ||
      this._floorState === FLOOR.REQUESTING
    )
      return;

    this._pendingCancel = false;
    this._setFloorState(FLOOR.REQUESTING);
    this.send(OP.FLOOR_REQUEST, { room_id: roomId });
    this.sdk.emit("floor:pending");
  }

  /**
   * 발화권 해제 (PTT 뗌)
   */
  floorRelease() {
    const roomId = this.sdk._roomId;
    if (!roomId || this._roomMode !== "ptt") return;

    if (this._floorState === FLOOR.REQUESTING) {
      // Zello race defense: 서버 응답 전에 PTT 뗌
      // → FLOOR_RELEASE 전송 + pendingCancel 플래그
      this._pendingCancel = true;
      this.send(OP.FLOOR_RELEASE, { room_id: roomId });
      this._setFloorState(this._speaker ? FLOOR.LISTENING : FLOOR.IDLE);
      this.sdk.emit("floor:released");
      console.log("[SIG] floor:release (pending cancel — Zello race defense)");
      return;
    }

    if (this._floorState === FLOOR.TALKING) {
      this._stopFloorPing();
      this._speaker = null;
      this.send(OP.FLOOR_RELEASE, { room_id: roomId });
      this._setFloorState(FLOOR.IDLE);
      this.sdk.emit("floor:released");
    }
  }

  // ── Floor 응답/이벤트 핸들러 ──

  /** Floor Request → Granted 응답 */
  _onFloorGranted(d) {
    if (!d.granted) return;

    // Zello race defense: Granted 도착했지만 이미 사용자가 PTT 뗌
    if (this._pendingCancel) {
      console.log(
        "[SIG] floor:granted arrived but pendingCancel=true → auto-release",
      );
      this._pendingCancel = false;
      const roomId = this.sdk._roomId;
      if (roomId) this.send(OP.FLOOR_RELEASE, { room_id: roomId });
      return;
    }

    this._speaker = d.speaker;
    this._setFloorState(FLOOR.TALKING);
    this._startFloorPing();
    this.sdk.emit("floor:granted", d);
    console.log(`[SIG] floor:granted speaker=${d.speaker}`);
  }

  /** Floor Request → Denied 응답 */
  _onFloorDenied(d) {
    // denied 시: speaker가 있으면 LISTENING, 없으면 IDLE
    this._setFloorState(this._speaker ? FLOOR.LISTENING : FLOOR.IDLE);
    this.sdk.emit("floor:denied", d);
    console.log(`[SIG] floor:denied code=${d.code} msg=${d.msg}`);
  }

  /** FLOOR_TAKEN 이벤트 (타인 발화 시작) */
  _onFloorTaken(d) {
    this._speaker = d.speaker;
    // 내가 TALKING 중이면 유지 (내 Granted 직후 자기 Taken 수신)
    if (
      this._floorState !== FLOOR.TALKING &&
      this._floorState !== FLOOR.REQUESTING
    ) {
      this._setFloorState(FLOOR.LISTENING);
    }
    this.sdk.emit("floor:taken", d);
    console.log(`[SIG] floor:taken speaker=${d.speaker}`);
  }

  /** FLOOR_IDLE 이벤트 (발화 종료, 채널 비어있음) */
  _onFloorIdle(d) {
    this._stopFloorPing();
    this._speaker = null;
    this._setFloorState(FLOOR.IDLE);
    this.sdk.emit("floor:idle", d);
    console.log(`[SIG] floor:idle prev_speaker=${d.prev_speaker}`);
  }

  /** FLOOR_REVOKE 이벤트 (서버 강제 회수) */
  _onFloorRevoke(d) {
    this._stopFloorPing();
    this._speaker = null;
    this._setFloorState(FLOOR.IDLE);
    this.sdk.emit("floor:revoke", d);
    console.log(`[SIG] floor:revoke cause=${d.cause}`);
  }

  // ── Floor PING 타이머 ──

  _startFloorPing() {
    this._stopFloorPing();
    this._floorPingTimer = setInterval(() => {
      const roomId = this.sdk._roomId;
      if (this._floorState === FLOOR.TALKING && roomId) {
        this.send(OP.FLOOR_PING, { room_id: roomId });
      }
    }, FLOOR_PING_MS);
  }

  _stopFloorPing() {
    if (this._floorPingTimer) {
      clearInterval(this._floorPingTimer);
      this._floorPingTimer = null;
    }
  }

  // ── 상태 유틸 ──

  _setConnState(next) {
    if (this._connState === next) return;
    const prev = this._connState;
    this._connState = next;
    this.sdk.emit("conn:state", { state: next, prev });
  }

  _setFloorState(next) {
    if (this._floorState === next) return;
    const prev = this._floorState;
    this._floorState = next;
    this.sdk.emit("floor:state", { state: next, prev, speaker: this._speaker });
  }

  _resetFloor() {
    this._floorState = FLOOR.IDLE;
    this._speaker = null;
    this._pendingCancel = false;
  }

  /** 퇴장 시 floor 상태 리셋 */
  onLeaveRoom() {
    this._stopFloorPing();
    this._resetFloor();
    this._roomMode = "conference";
  }
}
