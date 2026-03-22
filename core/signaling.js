// author: kodeholic (powered by Claude)
// signaling.js — WebSocket 시그널링 (순수 WS 계층)
//
// 책임:
//   - WebSocket 연결/해제/송수신
//   - Heartbeat 타이머
//   - 패킷 dispatch (이벤트/응답 분기)
//   - Floor opcode → raw 이벤트 emit (FSM은 ptt/floor-fsm.js로 분리)
//   - Simulcast subscribeLayer
//
// client(OxLensClient) 참조를 통해:
//   - sdk.emit() — 앱/모듈로 이벤트 전파
//   - sdk._onJoinOk() / sdk._onTracksUpdate() — 미디어/텔레메트리 조율

import { OP, CONN } from "./constants.js";

export class Signaling {
  constructor(sdk) {
    this.sdk = sdk;

    this._ws = null;
    this._pid = 0;
    this._hbTimer = null;
    this._connState = CONN.DISCONNECTED;

    // roomMode는 ROOM_JOIN 응답에서 설정 (PTT 여부 판별용으로 signaling에 유지)
    this._roomMode = "conference";
  }

  // ── Getters ──

  get connState() { return this._connState; }
  get roomMode() { return this._roomMode; }

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
        this._handlePacket(pkt);
      } catch (err) {
        console.error(`[SIG] packet parse error: ${err.message}`);
      }
    };
  }

  disconnect() {
    this._clearHeartbeat();
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
    this._setConnState(CONN.DISCONNECTED);
  }

  // ── 송수신 ──

  send(op, data) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const pkt = { op, pid: this._nextPid(), d: data || {} };
    this._ws.send(JSON.stringify(pkt));
  }

  ack(op, pid) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const pkt = { op, pid, ok: true, d: {} };
    this._ws.send(JSON.stringify(pkt));
  }

  _nextPid() { return ++this._pid; }

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

      case OP.VIDEO_SUSPENDED:
        this.ack(op, pid);
        this.sdk.emit("video:suspended", d);
        break;

      case OP.VIDEO_RESUMED:
        this.ack(op, pid);
        this.sdk.emit("video:resumed", d);
        break;

      case OP.TRACKS_RESYNC:
        this.ack(op, pid);
        this.sdk._onTracksResync(d);
        break;

      // --- Floor Control Events → raw emit (FSM은 floor-fsm.js에서 처리) ---
      case OP.FLOOR_TAKEN:
        this.ack(op, pid);
        this.sdk.emit("_floor:taken_raw", d);
        break;

      case OP.FLOOR_IDLE:
        this.ack(op, pid);
        this.sdk.emit("_floor:idle_raw", d);
        break;

      case OP.FLOOR_REVOKE:
        this.ack(op, pid);
        this.sdk.emit("_floor:revoke_raw", d);
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

      case OP.CAMERA_READY:
        console.log("[SIG] camera_ready ack");
        break;

      case OP.TRACKS_ACK:
        if (d.synced) {
          console.log("[SIG] tracks_ack: synced");
        } else {
          console.log("[SIG] tracks_ack: mismatch, resync_sent=", d.resync_sent);
        }
        break;

      case OP.MESSAGE:
        this.sdk.emit("message:ack", d);
        break;

      // --- Floor Control Responses → raw emit ---
      case OP.FLOOR_REQUEST:
        if (d.queued) {
          this.sdk.emit("_floor:queued_raw", d);
        } else {
          this.sdk.emit("_floor:granted_raw", d);
        }
        break;

      case OP.FLOOR_RELEASE:
        console.log("[SIG] floor:release ack");
        break;

      case OP.FLOOR_PING:
        break;

      case OP.SUBSCRIBE_LAYER:
        console.log("[SIG] subscribe_layer ack");
        break;

      // ROOM_SYNC 응답 → subscribe PC 재생성 (decoder stall 자동 복구 경로)
      case OP.ROOM_SYNC: {
        const syncTracks = d.subscribe_tracks || [];
        console.log(`[SIG] ROOM_SYNC response: ${syncTracks.length} tracks`);
        if (syncTracks.length > 0) {
          this.sdk._onTracksResync({ tracks: syncTracks });
        }
        break;
      }

      case OP.FLOOR_QUEUE_POS:
        this.sdk.emit("floor:queue_pos", d);
        break;

      default:
        this.sdk.emit("ack", { op, d });
    }
  }

  _handleError(op, _pid, d) {
    if (op === OP.FLOOR_REQUEST) {
      this.sdk.emit("_floor:denied_raw", d);
    } else if (op === OP.FLOOR_QUEUE_POS) {
      this.sdk.emit("error", { op, ...d });
    } else {
      this.sdk.emit("error", { op, ...d });
    }
  }

  // ── Simulcast 레이어 선택 ──

  subscribeLayer(targets) {
    if (!targets || targets.length === 0) return;
    this.send(OP.SUBSCRIBE_LAYER, { targets });
    console.log(`[SIG] SUBSCRIBE_LAYER sent: ${targets.map(t => `${t.user_id}=${t.rid}`).join(", ")}`);
  }

  // ── 상태 유틸 ──

  _setConnState(next) {
    if (this._connState === next) return;
    const prev = this._connState;
    this._connState = next;
    this.sdk.emit("conn:state", { state: next, prev });
  }

  /** 퇴장 시 roomMode 리셋 */
  onLeaveRoom() {
    this._roomMode = "conference";
  }
}
