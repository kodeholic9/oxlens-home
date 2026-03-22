// author: kodeholic (powered by Claude)
// health-monitor.js — 미디어 상태 감시 + 자동 복구 (제어 계층)
//
// 원칙: telemetry = 관측(observation), health-monitor = 제어(control)
// telemetry는 "decoder_stall N연속 감지" 사실만 보고하고,
// 복구 판단(쿨다운, 횟수 제한, 에스컬레이션)은 여기서 담당한다.
//
// 이벤트 흐름:
//   telemetry.js → sdk.emit("health:decoder_stall", { ssrc, consecutiveTicks })
//   health-monitor.js → (판단) → sdk.sig.send(ROOM_SYNC) 또는 sdk.emit("decoder:unrecoverable")
//

import { OP } from "./constants.js";

const RECOVERY_COOLDOWN_MS = 60_000;  // 복구 시도 간격
const MAX_RECOVERY_ATTEMPTS = 3;      // 최대 복구 시도 횟수
const STALL_THRESHOLD_TICKS = 5;      // 연속 스톨 임계값 (5 × 3초 = 15초)

export class HealthMonitor {
  constructor(sdk) {
    this.sdk = sdk;
    this._lastRecoveryTs = 0;
    this._recoveryCount = 0;
    this._notified = false;           // unrecoverable 알림 1회 제한
    this._handler = null;
  }

  attach() {
    this._lastRecoveryTs = 0;
    this._recoveryCount = 0;
    this._notified = false;

    this._handler = (ev) => this._onDecoderStall(ev);
    this.sdk.on("health:decoder_stall", this._handler);
  }

  detach() {
    if (this._handler) {
      this.sdk.off("health:decoder_stall", this._handler);
      this._handler = null;
    }
  }

  // ── 내부: decoder stall 판단 ────────────────────────────────
  _onDecoderStall({ ssrc, consecutiveTicks }) {
    if (consecutiveTicks < STALL_THRESHOLD_TICKS) return;

    const now = Date.now();

    // 최대 복구 시도 초과 → 사용자 알림 (1회만)
    if (this._recoveryCount >= MAX_RECOVERY_ATTEMPTS) {
      if (!this._notified) {
        this._notified = true;
        console.error(`[HEALTH] decoder stall unrecoverable — ${MAX_RECOVERY_ATTEMPTS} attempts exhausted`);
        this.sdk.emit("decoder:unrecoverable", { ssrc });
      }
      return;
    }

    // 쿨다운 체크
    if ((now - this._lastRecoveryTs) < RECOVERY_COOLDOWN_MS) return;

    // 복구 시도: ROOM_SYNC → subscribe PC 재생성
    this._lastRecoveryTs = now;
    this._recoveryCount++;
    const roomId = this.sdk._roomId;
    if (!roomId) return;

    console.warn(
      `[HEALTH] decoder stall → ROOM_SYNC (attempt ${this._recoveryCount}/${MAX_RECOVERY_ATTEMPTS})` +
      ` ssrc=0x${ssrc.toString(16)} ticks=${consecutiveTicks}`
    );
    this.sdk.sig.send(OP.ROOM_SYNC, { room_id: roomId });
  }
}
