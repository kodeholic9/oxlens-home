// author: kodeholic (powered by Claude)
// ptt/power-fsm.js — PTT Power State FSM (HOT → HOT-STANDBY → WARM → COLD)
//
// 책임:
//   - 4단계 전력 상태 관리 (장치/인코더/RTP 단계별 제어)
//   - 하강 타이머: HOT →(T1)→ HOT-STANDBY →(T2)→ WARM →(T3)→ COLD
//   - 상승 트리거: floor 이벤트 + visibilitychange + online + connection change
//   - async 부수효과: dummy track 교체, null 교체, getUserMedia 복원
//   - race condition 방어: await 후 상태 재확인
//   - 사용자 mute lock: COLD 고정 + 모든 wake 트리거 무시
//   - LISTENING/TALKING/QUEUED 중에는 power-down 타이머 중단 (HOT 유지)
//   - WARM→HOT 복원 시 이전 카메라 설정(deviceId/facingMode) 보존
//
// 단일 진입점: _set(next) — _state 변경은 오직 이 함수만 가능
// _userMuteLock: 사용자가 mute → COLD 고정, wake 거부. unmute → 해제 → HOT

import { OP, FLOOR, PTT_POWER } from "../constants.js";

export class PowerFsm {
  constructor(sdk) {
    this.sdk = sdk;

    this._state = PTT_POWER.HOT;
    this._timer = null;           // 단일 타이머: 다음 전이만 예약
    this._config = { hotStandbyMs: 10_000, warmMs: 60_000, coldMs: 0 };
    this._talking = false;
    this._userVideoOff = false;
    this._userMuteLock = false;  // 사용자 mute → COLD 고정, wake 거부
    this._dummyTracks = { audio: null, video: null };

    // 카메라 설정 보존 (WARM 진입 시 저장 → HOT 복귀 시 복원)
    this._savedVideoConstraints = null;

    // detach 시 해제할 이벤트 핸들러/리스너 참조
    this._floorHandlers = {};
    this._wakeHandlers = {};
  }

  // ── Getters ──

  get state() { return this._state; }
  get userVideoOff() { return this._userVideoOff; }
  get muteLocked() { return this._userMuteLock; }

  set config(cfg) {
    if (cfg.hotStandbyMs !== undefined) this._config.hotStandbyMs = cfg.hotStandbyMs;
    if (cfg.warmMs !== undefined) this._config.warmMs = cfg.warmMs;
    if (cfg.coldMs !== undefined) this._config.coldMs = cfg.coldMs;
    console.log(`[POWER] config: HOT-STANDBY=${this._config.hotStandbyMs}ms WARM=${this._config.warmMs}ms COLD=${this._config.coldMs}ms`);
  }
  get config() { return { ...this._config }; }

  // ── 라이프사이클 ──

  attach() {
    // floor 이벤트 → power 전이 바인딩
    this._floorHandlers = {
      granted:  () => { this._talking = true;  this._set(PTT_POWER.HOT); },
      taken:    () => this._set(PTT_POWER.HOT),
      released: () => { this._talking = false; this._set(PTT_POWER.HOT); },
      revoke:   () => { this._talking = false; this._set(PTT_POWER.HOT); },
      idle:     () => { this._talking = false; this._set(PTT_POWER.HOT); },
    };

    this.sdk.on("floor:granted",  this._floorHandlers.granted);
    this.sdk.on("floor:taken",    this._floorHandlers.taken);
    this.sdk.on("floor:released", this._floorHandlers.released);
    this.sdk.on("floor:revoke",   this._floorHandlers.revoke);
    this.sdk.on("floor:idle",     this._floorHandlers.idle);

    // wake 트리거 (이전에 app.js에 있던 것들)
    this._wakeHandlers = {
      visibility: () => {
        if (document.visibilityState === "visible") {
          this._set(PTT_POWER.HOT);
          console.log("[POWER:WAKE] visibilitychange → visible");
        }
      },
      online: () => {
        this._set(PTT_POWER.HOT);
        console.log("[POWER:WAKE] network online");
      },
      connection: () => {
        this._set(PTT_POWER.HOT);
        console.log(`[POWER:WAKE] network change (type=${navigator.connection?.effectiveType})`);
      },
    };

    document.addEventListener("visibilitychange", this._wakeHandlers.visibility);
    window.addEventListener("online", this._wakeHandlers.online);
    if (navigator.connection) {
      navigator.connection.addEventListener("change", this._wakeHandlers.connection);
    }

    // 초기 상태: HOT에서 power-down 시작
    this._talking = false;
    this._set(PTT_POWER.HOT);
  }

  detach() {
    // 타이머 정리
    clearTimeout(this._timer);
    this._timer = null;

    // floor 이벤트 해제
    this.sdk.off("floor:granted",  this._floorHandlers.granted);
    this.sdk.off("floor:taken",    this._floorHandlers.taken);
    this.sdk.off("floor:released", this._floorHandlers.released);
    this.sdk.off("floor:revoke",   this._floorHandlers.revoke);
    this.sdk.off("floor:idle",     this._floorHandlers.idle);
    this._floorHandlers = {};

    // wake 트리거 해제
    document.removeEventListener("visibilitychange", this._wakeHandlers.visibility);
    window.removeEventListener("online", this._wakeHandlers.online);
    if (navigator.connection) {
      navigator.connection.removeEventListener("change", this._wakeHandlers.connection);
    }
    this._wakeHandlers = {};

    // dummy track 정리
    this._destroyDummyTrack("audio");
    this._destroyDummyTrack("video");

    // 상태 리셋
    this._state = PTT_POWER.HOT;
    this._talking = false;
    this._userVideoOff = false;
    this._userMuteLock = false;
    this._savedVideoConstraints = null;
  }

  // ── Public API ──

  /** 외부 트리거에 의한 즉시 HOT 복귀 (mute lock 시 무시) */
  wake() {
    if (this._userMuteLock) return;  // 사용자 mute → wake 거부
    this._set(PTT_POWER.HOT);
  }

  /**
   * 사용자 mute: COLD 고정 + 모든 wake 트리거 무시.
   * "나 지금 안 할래" — floor보다 우선.
   */
  mute() {
    this._userMuteLock = true;
    this._set(PTT_POWER.COLD);
    this.sdk.emit("mute:changed", { kind: "all", muted: true });
    console.log("[POWER] user mute → COLD locked");
  }

  /**
   * 사용자 unmute: COLD 해제 → HOT 복귀.
   */
  unmute() {
    this._userMuteLock = false;
    this._set(PTT_POWER.HOT);
    this.sdk.emit("mute:changed", { kind: "all", muted: false });
    console.log("[POWER] user unmute → COLD released → HOT");
  }

  /** mute 상태 조회 */
  isMuted() { return this._userMuteLock; }

  /** PTT video toggle (_userVideoOff 반전 + track 제어) */
  toggleVideo() {
    this._userVideoOff = !this._userVideoOff;
    const sender = this.sdk.media.videoSender;
    if (sender?.track && this._state === PTT_POWER.HOT) {
      sender.track.enabled = !this._userVideoOff;
    }
    this._notifyMuteServer("video", this._userVideoOff);
    this.sdk.emit("mute:changed", { kind: "video", muted: this._userVideoOff, phase: "ptt" });
    console.log(`[POWER] PTT video toggle: videoOff=${this._userVideoOff}`);
  }

  // ════════════════════════════════════════════════════════════
  //  단일 진입점 — _state 변경은 오직 여기서만
  // ════════════════════════════════════════════════════════════

  _set(next) {
    // mute lock: COLD 고정 — HOT/HOT_STANDBY/WARM 전이 거부 (COLD만 허용)
    if (this._userMuteLock && next !== PTT_POWER.COLD) return;

    const prev = this._state;
    if (prev === next && next !== PTT_POWER.HOT) return;  // HOT은 타이머 리셋 위해 재진입 허용

    // 1. 타이머 취소
    clearTimeout(this._timer);
    this._timer = null;

    // 2. 상태 변경
    this._state = next;

    // 3. 진입 액션
    this._onEnter(prev, next);

    // 4. 다음 전이 타이머 예약 (floor IDLE일 때만)
    this._scheduleDown();

    // 5. 이벤트 + 로그
    if (prev !== next) {
      console.log(`[POWER] ${prev} → ${next}`);
      this.sdk.emit("ptt:power", { state: next, prev });
    }
  }

  // ── 진입 액션 ──

  _onEnter(prev, next) {
    // ── 상승 (X → HOT) ──
    if (next === PTT_POWER.HOT) {
      if (prev === PTT_POWER.HOT_STANDBY) {
        this._setTracksEnabled(true);
      } else if (prev === PTT_POWER.WARM || prev === PTT_POWER.COLD) {
        this._restoreTracks();  // async
      }
      if (this._talking) this._setTracksEnabled(true);
      return;
    }

    // ── 하강 ──
    if (next === PTT_POWER.HOT_STANDBY) {
      this._setTracksEnabled(false);
    } else if (next === PTT_POWER.WARM) {
      this._replaceDummy();    // async
    } else if (next === PTT_POWER.COLD) {
      this._replaceNull();     // async
    }
  }

  /**
   * 다음 하강 타이머 예약.
   * floor가 IDLE일 때만 예약 — LISTENING/TALKING/QUEUED에서는 HOT 유지.
   */
  _scheduleDown() {
    // floor 활성 상태면 타이머 예약 안 함 (수신/발화/대기 중 HOT 유지)
    const floorState = this.sdk.ptt?.floorState;
    if (floorState === FLOOR.LISTENING || floorState === FLOOR.TALKING || floorState === FLOOR.QUEUED) {
      return;
    }

    const { HOT, HOT_STANDBY, WARM } = PTT_POWER;
    const cfg = this._config;
    let delayMs = 0;
    let target = null;

    if (this._state === HOT) {
      delayMs = cfg.hotStandbyMs;
      target = HOT_STANDBY;
    } else if (this._state === HOT_STANDBY) {
      delayMs = cfg.warmMs;
      target = WARM;
    } else if (this._state === WARM && cfg.coldMs > 0) {
      delayMs = cfg.coldMs;
      target = PTT_POWER.COLD;
    }

    if (!target) return;

    if (delayMs <= 0) {
      this._set(target);
    } else {
      this._timer = setTimeout(() => this._set(target), delayMs);
    }
  }

  // ── 부수효과 (동기) ──

  _setTracksEnabled(on) {
    for (const kind of ["audio", "video"]) {
      if (on && kind === "video" && this._userVideoOff) continue;
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (sender?.track && !sender.track._dummyCtx && !sender.track._dummyCanvas) {
        sender.track.enabled = on;
      }
    }
  }

  // ── 카메라 설정 보존 ──

  /** 현재 비디오 트랙의 deviceId/facingMode 저장 */
  _saveVideoConstraints() {
    const track = this.sdk.media.stream?.getVideoTracks()?.[0];
    if (!track) {
      this._savedVideoConstraints = null;
      return;
    }
    const settings = track.getSettings();
    this._savedVideoConstraints = {
      deviceId: settings.deviceId || null,
      facingMode: settings.facingMode || null,
    };
    console.log(`[POWER] video constraints saved: deviceId=${settings.deviceId?.slice(0, 12)} facingMode=${settings.facingMode}`);
  }

  /** 저장된 constraints → getUserMedia video 옵션 생성 */
  _buildVideoConstraints() {
    const mc = this.sdk.mediaConfig;
    const base = { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } };

    if (!this._savedVideoConstraints) return base;

    const { deviceId, facingMode } = this._savedVideoConstraints;
    if (deviceId) {
      base.deviceId = { exact: deviceId };
    } else if (facingMode) {
      base.facingMode = { ideal: facingMode };
    }
    return base;
  }

  // ── 부수효과 (async — 완료 후 상태 재확인) ──

  async _replaceDummy() {
    // WARM 진입 전 현재 카메라 설정 저장
    this._saveVideoConstraints();

    for (const kind of ["audio", "video"]) {
      if (this._state !== PTT_POWER.WARM) return;
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (!sender) continue;

      const dummy = kind === "audio" ? this._createAudioDummyTrack() : this._createVideoDummyTrack();
      this._dummyTracks[kind] = dummy;

      const orig = sender.track;
      if (orig) {
        orig.stop();
        if (this.sdk.media.stream) this.sdk.media.stream.removeTrack(orig);
      }
      await sender.replaceTrack(dummy);
    }
  }

  async _replaceNull() {
    // COLD 진입 시에도 카메라 설정 보존 (WARM에서 이미 저장했으면 유지)
    if (!this._savedVideoConstraints) {
      this._saveVideoConstraints();
    }

    for (const kind of ["audio", "video"]) {
      if (this._state !== PTT_POWER.COLD) return;
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (!sender) continue;
      this._destroyDummyTrack(kind);
      await sender.replaceTrack(null);
    }
  }

  async _restoreTracks() {
    const videoConstraints = this._buildVideoConstraints();

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: videoConstraints,
      });
    } catch (e) {
      // 저장된 deviceId로 실패 → 기본 카메라로 fallback
      console.warn(`[POWER] getUserMedia with saved constraints failed: ${e.message}, trying default`);
      try {
        const mc = this.sdk.mediaConfig;
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } },
        });
      } catch (e2) {
        try {
          newStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          this.sdk.emit("media:fallback", { dropped: "video", reason: e2.message });
        } catch (e3) {
          this.sdk.emit("error", { code: 0, msg: `PTT wake 미디어 복원 실패: ${e3.message}` });
          return;
        }
      }
    }

    // await 사이 전이 방어
    if (this._state !== PTT_POWER.HOT || !this.sdk.media.audioSender) {
      newStream.getTracks().forEach(t => t.stop());
      return;
    }

    let videoRestored = false;
    for (const kind of ["audio", "video"]) {
      this._destroyDummyTrack(kind);
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (!sender) continue;

      const newTrack = kind === "audio"
        ? newStream.getAudioTracks()[0]
        : newStream.getVideoTracks()[0];
      if (!newTrack) continue;

      await sender.replaceTrack(newTrack);
      if (this._state !== PTT_POWER.HOT) return;

      if (this.sdk.media.stream) {
        const old = kind === "audio" ? this.sdk.media.stream.getAudioTracks() : this.sdk.media.stream.getVideoTracks();
        old.forEach(t => this.sdk.media.stream.removeTrack(t));
        this.sdk.media.stream.addTrack(newTrack);
      }
      if (kind === "video") videoRestored = true;
    }

    this._savedVideoConstraints = null;  // 복원 완료 → 캐시 클리어
    this.sdk.emit("media:local", this.sdk.media.stream);
    if (videoRestored) this._sendCameraReady();
  }

  // ── 서버 통신 헬퍼 ──

  _notifyMuteServer(kind, muted) {
    const ssrc = this.sdk.media.getPublishSsrc(kind);
    if (ssrc) this.sdk.sig.send(OP.MUTE_UPDATE, { ssrc, muted });
  }

  _sendCameraReady() {
    if (!this.sdk._roomId) return;
    this.sdk.sig.send(OP.CAMERA_READY, { room_id: this.sdk._roomId });
    console.log("[POWER] CAMERA_READY sent");
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
}
