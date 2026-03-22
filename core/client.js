// author: kodeholic (powered by Claude)
// client.js — OxLens Client SDK (2PC / SDP-free)
//
// Facade: 앱이 사용하는 Public API 제공.
// 내부 모듈 조립: Signaling + MediaSession + Telemetry + DeviceManager
// PTT 확장: ptt/ 모듈이 있으면 동적 활성화 (Conference-only면 ptt=null)
//
// Mute 제어:
//   Conference audio: track.enabled 토글 (장치 유지)
//   Conference video: track.stop() + replaceTrack(dummy) → LED OFF
//   PTT 모드:        ptt-controller가 담당 (COLD 고정 + wake 무시)
//
// 모듈 구조:
//   constants.js      → 공용 상수 (OP, CONN, FLOOR, DEVICE_KIND, PTT_POWER)
//   signaling.js      → WS + 패킷 dispatch (순수 WS 계층)
//   media-session.js  → Publish/Subscribe PC + 미디어
//   device-manager.js → 장치 열거/전환/핫플러그
//   telemetry.js      → stats 수집 + 서버 전송
//   sdp-builder.js    → fake SDP 조립 (기존 유지)
//   ptt/              → PTT 확장 (떼었다 붙였다 가능)

import { SDK_VERSION, OP, CONN, FLOOR, DEVICE_KIND, PTT_POWER } from "./constants.js";
import { Signaling } from "./signaling.js";
import { MediaSession } from "./media-session.js";
import { Telemetry } from "./telemetry.js";
import { DeviceManager } from "./device-manager.js";

// ============================================================
//  EventEmitter
// ============================================================
class EventEmitter {
  constructor() { this._listeners = new Map(); }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) { set.delete(fn); if (set.size === 0) this._listeners.delete(event); }
    return this;
  }

  once(event, fn) {
    const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
    return this.on(event, wrapper);
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) set.forEach((fn) => {
      try { fn(...args); } catch (e) { console.error(`[SDK] listener error on "${event}":`, e); }
    });
  }

  removeAllListeners(event) {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
    return this;
  }
}

// ============================================================
//  OxLensClient — Public API Facade
// ============================================================
export class OxLensClient extends EventEmitter {
  constructor(opts) {
    super();
    this.url = opts.url;
    this.userId = opts.userId || null;
    this.token = opts.token || "kodeholic";
    this._roomId = null;
    this._enableVideo = false;

    // media 설정 (외부 주입 가능)
    this.mediaConfig = {
      width: opts.width || 1280,
      height: opts.height || 720,
      frameRate: opts.frameRate || 24,
      maxBitrate: opts.maxBitrate || 1_500_000,
      preferredCodec: opts.preferredCodec || "H264",
    };

    // --- 모듈 조립 ---
    this.sig = new Signaling(this);
    this.media = new MediaSession(this);
    this.tel = new Telemetry(this);
    this.device = new DeviceManager(this);

    // --- PTT 확장 슬롯 (Conference-only면 null) ---
    this.ptt = null;
    this._pendingPttConfig = null;  // 방 입장 전 설정 → attach 시 적용

    // --- Mute (Conference 모드) ---
    // audio: track.enabled 토글 (장치 유지)
    // video: track.stop() + replaceTrack(dummy) → LED OFF
    this._muted = { audio: false, video: false };
    this._videoDummy = null;  // Conference video mute 시 dummy track

    // Simulcast
    this._simulcastEnabled = false;

    // --- Input Gain (GainNode 체인) ---
    this._inputGainCtx = null;
    this._inputGainNode = null;
    this._inputGainSourceTrack = null;  // GainNode에 물린 원본 audio track
    this._pendingInputGain = 1.0;

    // --- Auto-Reconnect (2PC ICE 비대칭 사망 대응) ---
    this._reconnecting = false;
    this._joinComplete = false;  // _onJoinOk 완료 후 true
    this.on("pc:failed", (d) => this._handlePcFailed(d));
  }

  // ── Public Getters ──

  get connState() { return this.sig.connState; }
  get roomId() { return this._roomId; }
  get roomMode() { return this.sig.roomMode; }
  get floorState() { return this.ptt?.floorState ?? FLOOR.IDLE; }
  get speaker() { return this.ptt?.speaker ?? null; }
  get queuePosition() { return this.ptt?.queuePosition ?? 0; }
  get queuePriority() { return this.ptt?.queuePriority ?? 0; }
  get facingMode() { return this.media.facingMode; }
  get userVideoOff() { return this.ptt?.userVideoOff ?? false; }

  // ── PTT Power State 공개 API ──

  set pttPowerConfig(cfg) {
    this._pendingPttConfig = cfg;
    if (this.ptt) this.ptt.powerConfig = cfg;
  }
  get pttPowerConfig() { return this.ptt?.powerConfig ?? this._pendingPttConfig ?? {}; }
  get pttPowerState() { return this.ptt?.powerState ?? PTT_POWER.HOT; }

  // ── Connection ──

  connect() { this.sig.connect(); }

  disconnect() {
    this._joinComplete = false;
    this.ptt?.detach();
    this.ptt = null;
    this.tel.stop();
    this.device.stop();
    this.media.teardown();
    this._resetMute();
    this.sig.disconnect();
    this._roomId = null;
  }

  // ── Room ──

  listRooms() { this.sig.send(OP.ROOM_LIST, {}); }

  createRoom(name, capacity, mode) {
    this.sig.send(OP.ROOM_CREATE, { name, capacity, mode });
  }

  async joinRoom(roomId, enableVideo = false) {
    this._roomId = roomId;
    this._enableVideo = enableVideo;

    this.emit("join:phase", { phase: "media" });

    try {
      await this.media.acquireMedia(enableVideo);
    } catch (e) {
      if (enableVideo) {
        console.warn(`[SDK] 카메라 획득 실패, 오디오만 재시도: ${e.message}`);
        try {
          await this.media.acquireMedia(false);
          this._enableVideo = false;
          this.emit("media:fallback", { dropped: "video", reason: e.message });
        } catch (e2) {
          this.emit("error", { code: 0, msg: `미디어 획득 실패 (카메라+마이크 모두 불가): ${e2.message}` });
          this._roomId = null;
          return;
        }
      } else {
        this.emit("error", { code: 0, msg: `마이크 획득 실패: ${e.message}` });
        this._roomId = null;
        return;
      }
    }

    await this.device.start();

    this.emit("join:phase", { phase: "signaling" });
    this.sig.send(OP.ROOM_JOIN, { room_id: roomId });
  }

  leaveRoom() {
    if (!this._roomId) return;
    this._joinComplete = false;

    // PTT 먼저 정리 — 진행 중 _ensureHot() bail-out (state=null → track leak 방지)
    this.ptt?.detach();
    this.ptt = null;

    this.sig.onLeaveRoom();
    this.sig.send(OP.ROOM_LEAVE, { room_id: this._roomId });
    this.tel.stop();
    this.device.stop();
    this.media.teardown();
    this._resetMute();
    const leftRoom = this._roomId;
    this._roomId = null;
    this.emit("room:left", { room_id: leftRoom });
  }

  sendMessage(content) {
    if (!this._roomId) return;
    this.sig.send(OP.MESSAGE, { room_id: this._roomId, content });
  }

  // ── Camera ──

  async switchCamera() { return this.media.switchCamera(); }

  // ── Device ──

  getDevices(kind) { return this.device.getDevices(kind); }
  async refreshDevices() { return this.device.refreshDevices(); }
  async setAudioInput(deviceId) { return this.device.setAudioInput(deviceId); }
  async setAudioOutput(deviceId) { return this.device.setAudioOutput(deviceId); }
  async setVideoInput(deviceId) { return this.device.setVideoInput(deviceId); }
  addOutputElement(el) { this.device.addOutputElement(el); }
  removeOutputElement(el) { this.device.removeOutputElement(el); }

  // ── Floor Control (PTT 확장 위임) ──

  floorRequest(priority = 0) { this.ptt?.request(priority); }
  floorRelease() { this.ptt?.release(); }
  floorQueuePos() {
    if (!this._roomId) return;
    this.sig.send(OP.FLOOR_QUEUE_POS, { room_id: this._roomId });
  }

  // ── Simulcast ──

  get simulcastEnabled() { return this._simulcastEnabled; }

  subscribeLayer(targets) { this.sig.subscribeLayer(targets); }

  // ── 미디어 정리 (WS 단절 시 app에서 호출) ──

  /** WS 단절 시 미디어/텔레메트리/PTT 정리 (시그널링은 건드리지 않음) */
  teardownMedia() {
    this.ptt?.detach();
    this.ptt = null;
    this.tel.stop();
    this.media.teardown();
    this._resetMute();
  }

  // ── 오디오 처리 (GainNode + Constraints) ──

  /**
   * 마이크 입력 게인 설정 (0.0 ~ 2.0).
   * GainNode가 아직 연결되지 않았으면 자동 연결 시도.
   */
  async setInputGain(value) {
    this._pendingInputGain = value;
    if (this._inputGainNode) {
      this._inputGainNode.gain.value = value;
      return;
    }
    // GainNode 미연결 → 연결 시도
    await this._wireInputGain();
  }

  /** 마이크 트랙에 GainNode 체인 삽입 (ICE connected 후 1회 호출) */
  async _wireInputGain() {
    const sender = this.media.audioSender;
    if (!sender?.track || sender.track._gainWired) return;

    try {
      this._inputGainCtx = new AudioContext();
      this._inputGainSourceTrack = sender.track;  // 원본 track 참조 보존 (leak 방지)
      const source = this._inputGainCtx.createMediaStreamSource(new MediaStream([sender.track]));
      this._inputGainNode = this._inputGainCtx.createGain();
      this._inputGainNode.gain.value = this._pendingInputGain;
      const dest = this._inputGainCtx.createMediaStreamDestination();
      source.connect(this._inputGainNode).connect(dest);
      const gainedTrack = dest.stream.getAudioTracks()[0];
      await sender.replaceTrack(gainedTrack);
      sender.track._gainWired = true;
      console.log(`[SDK] GainNode 연결 (gain=${this._inputGainNode.gain.value})`);
    } catch (e) {
      console.error(`[SDK] GainNode 연결 실패: ${e.message}`);
    }
  }

  /**
   * 오디오 처리 설정 (NS/AEC/AGC).
   * @param {{ noiseSuppression?: boolean, echoCancellation?: boolean, autoGainControl?: boolean }} opts
   */
  async setAudioProcessing(opts) {
    const track = this.media.stream?.getAudioTracks()?.[0];
    if (!track) return;
    try {
      await track.applyConstraints(opts);
      console.log(`[SDK] audio processing: NS=${opts.noiseSuppression} AEC=${opts.echoCancellation} AGC=${opts.autoGainControl}`);
    } catch (e) {
      console.error(`[SDK] audio constraints 적용 실패: ${e.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Mute — Conference: enabled/dummy, PTT: COLD 고정
  // ════════════════════════════════════════════════════════════

  /**
   * Mute 토글.
   *   PTT audio → 차단 (floor 소유)
   *   PTT video/all → ptt-controller 위임 (COLD 고정)
   *   Conference audio → track.enabled 토글
   *   Conference video → stop+dummy / getUserMedia 복원
   */
  async toggleMute(kind) {
    // ── PTT 모드: ptt-controller에 위임 ──
    if (this.ptt) {
      if (kind === "audio") {
        console.log("[SDK] toggleMute(audio) blocked — PTT floor controls audio");
        return;
      }
      this.ptt.toggleMute();
      return;
    }

    // ── Conference 모드 ──
    const muted = !this._muted[kind];
    this._muted[kind] = muted;

    if (kind === "audio") {
      // audio: track.enabled 토글 (장치 유지, LED 없음)
      const track = this.media.stream?.getAudioTracks()?.[0];
      if (track) track.enabled = !muted;
      this._notifyMuteServer(kind, muted);
      this.emit("mute:changed", { kind, muted });
      console.log(`[SDK] audio ${muted ? "muted" : "unmuted"} (enabled=${!muted})`);

    } else if (kind === "video") {
      if (muted) {
        // video mute: track.stop() → replaceTrack(dummy) → LED OFF
        await this._muteVideo();
      } else {
        // video unmute: getUserMedia → replaceTrack → LED ON
        await this._unmuteVideo();
      }
    }
  }

  isMuted(kind) {
    if (this.ptt) return this.ptt.isMuted(kind);
    return this._muted[kind];
  }

  // ── Conference Video Mute 내부 ──

  /** video mute: 장치 해제 + dummy 교체 */
  async _muteVideo() {
    const sender = this.media.videoSender;
    if (!sender) return;

    // dummy 생성
    const dummy = this._createVideoDummyTrack();
    this._videoDummy = dummy;

    // 원본 트랙 정리
    const orig = sender.track;
    if (orig) {
      orig.stop();
      if (this.media.stream) this.media.stream.removeTrack(orig);
    }

    await sender.replaceTrack(dummy);
    this._notifyMuteServer("video", true);
    this.emit("mute:changed", { kind: "video", muted: true });
    console.log("[SDK] video muted (device OFF, dummy track)");
  }

  /** video unmute: getUserMedia 복원 */
  async _unmuteVideo() {
    const sender = this.media.videoSender;
    if (!sender) return;

    const mc = this.mediaConfig;
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } },
      });
    } catch (e) {
      this._muted.video = true;  // 복원 실패 → muted 유지
      this.emit("error", { code: 0, msg: `비디오 복원 실패: ${e.message}` });
      return;
    }

    const newTrack = newStream.getVideoTracks()[0];

    // dummy 정리
    this._destroyVideoDummy();

    await sender.replaceTrack(newTrack);

    // stream 갱신
    if (this.media.stream) {
      this.media.stream.getVideoTracks().forEach(t => this.media.stream.removeTrack(t));
      this.media.stream.addTrack(newTrack);
    }

    this._notifyMuteServer("video", false);
    this.emit("media:local", this.media.stream);
    this.emit("mute:changed", { kind: "video", muted: false });
    this._sendCameraReady();
    console.log("[SDK] video unmuted (device ON)");
  }

  // ── 서버 통신 헬퍼 ──

  _notifyMuteServer(kind, muted) {
    const ssrc = this.media.getPublishSsrc(kind);
    if (ssrc) this.sig.send(OP.MUTE_UPDATE, { ssrc, muted });
  }

  _sendCameraReady() {
    if (!this._roomId) return;
    this.sig.send(OP.CAMERA_READY, { room_id: this._roomId });
    console.log("[SDK] CAMERA_READY sent");
  }

  // ── Video Dummy Track 팩토리 ──

  _createVideoDummyTrack() {
    const canvas = document.createElement("canvas");
    canvas.width = 2; canvas.height = 2;
    const ctx2d = canvas.getContext("2d");
    ctx2d.fillStyle = "#000";
    ctx2d.fillRect(0, 0, 2, 2);
    const stream = canvas.captureStream(1);
    const track = stream.getVideoTracks()[0];
    track._dummyCanvas = canvas;
    return track;
  }

  _destroyVideoDummy() {
    if (!this._videoDummy) return;
    this._videoDummy.stop();
    this._videoDummy = null;
  }

  _resetMute() {
    this._muted = { audio: false, video: false };
    this._destroyVideoDummy();
    this._simulcastEnabled = false;
    // GainNode 정리 — source track 명시적 stop (마이크 점유 해제)
    if (this._inputGainSourceTrack) {
      this._inputGainSourceTrack.stop();
      this._inputGainSourceTrack = null;
    }
    if (this._inputGainCtx) {
      this._inputGainCtx.close().catch(() => {});
      this._inputGainCtx = null;
    }
    this._inputGainNode = null;
  }

  // ════════════════════════════════════════════════════════════
  //  Auto-Reconnect (pub 또는 sub PC failed → leaveRoom + joinRoom)
  // ════════════════════════════════════════════════════════════

  async _handlePcFailed({ pc }) {
    if (this._reconnecting || !this._roomId) return;

    // 입장 중 failed → error emit (첫 연결 자체 실패, reconnect 무의미)
    if (!this._joinComplete) {
      console.error(`[SDK] ${pc} PC failed during join — aborting`);
      this.emit("error", { code: 4010, msg: `${pc} ICE 연결 실패 (입장 중)` });
      return;
    }

    // 입장 완료 후 failed → auto-reconnect
    this._reconnecting = true;
    const savedRoom = this._roomId;
    const savedVideo = this._enableVideo;
    console.warn(`[SDK] ${pc} PC failed — auto-reconnect to room=${savedRoom}`);
    this.emit("reconnect:start", { pc, room_id: savedRoom });

    // PTT: floor release 선행
    if (this.ptt) {
      try { this.floorRelease(); } catch (_) {}
    }

    // 정리
    this.leaveRoom();

    // 1초 대기 (서버 cleanup + WS 안정)
    await new Promise(r => setTimeout(r, 1000));

    // WS가 살아있으면 재입장
    if (this.connState !== CONN.IDENTIFIED) {
      console.error("[SDK] reconnect aborted — WS not identified");
      this.emit("reconnect:fail", { pc, reason: "ws_not_ready" });
      this._reconnecting = false;
      return;
    }

    try {
      await this.joinRoom(savedRoom, savedVideo);
      console.log(`[SDK] reconnect done — room=${savedRoom}`);
      this.emit("reconnect:done", { pc, room_id: savedRoom });
    } catch (e) {
      console.error(`[SDK] reconnect joinRoom failed: ${e.message}`);
      this.emit("reconnect:fail", { pc, reason: e.message });
    }
    this._reconnecting = false;
  }

  // ════════════════════════════════════════════════════════════
  //  내부 조율 (Signaling → MediaSession + Telemetry + PTT)
  // ════════════════════════════════════════════════════════════

  async _onJoinOk(d) {
    const { server_config, tracks, participants, mode, ptt_virtual_ssrc, simulcast } = d;

    if (!server_config) {
      this.emit("error", { code: 4001, msg: "server_config missing in ROOM_JOIN response" });
      return;
    }

    this._simulcastEnabled = !!(simulcast && simulcast.enabled);

    try {
      await this.media.setup(server_config, tracks, { mode, pttVirtualSsrc: ptt_virtual_ssrc, simulcastEnabled: this._simulcastEnabled });
    } catch (e) {
      console.error("[SDK] 2PC setup failed:", e);
      this.emit("error", { code: 4002, msg: `2PC setup failed: ${e.message}` });
      return;
    }

    this.emit("room:joined", { ...d, participants });
    this.tel.start();

    this.media.sendTracksAck();

    // PTT 모드: 동적 확장 활성화
    if (mode === "ptt") {
      try {
        const { PttController } = await import("./ptt/ptt-controller.js");
        this.ptt = new PttController(this);
        if (this._pendingPttConfig) {
          this.ptt.powerConfig = this._pendingPttConfig;
        }
        this.ptt.attach(d);
      } catch (e) {
        console.error("[SDK] PTT extension load failed:", e);
        this.emit("error", { code: 4005, msg: `PTT extension load failed: ${e.message}` });
      }
    }

    // 구간 S-1: SDP 상태 1회 보고
    setTimeout(() => this.tel.sendSdpTelemetry(), 2000);

    this._joinComplete = true;
  }

  async _onTracksUpdate(d) {
    // PTT power state: tracks update → wake to HOT
    this.ptt?.wake();

    const { action, tracks } = d;

    try {
      await this.media.onTracksUpdate(action, tracks);
      setTimeout(() => this.tel.sendSdpTelemetry(), 1000);
    } catch (e) {
      console.error("[SDK] subscribe re-nego failed:", e);
      this.emit("error", { code: 4003, msg: `subscribe re-nego failed: ${e.message}` });
    }

    this.media.sendTracksAck();
    this.emit("tracks:update", d);
  }

  async _onTracksResync(d) {
    const { tracks } = d;
    console.log(`[SDK] TRACKS_RESYNC received: ${(tracks || []).length} tracks`);

    try {
      await this.media.onTracksResync(tracks);
      setTimeout(() => this.tel.sendSdpTelemetry(), 1000);
    } catch (e) {
      console.error("[SDK] tracks resync failed:", e);
      this.emit("error", { code: 4004, msg: `tracks resync failed: ${e.message}` });
    }

    this.media.sendTracksAck();
    this.emit("tracks:resync", d);
  }
}

// ============================================================
//  Exports — app.js 하위 호환
// ============================================================
export { SDK_VERSION, CONN, OP, FLOOR, DEVICE_KIND, PTT_POWER };
