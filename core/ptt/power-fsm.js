// author: kodeholic (powered by Claude)
// ptt/power-fsm.js — PTT Power State FSM (HOT → HOT-STANDBY → COLD)
//
// 책임:
//   - 3단계 전력 상태 관리
//     HOT:         정상 동작 (audio/video enabled, track 존재)
//     HOT-STANDBY: enabled=false (브라우저가 W3C 스펙에 따라 장치 자동 해제)
//     COLD:        track 완전 해제 (replaceTrack(null))
//   - 하강 타이머: HOT →(T1)→ HOT-STANDBY →(T2)→ COLD
//   - 상승 트리거: floor 이벤트 + visibilitychange + online + connection change
//   - LISTENING/TALKING/QUEUED 중에는 power-down 타이머 중단 (HOT 유지)
//   - 사용자 mute lock: COLD 고정 + 모든 wake 트리거 무시
//
// 설계 원칙 (v0.6.6):
//   HOT 진입 시 단일 게이트웨이 _ensureHot():
//     - "어디서 왔느냐(prev)"를 보지 않고, track의 실제 상태만 점검
//     - track null → getUserMedia (COLD 경유)
//     - track exists + enabled=false → enabled=true (STANDBY 경유)
//     - track exists + enabled=true → noop
//   async 직렬화:
//     - _ensureHot()은 Promise chain(_hotQueue)으로 직렬화
//     - 여러 트리거(visibility + PTT + floor)가 동시 도착해도 순차 처리
//     - 선행 호출이 이미 복구했으면 후행은 noop
//   detach 안전:
//     - detach() 시 _state = null → 진행 중 _ensureHot() bail-out
//     - getUserMedia로 얻은 track 즉시 stop (leak 방지)
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

    // async 직렬화: HOT 진입 시 _ensureHot() Promise chain
    this._hotQueue = Promise.resolve();
    this._hotBusy = false;

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
    this._hotQueue = Promise.resolve();
    this._hotBusy = false;
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

    // _state = null → 진행 중 _ensureHot()이 bail-out (별도 _detached 플래그 불필요)
    this._state = null;
    this._talking = false;
    this._userVideoOff = false;
    this._userMuteLock = false;
    this._savedVideoConstraints = null;
    this._hotBusy = false;
  }

  // ── Public API ──

  wake() {
    if (this._userMuteLock) return;
    this._set(PTT_POWER.HOT);
  }

  /**
   * HOT 전환 + 장치 복구 완료까지 대기.
   * PttController.request()에서 PTT 전에 audio 확보용.
   * @returns {Promise<void>}
   */
  ensureHot() {
    if (this._userMuteLock) return Promise.resolve();
    this._set(PTT_POWER.HOT);
    return this._hotQueue;
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
    this._onEnter(next);
    this._scheduleDown();

    if (prev !== next) {
      console.log(`[POWER] ${prev} → ${next}`);
      this.sdk.emit("ptt:power", { state: next, prev });
    }
  }

  // ── 진입 액션 ──

  _onEnter(next) {
    if (next === PTT_POWER.HOT) {
      // 단일 게이트웨이: prev를 보지 않고 track 실태만 점검
      this._ensureHot();
      return;
    }

    if (next === PTT_POWER.HOT_STANDBY) {
      // W3C 스펙: enabled=false → 브라우저가 3초 이내 장치 해제(SHOULD)
      this._disableTracks();
    } else if (next === PTT_POWER.COLD) {
      this._enterCold();
    }
  }

  _scheduleDown() {
    // 복구 진행 중 → power-down 보류 (완료 후 재스케줄됨)
    if (this._hotBusy) return;

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

  // ════════════════════════════════════════════════════════════
  //  _ensureHot — track 실태 기반 단일 복구 게이트웨이
  //
  //  Promise chain으로 직렬화:
  //    [시점A] visibility → _ensureHot() → getUserMedia 대기
  //    [시점B] PTT 버튼 → _ensureHot() → 시점A 완료 대기 → noop
  //  경쟁 조건 원천 제거.
  // ════════════════════════════════════════════════════════════

  _ensureHot() {
    this._hotBusy = true;
    this._hotQueue = this._hotQueue
      .then(() => this._doEnsureHot())
      .finally(() => {
        this._hotBusy = false;
        // 복구 완료 후 power-down 재평가
        if (this._state === PTT_POWER.HOT) this._scheduleDown();
      });
  }

  async _doEnsureHot() {
    const restoreT0 = performance.now();
    let audioMethod = "noop";
    let audioMs = 0;
    let videoMethod = "noop";
    let videoMs = 0;
    let didRestore = false;

    // ── Audio: track 실태 점검 ──
    const audioSender = this.sdk.media.audioSender;
    if (audioSender) {
      if (!audioSender.track) {
        // track 없음 → getUserMedia (COLD 경유했거나 복구 중단된 경우)
        const t0 = performance.now();
        try {
          const stream = await gumWithTimeout({ audio: true }, 5000);
          audioMs = Math.round(performance.now() - t0);
          if (this._state !== PTT_POWER.HOT) {
            stream.getTracks().forEach(t => t.stop());
            return;
          }
          const newTrack = stream.getAudioTracks()[0];
          if (newTrack) {
            await audioSender.replaceTrack(newTrack);
            this._syncStream("audio", newTrack);
            audioMethod = "getUserMedia";
            didRestore = true;
            console.log(`[POWER] audio restored (${audioMs}ms)`);
          }
        } catch (e) {
          audioMs = Math.round(performance.now() - t0);
          audioMethod = "failed";
          console.error(`[POWER] audio restore failed: ${e.message} (${audioMs}ms)`);
          this.sdk.emit("error", { code: 0, msg: `PTT wake 마이크 복원 실패: ${e.message}` });
          this._emitRestoreMetrics(audioMethod, audioMs, "skipped", 0, restoreT0);
          return;
        }
      } else if (!audioSender.track.enabled) {
        // track 있지만 disabled → enable (STANDBY 경유)
        audioSender.track.enabled = true;
        audioMethod = "enabled";
      }
    }

    // ── Video: track 실태 점검 ──
    if (this._state !== PTT_POWER.HOT) return;
    if (this._userVideoOff) {
      // 사용자 비디오 OFF → video 복구 건너뜀
      if (didRestore) {
        this.sdk.emit("media:local", this.sdk.media.stream);
        this._emitRestoreMetrics(audioMethod, audioMs, "userVideoOff", 0, restoreT0);
      }
      return;
    }

    const videoSender = this.sdk.media.videoSender;
    if (videoSender) {
      if (!videoSender.track) {
        // track 없음 → getUserMedia
        const t0 = performance.now();
        const newTrack = await this._restoreVideoTrack(t0);
        videoMs = Math.round(performance.now() - t0);
        if (this._state !== PTT_POWER.HOT) return;

        if (newTrack) {
          videoMethod = "getUserMedia";
          didRestore = true;
          this._sendCameraReady();
        } else {
          videoMethod = "failed";
        }
      } else if (!videoSender.track.enabled) {
        videoSender.track.enabled = true;
        videoMethod = "enabled";
      }
    }

    if (didRestore) {
      this._savedVideoConstraints = null;
      this.sdk.emit("media:local", this.sdk.media.stream);
      this._emitRestoreMetrics(audioMethod, audioMs, videoMethod, videoMs, restoreT0);
    }
  }

  /**
   * 비디오 track 복구 (1차 시도 + retry).
   * 성공 시 sender.replaceTrack + stream 갱신 후 track 반환.
   * 실패 시 null 반환.
   */
  async _restoreVideoTrack(t0) {
    const videoSender = this.sdk.media.videoSender;
    if (!videoSender) return null;

    const constraints = this._buildVideoConstraints();
    let videoStream = null;

    // 1차 시도
    try {
      videoStream = await gumWithTimeout({ audio: false, video: constraints }, 5000);
    } catch (e1) {
      console.warn(`[POWER] video restore attempt 1 failed: ${e1.message}, retry in 1s`);
      if (this._state !== PTT_POWER.HOT) return null;
      await new Promise(r => setTimeout(r, 1000));
      if (this._state !== PTT_POWER.HOT) return null;
      // 2차 시도: 기본 constraints
      try {
        const mc = this.sdk.mediaConfig;
        videoStream = await gumWithTimeout({
          audio: false,
          video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } },
        }, 5000);
      } catch (e2) {
        const ms = Math.round(performance.now() - t0);
        console.warn(`[POWER] video restore failed after retry: ${e2.message} (audio-only, ${ms}ms)`);
        this.sdk.emit("media:fallback", { dropped: "video", reason: e2.message });
        return null;
      }
    }

    if (this._state !== PTT_POWER.HOT) {
      videoStream.getTracks().forEach(t => t.stop());
      return null;
    }

    const newTrack = videoStream.getVideoTracks()[0];
    if (newTrack) {
      await videoSender.replaceTrack(newTrack);
      if (this._state !== PTT_POWER.HOT) return null;
      this._syncStream("video", newTrack);
      const ms = Math.round(performance.now() - t0);
      console.log(`[POWER] video restored (${ms}ms)`);
    }
    return newTrack;
  }

  // ── 하강 액션 ──

  /** HOT-STANDBY 진입: track.enabled = false */
  _disableTracks() {
    for (const kind of ["audio", "video"]) {
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (sender?.track) {
        sender.track.enabled = false;
      }
    }
  }

  /** COLD 진입: track.stop() + replaceTrack(null) */
  async _enterCold() {
    this._saveVideoConstraints();

    for (const kind of ["audio", "video"]) {
      if (this._state !== PTT_POWER.COLD) return;
      const sender = kind === "audio" ? this.sdk.media.audioSender : this.sdk.media.videoSender;
      if (!sender) continue;

      const track = sender.track;
      if (track) {
        track.stop();
        if (this.sdk.media.stream) this.sdk.media.stream.removeTrack(track);
      }
      await sender.replaceTrack(null);
    }
    console.log("[POWER] COLD: all tracks stopped");
  }

  // ── stream 동기화 헬퍼 ──

  _syncStream(kind, newTrack) {
    const stream = this.sdk.media.stream;
    if (!stream) return;
    const existing = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
    existing.forEach(t => stream.removeTrack(t));
    stream.addTrack(newTrack);
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

  // ── 메트릭 ──

  _emitRestoreMetrics(audioMethod, audioMs, videoMethod, videoMs, t0) {
    const totalMs = Math.round(performance.now() - t0);
    const metrics = { audioMethod, audioMs, videoMethod, videoMs, totalMs };
    console.log(`[POWER:METRICS] restore audio=${audioMethod}(${audioMs}ms) video=${videoMethod}(${videoMs}ms) total=${totalMs}ms`);
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
