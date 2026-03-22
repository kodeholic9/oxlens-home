// author: kodeholic (powered by Claude)
// ptt/power-fsm.js — PTT Power State FSM (HOT → HOT-STANDBY → COLD)
//
// 책임:
//   - 3단계 전력 상태 관리
//     HOT:         정상 동작 (audio/video enabled)
//     HOT-STANDBY: enabled=false (브라우저가 W3C 스펙에 따라 장치 자동 해제)
//     COLD:        track 완전 해제 (replaceTrack(null))
//   - 하강 타이머: HOT →(T1)→ HOT-STANDBY →(T2)→ COLD
//   - 상승 트리거: floor 이벤트 + visibilitychange + online + connection change
//   - HOT-STANDBY→HOT: enabled=true (즉시, getUserMedia 불필요)
//   - COLD→HOT: getUserMedia + timeout(5초) + retry(1회)
//   - LISTENING/TALKING/QUEUED 중에는 power-down 타이머 중단 (HOT 유지)
//   - 사용자 mute lock: COLD 고정 + 모든 wake 트리거 무시
//
// 설계 근거 (v0.6.5):
//   WARM 단계 폐기 — dummy canvas track 교체 방식이 getUserMedia hang을 유발.
//   W3C Media Capture 스펙: enabled=false 시 UA가 장치를 3초 이내 해제(SHOULD),
//   re-enabled 시 자동 재취득(SHOULD). getUserMedia 호출 없이 장치 해제/복원 가능.
//   COLD→HOT에서만 getUserMedia 호출하되, timeout으로 hang 방어.
//
// 단일 진입점: _set(next) — _state 변경은 오직 이 함수만 가능

import { OP, FLOOR, PTT_POWER } from "../constants.js";

/** getUserMedia에 timeout을 걸어 hang 방어 */
function gumWithTimeout(constraints, ms = 5000) {
  return Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`getUserMedia timeout ${ms}ms`)), ms)
    ),
  ]);
}

export class PowerFsm {
  constructor(sdk) {
    this.sdk = sdk;

    this._state = PTT_POWER.HOT;
    this._timer = null;           // 단일 타이머: 다음 전이만 예약
    this._config = { hotStandbyMs: 10_000, coldMs: 60_000 };
    this._talking = false;
    this._userVideoOff = false;
    this._userMuteLock = false;  // 사용자 mute → COLD 고정, wake 거부

    // 카메라 설정 보존 (COLD 진입 시 저장 → HOT 복귀 시 복원)
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
    if (cfg.coldMs !== undefined) this._config.coldMs = cfg.coldMs;
    console.log(`[POWER] config: HOT-STANDBY=${this._config.hotStandbyMs}ms COLD=${this._config.coldMs}ms`);
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

    // wake 트리거
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
    clearTimeout(this._timer);
    this._timer = null;

    this.sdk.off("floor:granted",  this._floorHandlers.granted);
    this.sdk.off("floor:taken",    this._floorHandlers.taken);
    this.sdk.off("floor:released", this._floorHandlers.released);
    this.sdk.off("floor:revoke",   this._floorHandlers.revoke);
    this.sdk.off("floor:idle",     this._floorHandlers.idle);
    this._floorHandlers = {};

    document.removeEventListener("visibilitychange", this._wakeHandlers.visibility);
    window.removeEventListener("online", this._wakeHandlers.online);
    if (navigator.connection) {
      navigator.connection.removeEventListener("change", this._wakeHandlers.connection);
    }
    this._wakeHandlers = {};

    this._state = PTT_POWER.HOT;
    this._talking = false;
    this._userVideoOff = false;
    this._userMuteLock = false;
    this._savedVideoConstraints = null;
  }

  // ── Public API ──

  wake() {
    if (this._userMuteLock) return;
    this._set(PTT_POWER.HOT);
  }

  mute() {
    this._userMuteLock = true;
    this._set(PTT_POWER.COLD);
    this.sdk.emit("mute:changed", { kind: "all", muted: true });
    console.log("[POWER] user mute → COLD locked");
  }

  unmute() {
    this._userMuteLock = false;
    this._set(PTT_POWER.HOT);
    this.sdk.emit("mute:changed", { kind: "all", muted: false });
    console.log("[POWER] user unmute → COLD released → HOT");
  }

  isMuted() { return this._userMuteLock; }

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
    if (this._userMuteLock && next !== PTT_POWER.COLD) return;

    const prev = this._state;
    if (prev === next && next !== PTT_POWER.HOT) return;

    clearTimeout(this._timer);
    this._timer = null;

    this._state = next;
    this._onEnter(prev, next);
    this._scheduleDown();

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
        // enabled=true만으로 즉시 복원 (getUserMedia 불필요)
        this._enableTracks(true);
      } else if (prev === PTT_POWER.COLD) {
        this._restoreTracks();  // async — getUserMedia + timeout
      }
      if (this._talking) this._enableTracks(true);
      return;
    }

    // ── 하강 ──
    if (next === PTT_POWER.HOT_STANDBY) {
      // W3C 스펙: enabled=false → 브라우저가 3초 이내 장치 해제(SHOULD)
      // re-enabled 시 자동 재취득(SHOULD) — getUserMedia 불필요
      this._enableTracks(false);
    } else if (next === PTT_POWER.COLD) {
      this._enterCold();  // async — track 완전 해제
    }
  }

  _scheduleDown() {
    const floorState = this.sdk.ptt?.floorState;
    if (floorState === FLOOR.LISTENING || floorState === FLOOR.TALKING || floorState === FLOOR.QUEUED) {
      return;
    }

    const { HOT, HOT_STANDBY } = PTT_POWER;
    const cfg = this._config;
    let delayMs = 0;
    let target = null;

    if (this._state === HOT) {
      delayMs = cfg.hotStandbyMs;
      target = HOT_STANDBY;
    } else if (this._state === HOT_STANDBY && cfg.coldMs > 0) {
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

  // ── 동기 부수효과 ──

  _enableTracks(on) {
    for (const kind of ["audio", "video"]) {
      if (on && kind === "video" && this._userVideoOff) continue;
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (sender?.track) {
        sender.track.enabled = on;
      }
    }
  }

  // ── 카메라 설정 보존 ──

  _saveVideoConstraints() {
    const track = this.sdk.media.stream?.getVideoTracks()?.[0];
    if (!track) { this._savedVideoConstraints = null; return; }
    const settings = track.getSettings();
    this._savedVideoConstraints = {
      deviceId: settings.deviceId || null,
      facingMode: settings.facingMode || null,
    };
    console.log(`[POWER] video constraints saved: deviceId=${settings.deviceId?.slice(0, 12)} facingMode=${settings.facingMode}`);
  }

  _buildVideoConstraints() {
    const mc = this.sdk.mediaConfig;
    const base = { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } };
    if (!this._savedVideoConstraints) return base;
    const { deviceId, facingMode } = this._savedVideoConstraints;
    if (deviceId) base.deviceId = { exact: deviceId };
    else if (facingMode) base.facingMode = { ideal: facingMode };
    return base;
  }

  // ── COLD 진입 (async) ──

  async _enterCold() {
    // 카메라 설정 보존 (HOT-STANDBY에서 track이 아직 살아있을 때)
    this._saveVideoConstraints();

    for (const kind of ["audio", "video"]) {
      if (this._state !== PTT_POWER.COLD) return;
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (!sender) continue;

      // real track stop + stream에서 제거
      const track = sender.track;
      if (track) {
        track.stop();
        if (this.sdk.media.stream) this.sdk.media.stream.removeTrack(track);
      }
      await sender.replaceTrack(null);
    }
    console.log("[POWER] COLD: all tracks stopped");
  }

  // ── COLD→HOT 복원 (async) ──

  async _restoreTracks() {
    const restoreT0 = performance.now();
    const prevState = "cold";  // COLD→HOT만 이 경로를 탄다

    // ── Phase 1: Audio 복구 (getUserMedia + timeout) ──
    const audioSender = this.sdk.media.audioSender;
    let audioMethod = "none";
    let audioMs = 0;

    if (audioSender) {
      const audioT0 = performance.now();
      try {
        const audioStream = await gumWithTimeout({ audio: true }, 5000);
        audioMs = Math.round(performance.now() - audioT0);
        if (this._state !== PTT_POWER.HOT) { audioStream.getTracks().forEach(t => t.stop()); return; }
        const newTrack = audioStream.getAudioTracks()[0];
        if (newTrack) {
          await audioSender.replaceTrack(newTrack);
          if (this.sdk.media.stream) {
            this.sdk.media.stream.getAudioTracks().forEach(t => this.sdk.media.stream.removeTrack(t));
            this.sdk.media.stream.addTrack(newTrack);
          }
          audioMethod = "getUserMedia";
          console.log(`[POWER] audio restored (${audioMs}ms)`);
        }
      } catch (e) {
        audioMs = Math.round(performance.now() - audioT0);
        audioMethod = "failed";
        console.error(`[POWER] audio restore failed: ${e.message} (${audioMs}ms)`);
        this.sdk.emit("error", { code: 0, msg: `PTT wake 마이크 복원 실패: ${e.message}` });
        this._emitRestoreMetrics(prevState, audioMethod, audioMs, "skipped", 0, restoreT0);
        return;
      }
    }

    // ── Phase 2: Video 복구 (getUserMedia + timeout + retry) ──
    if (this._state !== PTT_POWER.HOT) return;
    const videoSender = this.sdk.media.videoSender;
    if (!videoSender) {
      this._savedVideoConstraints = null;
      this.sdk.emit("media:local", this.sdk.media.stream);
      this._emitRestoreMetrics(prevState, audioMethod, audioMs, "none", 0, restoreT0);
      return;
    }

    const videoT0 = performance.now();
    let videoStream = null;
    let videoMethod = "getUserMedia";
    const videoConstraints = this._buildVideoConstraints();

    // 1차 시도
    try {
      videoStream = await gumWithTimeout({ audio: false, video: videoConstraints }, 5000);
    } catch (e1) {
      console.warn(`[POWER] video restore attempt 1 failed: ${e1.message}, retry in 1s`);
      // 2차 시도: 1초 대기 후 기본 constraints
      if (this._state !== PTT_POWER.HOT) return;
      await new Promise(r => setTimeout(r, 1000));
      if (this._state !== PTT_POWER.HOT) return;
      try {
        const mc = this.sdk.mediaConfig;
        videoStream = await gumWithTimeout({
          audio: false,
          video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } },
        }, 5000);
        videoMethod = "getUserMedia:retry";
      } catch (e2) {
        const videoMs = Math.round(performance.now() - videoT0);
        console.warn(`[POWER] video restore failed after retry: ${e2.message} (audio-only, ${videoMs}ms)`);
        this.sdk.emit("media:fallback", { dropped: "video", reason: e2.message });
        this._savedVideoConstraints = null;
        this.sdk.emit("media:local", this.sdk.media.stream);
        this._emitRestoreMetrics(prevState, audioMethod, audioMs, "failed", videoMs, restoreT0);
        return;
      }
    }

    const videoMs = Math.round(performance.now() - videoT0);
    if (this._state !== PTT_POWER.HOT) { videoStream.getTracks().forEach(t => t.stop()); return; }

    const newVideoTrack = videoStream.getVideoTracks()[0];
    if (newVideoTrack) {
      await videoSender.replaceTrack(newVideoTrack);
      if (this._state !== PTT_POWER.HOT) return;
      if (this.sdk.media.stream) {
        this.sdk.media.stream.getVideoTracks().forEach(t => this.sdk.media.stream.removeTrack(t));
        this.sdk.media.stream.addTrack(newVideoTrack);
      }
      console.log(`[POWER] video restored (${videoMethod}, ${videoMs}ms)`);
    }

    this._savedVideoConstraints = null;
    this.sdk.emit("media:local", this.sdk.media.stream);
    if (newVideoTrack) this._sendCameraReady();

    this._emitRestoreMetrics(prevState, audioMethod, audioMs, videoMethod, videoMs, restoreT0);
  }

  _emitRestoreMetrics(prevState, audioMethod, audioMs, videoMethod, videoMs, t0) {
    const totalMs = Math.round(performance.now() - t0);
    const metrics = { prevState, audioMethod, audioMs, videoMethod, videoMs, totalMs };
    console.log(`[POWER:METRICS] restore from=${prevState} audio=${audioMethod}(${audioMs}ms) video=${videoMethod}(${videoMs}ms) total=${totalMs}ms`);
    this.sdk.emit("ptt:restore_metrics", metrics);
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
}
