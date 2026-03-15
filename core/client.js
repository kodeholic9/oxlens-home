// author: kodeholic (powered by Claude)
// client.js — OxLens Client SDK (2PC / SDP-free)
//
// Facade: 앱이 사용하는 Public API 제공.
// 내부 모듈 조립: Signaling + MediaSession + Telemetry
//
// Mute 제어 이원화:
//   Conference 모드: 3-state 상태 머신 (UNMUTED → SOFT → HARD)
//   PTT 모드:       선언적 계산 (floor + videoOff → _applyPttMediaState)
//                    audio=floor가 소유, video=사용자 toggle 허용
//
// 모듈 구조:
//   constants.js      → 공용 상수 (OP, CONN, MUTE, FLOOR, DEVICE_KIND)
//   signaling.js      → WS + 패킷 dispatch + Floor FSM
//   media-session.js   → Publish/Subscribe PC + 미디어
//   device-manager.js  → 장치 열거/전환/핵플러그
//   telemetry.js      → stats 수집 + 서버 전송
//   sdp-builder.js    → fake SDP 조립 (기존 유지)

import { SDK_VERSION, OP, CONN, MUTE, FLOOR, MUTE_ESCALATION_MS, DEVICE_KIND } from "./constants.js";
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
    };

    // --- 모듈 조립 ---
    this.sig = new Signaling(this);
    this.media = new MediaSession(this);
    this.tel = new Telemetry(this);
    this.device = new DeviceManager(this);

    // --- Mute 3-state (이 클래스에 내장 — sender/stream 직접 제어) ---
    this._muteState = { audio: MUTE.UNMUTED, video: MUTE.UNMUTED };
    this._muteTimers = { audio: null, video: null };
    this._dummyTracks = { audio: null, video: null };
    this._unmuteGeneration = { audio: 0, video: 0 };

    // --- PTT 선언적 미디어 제어 ---
    // floor(TALKING 여부) + _userVideoOff 두 변수로 audio/video 상태 결정
    // 트랙 상태: "live" | "soft_off" | "hard_off"
    this._pttTrackState = { audio: "live", video: "live" };
    this._pttTimers = { audio: null, video: null };
    this._userVideoOff = false;

    // PTT: floor 전이 → 자동 미디어 제어 (SDK 내부 바인딩)
    this._bindPttMediaControl();
  }

  // ── Public Getters ──

  get connState() { return this.sig.connState; }
  get roomId() { return this._roomId; }
  get roomMode() { return this.sig.roomMode; }
  get floorState() { return this.sig.floorState; }
  get speaker() { return this.sig.speaker; }
  get facingMode() { return this.media.facingMode; }
  get userVideoOff() { return this._userVideoOff; }

  // ── Connection ──

  connect() { this.sig.connect(); }

  disconnect() {
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

    this.emit("join:phase", { phase: "media" }); // 카메라/마이크 준비

    try {
      await this.media.acquireMedia(enableVideo);
    } catch (e) {
      this.emit("error", { code: 0, msg: `미디어 획득 실패: ${e.message}` });
      return;
    }

    // getUserMedia 성공 후 장치 감시 시작 (label 노출 보장)
    await this.device.start();

    this.emit("join:phase", { phase: "signaling" }); // 서버 입장 요청
    this.sig.send(OP.ROOM_JOIN, { room_id: roomId });
  }

  leaveRoom() {
    if (!this._roomId) return;
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

  // ── Floor Control (MCPTT/MBCP) ──

  floorRequest() { this.sig.floorRequest(); }
  floorRelease() { this.sig.floorRelease(); }

  static PTT_HARD_MUTE_MS = 60_000; // soft_off 60초 후 hard_off 에스컬레이션 (OxLensClient.PTT_HARD_MUTE_MS)

  // ════════════════════════════════════════════════════════════
  //  PTT 선언적 미디어 제어
  //
  //  원칙: floor(TALKING 여부) + _userVideoOff 두 변수만으로 결정.
  //        pttMute/pttUnmute 같은 명령형 함수 없음.
  //        _applyPttMediaState()가 "지금 뭐가 켜져야 하나" 매번 계산.
  //
  //  트랙 상태 전이:
  //    "live"     → "soft_off"  (track.enabled=false, 즉시)
  //    "soft_off" → "live"      (track.enabled=true, 즉시)
  //    "soft_off" → "hard_off"  (60초 후 dummy track 교체)
  //    "hard_off" → "live"      (getUserMedia + replaceTrack)
  // ════════════════════════════════════════════════════════════

  /** SDK 내부에서 floor 이벤트 → 미디어 자동 제어 바인딩 */
  _bindPttMediaControl() {
    const apply = () => this._applyPttMediaState();
    this.on("floor:granted", apply);
    this.on("floor:idle", apply);
    this.on("floor:revoke", apply);
    this.on("floor:released", apply);
  }

  /**
   * 선언적 PTT 미디어 상태 적용.
   * floor 상태 + videoOff 두 변수만 보고 audio/video on/off 계산.
   */
  async _applyPttMediaState() {
    if (this.roomMode !== "ptt") return;

    const talking = this.floorState === FLOOR.TALKING;
    const wantAudio = talking;
    const wantVideo = talking && !this._userVideoOff;

    console.log(`[SDK] _applyPttMediaState: talking=${talking} videoOff=${this._userVideoOff} → audio=${wantAudio} video=${wantVideo}`);

    await this._setPttTrack("audio", wantAudio);
    await this._setPttTrack("video", wantVideo);
  }

  /**
   * PTT 단일 트랙 on/off 전이.
   *   wantOn=true:  soft_off → enabled=true (즉시) / hard_off → getUserMedia
   *   wantOn=false: live → enabled=false + 60s 에스컬레이션 타이머
   */
  async _setPttTrack(kind, wantOn) {
    const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
    if (!sender) return;

    const cur = this._pttTrackState[kind];

    if (wantOn && cur !== "live") {
      // ── Turn ON ──
      clearTimeout(this._pttTimers[kind]);
      this._pttTimers[kind] = null;

      if (cur === "hard_off") {
        await this._pttHardUnmute(kind);
      } else {
        // soft_off → 즉시 복귀
        if (sender.track) sender.track.enabled = true;
      }
      this._pttTrackState[kind] = "live";
      console.log(`[SDK] _setPttTrack: ${kind} → live (from ${cur})`);

    } else if (!wantOn && cur === "live") {
      // ── Turn OFF (soft) ──
      if (sender.track) sender.track.enabled = false;
      this._pttTrackState[kind] = "soft_off";
      console.log(`[SDK] _setPttTrack: ${kind} → soft_off`);

      // 60초 후 hard_off 에스컬레이션
      clearTimeout(this._pttTimers[kind]);
      this._pttTimers[kind] = setTimeout(() => {
        this._pttHardMuteEscalate(kind);
      }, OxLensClient.PTT_HARD_MUTE_MS);
    }
    // wantOn && cur === "live" → 이미 켜짐, noop
    // !wantOn && cur !== "live" → 이미 꺼짐, noop
  }

  /** 60초 에스컬레이션: soft_off → hard_off (dummy track 교체) */
  async _pttHardMuteEscalate(kind) {
    if (this._pttTrackState[kind] !== "soft_off") return;

    const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
    if (!sender) return;

    const dummy = kind === "audio" ? this._createAudioDummyTrack() : this._createVideoDummyTrack();
    this._dummyTracks[kind] = dummy;

    const originalTrack = sender.track;
    if (originalTrack) {
      originalTrack.stop();
      if (this.media.stream) this.media.stream.removeTrack(originalTrack);
    }

    await sender.replaceTrack(dummy);
    this._pttTrackState[kind] = "hard_off";
    console.log(`[SDK] PTT hard mute escalation: ${kind}`);
    this.emit("ptt:escalated", { kind, phase: "hard" });
  }

  /** hard_off → live 복귀 (getUserMedia + replaceTrack) */
  async _pttHardUnmute(kind) {
    const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
    if (!sender) return;

    const gen = ++this._unmuteGeneration[kind];
    const mc = this.mediaConfig;
    const constraints = kind === "audio"
      ? { audio: true, video: false }
      : { audio: false, video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } } };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      this.emit("error", { code: 0, msg: `PTT unmute 미디어 획득 실패: ${e.message}` });
      return;
    }

    const newTrack = kind === "audio" ? newStream.getAudioTracks()[0] : newStream.getVideoTracks()[0];

    // 세대 가드: 비동기 대기 중 disconnect/teardown이 끼어들었으면 중단
    if (this._unmuteGeneration[kind] !== gen || !this.media.audioSender) {
      console.warn(`[SDK] PTT hard unmute aborted (teardown during getUserMedia): kind=${kind}`);
      newTrack.stop();
      return;
    }

    this._destroyDummyTrack(kind);
    await sender.replaceTrack(newTrack);

    const stream = this.media.stream;
    if (stream) {
      const oldTracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      oldTracks.forEach((t) => stream.removeTrack(t));
      stream.addTrack(newTrack);
    }

    this.emit("media:local", stream);

    // video hard unmute → CAMERA_READY (서버가 PLI 2발 + VIDEO_RESUMED 브로드캐스트)
    if (kind === "video") this._sendCameraReady();

    console.log(`[SDK] PTT hard unmute: ${kind}`);
  }

  // ════════════════════════════════════════════════════════════
  //  Mute 3-state 상태 머신 (soft → hard escalation)
  // ════════════════════════════════════════════════════════════

  async toggleMute(kind) {
    // ── PTT 모드 분기 ──
    if (this.roomMode === "ptt") {
      // audio: floor가 소유, 사용자 toggle 불가
      if (kind === "audio") {
        console.log("[SDK] toggleMute(audio) blocked — PTT floor controls audio");
        return;
      }
      // video: _userVideoOff 반전 → 미디어 상태 재계산
      this._userVideoOff = !this._userVideoOff;
      await this._applyPttMediaState();
      this._notifyMuteServer("video", this._userVideoOff);
      this.emit("mute:changed", { kind: "video", muted: this._userVideoOff, phase: "ptt" });
      console.log(`[SDK] PTT video toggle: videoOff=${this._userVideoOff}`);
      return;
    }

    // ── Conference 모드: 기존 3-state 로직 ──
    const state = this._muteState[kind];

    if (state === MUTE.UNMUTED) {
      clearTimeout(this._muteTimers[kind]);
      this._muteTimers[kind] = null;

      this._applySoftMute(kind, true);
      this._muteState[kind] = MUTE.SOFT_MUTED;
      this._notifyMuteServer(kind, true);
      this.emit("mute:changed", { kind, muted: true, phase: "soft" });

      // 5초 후 hard escalation
      this._muteTimers[kind] = setTimeout(async () => {
        if (this._muteState[kind] !== MUTE.SOFT_MUTED) return;
        await this._doHardMute(kind);
        console.log(`[SDK] escalated to hard mute: ${kind}`);
      }, MUTE_ESCALATION_MS);

    } else {
      clearTimeout(this._muteTimers[kind]);
      this._muteTimers[kind] = null;

      if (state === MUTE.SOFT_MUTED) {
        this._applySoftMute(kind, false);
        this._muteState[kind] = MUTE.UNMUTED;
        this._notifyMuteServer(kind, false);
        this.emit("mute:changed", { kind, muted: false, phase: "soft" });
      } else {
        await this._doHardUnmute(kind);
      }
    }
  }

  isMuted(kind) {
    // PTT 모드 video: _userVideoOff가 진실의 원천
    if (this.roomMode === "ptt" && kind === "video") return this._userVideoOff;
    return this._muteState[kind] !== MUTE.UNMUTED;
  }
  getMutePhase(kind) { return this._muteState[kind]; }

  // ── Mute 내부 ──

  _applySoftMute(kind, muted) {
    const stream = this.media.stream;
    if (!stream) return;
    const tracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
    tracks.forEach((t) => { t.enabled = !muted; });
    console.log(`[SDK] _applySoftMute kind=${kind} muted=${muted}`);
  }

  async _doHardMute(kind) {
    const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
    if (!sender) return;

    const dummy = kind === "audio" ? this._createAudioDummyTrack() : this._createVideoDummyTrack();
    this._dummyTracks[kind] = dummy;

    const originalTrack = sender.track;
    if (originalTrack) {
      originalTrack.stop();
      if (this.media.stream) this.media.stream.removeTrack(originalTrack);
    }

    await sender.replaceTrack(dummy);
    this._muteState[kind] = MUTE.HARD_MUTED;
    this.emit("mute:changed", { kind, muted: true, phase: "hard" });
    console.log(`[SDK] _doHardMute kind=${kind}`);
  }

  async _doHardUnmute(kind) {
    const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
    if (!sender) return;

    const gen = ++this._unmuteGeneration[kind];
    const mc = this.mediaConfig;
    const constraints = kind === "audio"
      ? { audio: true, video: false }
      : { audio: false, video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } } };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      this.emit("error", { code: 0, msg: `unmute 미디어 획득 실패: ${e.message}` });
      return;
    }

    const newTrack = kind === "audio" ? newStream.getAudioTracks()[0] : newStream.getVideoTracks()[0];

    // 세대 가드: 비동기 대기 중 다른 toggleMute가 끼어들었으면 중단
    if (this._unmuteGeneration[kind] !== gen) {
      console.warn(`[SDK] hard unmute aborted (gen mismatch): kind=${kind}`);
      newTrack.stop();
      return;
    }

    this._destroyDummyTrack(kind);
    await sender.replaceTrack(newTrack);

    const stream = this.media.stream;
    if (stream) {
      const oldTracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      oldTracks.forEach((t) => stream.removeTrack(t));
      stream.addTrack(newTrack);
    }

    this._muteState[kind] = MUTE.UNMUTED;
    this._notifyMuteServer(kind, false);
    this.emit("media:local", stream);
    this.emit("mute:changed", { kind, muted: false, phase: "hard" });

    // video hard unmute → CAMERA_READY (서버가 PLI 2발 + VIDEO_RESUMED 브로드캐스트)
    if (kind === "video") this._sendCameraReady();

    console.log(`[SDK] _doHardUnmute kind=${kind}`);
  }

  _notifyMuteServer(kind, muted) {
    const ssrc = this.media.getPublishSsrc(kind);
    if (ssrc) this.sig.send(OP.MUTE_UPDATE, { ssrc, muted });
  }

  /** 카메라 웜업 완료 → 서버에 CAMERA_READY 전송 (PLI 2발 + VIDEO_RESUMED 트리거) */
  _sendCameraReady() {
    if (!this._roomId) return;
    this.sig.send(OP.CAMERA_READY, { room_id: this._roomId });
    console.log("[SDK] CAMERA_READY sent");
  }

  // ── Dummy Track 팩토리 ──

  _createAudioDummyTrack() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain);
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    oscillator.start();
    const track = dest.stream.getAudioTracks()[0];
    track._dummyCtx = ctx;
    track._dummyOscillator = oscillator;
    return track;
  }

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

  _destroyDummyTrack(kind) {
    const dummy = this._dummyTracks[kind];
    if (!dummy) return;
    if (dummy._dummyCtx) {
      dummy._dummyOscillator?.stop();
      dummy._dummyCtx.close().catch(() => {});
    }
    dummy.stop();
    this._dummyTracks[kind] = null;
  }

  _resetMute() {
    clearTimeout(this._muteTimers.audio);
    clearTimeout(this._muteTimers.video);
    this._muteTimers = { audio: null, video: null };
    this._muteState = { audio: MUTE.UNMUTED, video: MUTE.UNMUTED };
    this._destroyDummyTrack("audio");
    this._destroyDummyTrack("video");
    this._unmuteGeneration = { audio: 0, video: 0 };
    // PTT state reset — "live"로 초기화 (재입장 시 _onJoinOk에서 _applyPttMediaState 호출)
    clearTimeout(this._pttTimers.audio);
    clearTimeout(this._pttTimers.video);
    this._pttTimers = { audio: null, video: null };
    this._pttTrackState = { audio: "live", video: "live" };
    this._userVideoOff = false;
  }

  // ════════════════════════════════════════════════════════════
  //  내부 조율 (Signaling → MediaSession + Telemetry)
  // ════════════════════════════════════════════════════════════

  /** signaling._handleResponse(ROOM_JOIN) → 여기로 */
  async _onJoinOk(d) {
    const { server_config, tracks, participants, mode, ptt_virtual_ssrc } = d;

    if (!server_config) {
      this.emit("error", { code: 4001, msg: "server_config missing in ROOM_JOIN response" });
      return;
    }

    try {
      await this.media.setup(server_config, tracks, { mode, pttVirtualSsrc: ptt_virtual_ssrc });
    } catch (e) {
      console.error("[SDK] 2PC setup failed:", e);
      this.emit("error", { code: 4002, msg: `2PC setup failed: ${e.message}` });
      return;
    }

    this.emit("room:joined", { ...d, participants });
    this.tel.start();

    // 초기 트랙에 대한 TRACKS_ACK (입장 시 받은 트랙 목록 확인)
    this.media.sendTracksAck();

    // PTT 모드: 초기 미디어 상태 적용 (floor=IDLE → audio/video 전부 off)
    if (this.roomMode === "ptt") {
      await this._applyPttMediaState();
    }

    // 구간 S-1: SDP 상태 1회 보고 (PC 안정화 후)
    setTimeout(() => this.tel.sendSdpTelemetry(), 2000);
  }

  /** signaling._handleEvent(TRACKS_UPDATE) → 여기로 */
  async _onTracksUpdate(d) {
    const { action, tracks } = d;

    try {
      await this.media.onTracksUpdate(action, tracks);
      // subscribe PC 변경 시 SDP telemetry 재전송
      setTimeout(() => this.tel.sendSdpTelemetry(), 1000);
    } catch (e) {
      console.error("[SDK] subscribe re-nego failed:", e);
      this.emit("error", { code: 4003, msg: `subscribe re-nego failed: ${e.message}` });
    }

    // TRACKS_ACK: 현재 인식한 SSRC set 서버에 보고
    this.media.sendTracksAck();
    this.emit("tracks:update", d);
  }

  /** signaling._handleEvent(TRACKS_RESYNC) → subscribe PC 통째 재생성 */
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

    // RESYNC 완료 후 다시 TRACKS_ACK
    this.media.sendTracksAck();
    this.emit("tracks:resync", d);
  }
}

// ============================================================
//  Exports — app.js 하위 호환
// ============================================================
export { SDK_VERSION, CONN, OP, MUTE, FLOOR, DEVICE_KIND };
