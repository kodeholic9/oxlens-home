// author: kodeholic (powered by Claude)
// client.js — OxLens Client SDK (2PC / SDP-free)
//
// Facade: 앱이 사용하는 Public API 제공.
// 내부 모듈 조립: Signaling + MediaSession + Telemetry
//
// Mute 제어 이원화:
//   Conference 모드: 3-state 상태 머신 (UNMUTED → SOFT → HARD)
//   PTT 모드:       Power State FSM (HOT → HOT-STANDBY → WARM → COLD)
//                    audio=floor가 소유, video=사용자 toggle 허용
//
// 모듈 구조:
//   constants.js      → 공용 상수 (OP, CONN, MUTE, FLOOR, DEVICE_KIND)
//   signaling.js      → WS + 패킷 dispatch + Floor FSM
//   media-session.js   → Publish/Subscribe PC + 미디어
//   device-manager.js  → 장치 열거/전환/핵플러그
//   telemetry.js      → stats 수집 + 서버 전송
//   sdp-builder.js    → fake SDP 조립 (기존 유지)

import { SDK_VERSION, OP, CONN, MUTE, FLOOR, MUTE_ESCALATION_MS, DEVICE_KIND, PTT_POWER } from "./constants.js";
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

    // --- PTT Power State FSM (HOT / HOT-STANDBY / WARM / COLD) ---
    // _pttPower 변경은 오직 _setPttPower() 만 가능
    this._pttPower = PTT_POWER.HOT;
    this._pttPowerTimer = null;     // 단일 타이머: 다음 전이만 예약
    this._pttPowerConfig = { hotStandbyMs: 10_000, warmMs: 60_000, coldMs: 0 };
    this._pttTalking = false;
    this._userVideoOff = false;

    // Simulcast
    this._simulcastEnabled = false;

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
      // 비디오 포함 실패 → 오디오만으로 fallback
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

  floorRequest() {
    this._setPttPower(PTT_POWER.HOT);
    this.sig.floorRequest();
  }
  floorRelease() { this.sig.floorRelease(); }

  // ── PTT Power State 공개 API ──

  set pttPowerConfig(cfg) {
    if (cfg.hotStandbyMs !== undefined) this._pttPowerConfig.hotStandbyMs = cfg.hotStandbyMs;
    if (cfg.warmMs !== undefined) this._pttPowerConfig.warmMs = cfg.warmMs;
    if (cfg.coldMs !== undefined) this._pttPowerConfig.coldMs = cfg.coldMs;
    console.log(`[SDK] pttPowerConfig: HOT-STANDBY=${this._pttPowerConfig.hotStandbyMs}ms WARM=${this._pttPowerConfig.warmMs}ms COLD=${this._pttPowerConfig.coldMs}ms`);
  }
  get pttPowerConfig() { return { ...this._pttPowerConfig }; }
  get pttPowerState() { return this._pttPower; }

  // ════════════════════════════════════════════════════════════
  //  PTT Power State FSM (HOT → HOT-STANDBY → WARM → COLD)
  //
  //  단일 진입점: _setPttPower(next)
  //  - _pttPower 변경은 오직 이 함수만 가능
  //  - 타이머는 하나만: 현재 상태의 다음 전이
  //  - async 부수효과는 전이 후 상태 재확인으로 안전
  //
  //  하강: HOT →(T1)→ HOT-STANDBY →(T2)→ WARM →(T3)→ COLD
  //  상승: 어떤 상태든 → HOT (트리거 발생 시)
  // ════════════════════════════════════════════════════════════

  /** floor 이벤트 → Power State FSM 바인딩 */
  _bindPttMediaControl() {
    this.on("floor:granted", () => {
      this._pttTalking = true;
      this._setPttPower(PTT_POWER.HOT);
    });
    this.on("floor:taken",    () => this._setPttPower(PTT_POWER.HOT));
    this.on("floor:released", () => { this._pttTalking = false; this._setPttPower(PTT_POWER.HOT); });
    this.on("floor:revoke",   () => { this._pttTalking = false; this._setPttPower(PTT_POWER.HOT); });
    this.on("floor:idle",     () => { this._pttTalking = false; this._setPttPower(PTT_POWER.HOT); });
  }

  /**
   * PTT Power State 단일 진입점.
   * _pttPower 변경은 오직 여기서만 일어난다.
   */
  _setPttPower(next) {
    if (this.roomMode !== "ptt") return;
    const prev = this._pttPower;
    if (prev === next && next !== PTT_POWER.HOT) return;  // HOT은 타이머 리셋을 위해 재진입 허용

    // 1. 타이머 취소 (항상)
    clearTimeout(this._pttPowerTimer);
    this._pttPowerTimer = null;

    // 2. 상태 변경 (유일한 변경점)
    this._pttPower = next;

    // 3. 진입 액션 (async 부수효과)
    this._onPowerEnter(prev, next);

    // 4. 다음 전이 타이머 예약 (하강 + 비발화 시만)
    if (!this._pttTalking) {
      this._schedulePowerDown();
    }

    // 5. 이벤트 + 로그
    if (prev !== next) {
      console.log(`[SDK] power: ${prev} \u2192 ${next}`);
      this.emit("ptt:power", { state: next, prev });
    }
  }

  /**
   * 전이 진입 액션.
   * 동기 액션은 즉시, async 액션은 완료 후 상태 재확인.
   */
  _onPowerEnter(prev, next) {
    // ── 상승 (X → HOT) ──
    if (next === PTT_POWER.HOT) {
      if (prev === PTT_POWER.HOT_STANDBY) {
        // 즉시 복귀: track.enabled = true
        this._pttSetTracksEnabled(true);
      } else if (prev === PTT_POWER.WARM || prev === PTT_POWER.COLD) {
        // async 복귀: getUserMedia + replaceTrack
        this._pttRestoreTracks();
      }
      // 발화 중이면 트랙 활성화
      if (this._pttTalking) this._pttSetTracksEnabled(true);
      return;
    }

    // ── 하강 ──
    if (next === PTT_POWER.HOT_STANDBY) {
      this._pttSetTracksEnabled(false);
    } else if (next === PTT_POWER.WARM) {
      this._pttReplaceDummy();  // async, 완료 후 상태 확인
    } else if (next === PTT_POWER.COLD) {
      this._pttReplaceNull();   // async, 완료 후 상태 확인
    }
  }

  /** 현재 상태 기준으로 다음 하강 타이머 예약 */
  _schedulePowerDown() {
    const { HOT, HOT_STANDBY, WARM } = PTT_POWER;
    const cfg = this._pttPowerConfig;
    let delayMs = 0;
    let target = null;

    if (this._pttPower === HOT) {
      delayMs = cfg.hotStandbyMs;
      target = HOT_STANDBY;
    } else if (this._pttPower === HOT_STANDBY) {
      delayMs = cfg.warmMs;
      target = WARM;
    } else if (this._pttPower === WARM && cfg.coldMs > 0) {
      delayMs = cfg.coldMs;
      target = PTT_POWER.COLD;
    }

    if (!target) return;  // COLD 또는 coldMs===0 → 더 이상 하강 없음

    if (delayMs <= 0) {
      // 즉시 전이
      this._setPttPower(target);
    } else {
      this._pttPowerTimer = setTimeout(() => this._setPttPower(target), delayMs);
    }
  }

  // ── Power State 부수효과 (동기) ──

  /** 모든 sender track의 enabled 제어 */
  _pttSetTracksEnabled(on) {
    for (const kind of ["audio", "video"]) {
      if (on && kind === "video" && this._userVideoOff) continue;
      const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
      if (sender?.track && !sender.track._dummyCtx && !sender.track._dummyCanvas) {
        sender.track.enabled = on;
      }
    }
  }

  // ── Power State 부수효과 (async — 완료 후 상태 재확인) ──

  /** HOT-STANDBY → WARM: dummy track 교체 */
  async _pttReplaceDummy() {
    for (const kind of ["audio", "video"]) {
      if (this._pttPower !== PTT_POWER.WARM) return;  // 상태 변경됨 → 중단
      const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
      if (!sender) continue;

      const dummy = kind === "audio" ? this._createAudioDummyTrack() : this._createVideoDummyTrack();
      this._dummyTracks[kind] = dummy;

      const orig = sender.track;
      if (orig) {
        orig.stop();
        if (this.media.stream) this.media.stream.removeTrack(orig);
      }
      await sender.replaceTrack(dummy);
    }
  }

  /** WARM → COLD: replaceTrack(null) */
  async _pttReplaceNull() {
    for (const kind of ["audio", "video"]) {
      if (this._pttPower !== PTT_POWER.COLD) return;  // 상태 변경됨 → 중단
      const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
      if (!sender) continue;
      this._destroyDummyTrack(kind);
      await sender.replaceTrack(null);
    }
  }

  /** WARM/COLD → HOT: getUserMedia로 장치 복원 */
  async _pttRestoreTracks() {
    const mc = this.mediaConfig;

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } },
      });
    } catch (e) {
      try {
        newStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.emit("media:fallback", { dropped: "video", reason: e.message });
      } catch (e2) {
        this.emit("error", { code: 0, msg: `PTT wake 미디어 복원 실패: ${e2.message}` });
        return;
      }
    }

    // 상태 확인: await 사이 다른 전이가 발생했으면 중단
    if (this._pttPower !== PTT_POWER.HOT || !this.media.audioSender) {
      newStream.getTracks().forEach(t => t.stop());
      return;
    }

    let videoRestored = false;
    for (const kind of ["audio", "video"]) {
      this._destroyDummyTrack(kind);
      const sender = kind === "audio" ? this.media.audioSender : this.media.videoSender;
      if (!sender) continue;

      const newTrack = kind === "audio"
        ? newStream.getAudioTracks()[0]
        : newStream.getVideoTracks()[0];
      if (!newTrack) continue;

      await sender.replaceTrack(newTrack);
      if (this._pttPower !== PTT_POWER.HOT) return;  // await 사이 전이

      if (this.media.stream) {
        const old = kind === "audio" ? this.media.stream.getAudioTracks() : this.media.stream.getVideoTracks();
        old.forEach(t => this.media.stream.removeTrack(t));
        this.media.stream.addTrack(newTrack);
      }
      if (kind === "video") videoRestored = true;
    }

    this.emit("media:local", this.media.stream);
    if (videoRestored) this._sendCameraReady();
  }

  /** PTT 모드 초기 미디어 상태 적용 (입장 직후 floor=IDLE → power-down 시작) */
  _applyPttMediaState() {
    if (this.roomMode !== "ptt") return;
    this._pttTalking = false;
    this._setPttPower(PTT_POWER.HOT);  // HOT에서 power-down 시작
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
      // video: _userVideoOff 반전 → 현재 상태에 따라 트랙 제어
      this._userVideoOff = !this._userVideoOff;
      const sender = this.media.videoSender;
      if (sender?.track && this._pttPower === PTT_POWER.HOT) {
        sender.track.enabled = !this._userVideoOff;
      }
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
    // PTT Power State 리셋
    clearTimeout(this._pttPowerTimer);
    this._pttPowerTimer = null;
    this._pttPower = PTT_POWER.HOT;
    this._pttTalking = false;
    this._userVideoOff = false;
    this._simulcastEnabled = false;
  }

  // ════════════════════════════════════════════════════════════
  //  내부 조율 (Signaling → MediaSession + Telemetry)
  // ════════════════════════════════════════════════════════════

  /** signaling._handleResponse(ROOM_JOIN) → 여기로 */
  async _onJoinOk(d) {
    const { server_config, tracks, participants, mode, ptt_virtual_ssrc, simulcast } = d;

    if (!server_config) {
      this.emit("error", { code: 4001, msg: "server_config missing in ROOM_JOIN response" });
      return;
    }

    // Simulcast 플래그 저장
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
    // PTT power state: tracks update → wake to HOT
    if (this.roomMode === "ptt") this._setPttPower(PTT_POWER.HOT);

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
export { SDK_VERSION, CONN, OP, MUTE, FLOOR, DEVICE_KIND, PTT_POWER };
