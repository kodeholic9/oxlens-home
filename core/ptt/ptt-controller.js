// author: kodeholic (powered by Claude)
// ptt/ptt-controller.js — PTT Extension 진입점
//
// 책임:
//   - FloorFsm + PowerFsm 조립
//   - attach/detach 라이프사이클 (방 입장/퇴장 시)
//   - Public API 위임 (floor, power)
//
// 사용:
//   const ptt = new PttController(sdk);
//   ptt.attach(joinData);   // 방 입장 시
//   ptt.detach();           // 방 퇴장 시

import { FloorFsm } from "./floor-fsm.js";
import { PowerFsm } from "./power-fsm.js";

export class PttController {
  constructor(sdk) {
    this.sdk = sdk;
    this.floor = new FloorFsm(sdk);
    this.power = new PowerFsm(sdk);
  }

  // ── 라이프사이클 ──

  /**
   * PTT 방 입장 시 활성화.
   * floor-fsm이 먼저 attach (이벤트 구독) → power-fsm이 floor 이벤트 구독.
   */
  attach(joinData) {
    this.floor.attach();
    this.power.attach();
    console.log("[PTT] controller attached");
  }

  /**
   * PTT 방 퇴장 시 정리.
   * power-fsm 먼저 detach (타이머/wake 해제) → floor-fsm detach.
   */
  detach() {
    this.power.detach();
    this.floor.detach();
    console.log("[PTT] controller detached");
  }

  // ── Floor API 위임 ──

  request()     { this.power.wake(); this.floor.request(); }
  release()     { this.floor.release(); }
  get floorState() { return this.floor.state; }
  get speaker()    { return this.floor.speaker; }

  // ── Power API 위임 ──

  wake()           { this.power.wake(); }
  set powerConfig(cfg) { this.power.config = cfg; }
  get powerConfig()    { return this.power.config; }
  get powerState()     { return this.power.state; }
  get userVideoOff()   { return this.power.userVideoOff; }

  // ── Mute 위임 ──

  /** PTT mute 토글: COLD 고정 (audio+video 모두) / COLD 해제 → HOT */
  toggleMute() {
    if (this.power.muteLocked) {
      this.power.unmute();
    } else {
      this.power.mute();
    }
  }

  /** mute 상태 조회 */
  isMuted(kind) {
    // PTT에서는 audio/video 구분 없이 전체 mute lock
    return this.power.isMuted();
  }

  toggleVideo() { this.power.toggleVideo(); }
}
