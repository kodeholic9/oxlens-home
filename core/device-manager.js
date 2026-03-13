// author: kodeholic (powered by Claude)
// device-manager.js — 오디오/비디오 장치 관리
//
// 책임:
//   - 장치 열거 (enumerateDevices 래핑)
//   - 입력 장치 전환 (마이크, 카메라) — getUserMedia + replaceTrack
//   - 출력 장치 전환 (스피커/이어셋/블루투스) — setSinkId
//   - 핫플러그 감지 (ondevicechange) + 자동 fallback
//   - 출력 대상 audio element 관리
//
// client(OxLensClient) 참조를 통해:
//   - sdk.emit() — 앱으로 이벤트 전파
//   - sdk.media  — MediaSession (sender, stream 접근)

import { DEVICE_KIND } from "./constants.js";

export class DeviceManager {
  constructor(sdk) {
    this.sdk = sdk;

    // 현재 선택된 장치 ID (null = 시스템 기본)
    this._selectedDevices = {
      audioinput:  null,
      audiooutput: null,
      videoinput:  null,
    };

    // 출력용 audio/video element 목록 (setSinkId 대상)
    this._outputElements = new Set();

    // 캐시된 장치 목록
    this._devices = [];

    // ondevicechange 핸들러 (cleanup용 참조 보관)
    this._onDeviceChange = this._handleDeviceChange.bind(this);
  }

  // ============================================================
  //  초기화 / 해제
  // ============================================================

  /**
   * 장치 감시 시작. joinRoom 전에 호출.
   * getUserMedia 이후에 호출해야 label이 노출됨.
   */
  async start() {
    await this.refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", this._onDeviceChange);
    console.log("[DEVICE] started — monitoring device changes");
  }

  /** 장치 감시 중단 + 정리 */
  stop() {
    navigator.mediaDevices.removeEventListener("devicechange", this._onDeviceChange);
    this._outputElements.clear();
    this._devices = [];
    this._selectedDevices = { audioinput: null, audiooutput: null, videoinput: null };
    console.log("[DEVICE] stopped");
  }

  // ============================================================
  //  장치 열거
  // ============================================================

  /** 장치 목록 갱신 + 캐시 */
  async refreshDevices() {
    try {
      const raw = await navigator.mediaDevices.enumerateDevices();
      this._devices = raw.map((d) => ({
        deviceId: d.deviceId,
        kind: d.kind,
        label: d.label || this._fallbackLabel(d.kind, d.deviceId),
        groupId: d.groupId,
      }));
      console.log(`[DEVICE] enumerated ${this._devices.length} devices`);
      return this._devices;
    } catch (e) {
      console.error("[DEVICE] enumerateDevices failed:", e);
      return [];
    }
  }

  /** 종류별 장치 목록 반환 */
  getDevices(kind) {
    if (kind) return this._devices.filter((d) => d.kind === kind);
    return [...this._devices];
  }

  /** 현재 선택된 장치 ID */
  getSelectedDeviceId(kind) {
    return this._selectedDevices[kind] || null;
  }

  _fallbackLabel(kind, deviceId) {
    const prefix = kind === "audioinput" ? "마이크"
      : kind === "audiooutput" ? "스피커"
      : "카메라";
    const suffix = deviceId === "default" ? " (기본)" : ` (${deviceId.slice(0, 6)})`;
    return prefix + suffix;
  }

  // ============================================================
  //  출력 장치 전환 (setSinkId)
  // ============================================================

  /**
   * 출력 대상 element 등록.
   * app.js에서 audio/video element를 생성할 때마다 호출.
   */
  addOutputElement(el) {
    if (!el) return;
    this._outputElements.add(el);
    // 이미 선택된 출력 장치가 있으면 즉시 적용
    const outputId = this._selectedDevices.audiooutput;
    if (outputId) this._applySinkId(el, outputId);
  }

  /** 출력 대상 element 제거 */
  removeOutputElement(el) {
    this._outputElements.delete(el);
  }

  /**
   * 오디오 출력 장치 전환.
   * 등록된 모든 output element에 setSinkId 적용.
   */
  async setAudioOutput(deviceId) {
    if (!("setSinkId" in HTMLMediaElement.prototype)) {
      console.warn("[DEVICE] setSinkId not supported in this browser");
      this.sdk.emit("device:error", { kind: "audiooutput", msg: "setSinkId not supported" });
      return false;
    }

    this._selectedDevices.audiooutput = deviceId;

    const promises = [];
    for (const el of this._outputElements) {
      promises.push(this._applySinkId(el, deviceId));
    }
    await Promise.allSettled(promises);

    console.log(`[DEVICE] audio output → ${deviceId}`);
    this.sdk.emit("device:changed", { kind: "audiooutput", deviceId });
    return true;
  }

  async _applySinkId(el, deviceId) {
    try {
      await el.setSinkId(deviceId);
    } catch (e) {
      console.warn(`[DEVICE] setSinkId failed:`, e.message);
    }
  }

  // ============================================================
  //  입력 장치 전환 (마이크)
  // ============================================================

  /**
   * 마이크 전환.
   * 새 getUserMedia → sender.replaceTrack → stream 갱신.
   */
  async setAudioInput(deviceId) {
    const sender = this.sdk.media.audioSender;
    if (!sender) {
      console.warn("[DEVICE] setAudioInput: no audio sender");
      return false;
    }

    const constraints = {
      audio: { deviceId: { exact: deviceId } },
      video: false,
    };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.error("[DEVICE] setAudioInput getUserMedia failed:", e);
      this.sdk.emit("device:error", { kind: "audioinput", msg: e.message });
      return false;
    }

    const newTrack = newStream.getAudioTracks()[0];

    // 기존 트랙 교체
    const stream = this.sdk.media.stream;
    if (stream) {
      const oldTracks = stream.getAudioTracks();
      oldTracks.forEach((t) => { t.stop(); stream.removeTrack(t); });
      stream.addTrack(newTrack);
    }

    await sender.replaceTrack(newTrack);
    this._selectedDevices.audioinput = deviceId;

    console.log(`[DEVICE] audio input → ${deviceId}`);
    this.sdk.emit("device:changed", { kind: "audioinput", deviceId });
    this.sdk.emit("media:local", stream);
    return true;
  }

  // ============================================================
  //  입력 장치 전환 (카메라)
  // ============================================================

  /**
   * 카메라 전환 (deviceId 기반).
   * 기존 switchCamera(facingMode)와 달리 특정 장치 선택 가능.
   */
  async setVideoInput(deviceId) {
    const sender = this.sdk.media.videoSender;
    if (!sender) {
      console.warn("[DEVICE] setVideoInput: no video sender");
      return false;
    }

    const mc = this.sdk.mediaConfig;
    const constraints = {
      audio: false,
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: mc.width },
        height: { ideal: mc.height },
        frameRate: { ideal: mc.frameRate },
      },
    };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.error("[DEVICE] setVideoInput getUserMedia failed:", e);
      this.sdk.emit("device:error", { kind: "videoinput", msg: e.message });
      return false;
    }

    const newTrack = newStream.getVideoTracks()[0];

    const stream = this.sdk.media.stream;
    if (stream) {
      const oldTracks = stream.getVideoTracks();
      oldTracks.forEach((t) => { t.stop(); stream.removeTrack(t); });
      stream.addTrack(newTrack);
    }

    await sender.replaceTrack(newTrack);
    this._selectedDevices.videoinput = deviceId;

    console.log(`[DEVICE] video input → ${deviceId}`);
    this.sdk.emit("device:changed", { kind: "videoinput", deviceId });
    this.sdk.emit("media:local", stream);
    return true;
  }

  // ============================================================
  //  핫플러그 감지 + 자동 fallback
  // ============================================================

  async _handleDeviceChange() {
    const prevDevices = this._devices;
    await this.refreshDevices();

    // 현재 선택 장치가 빠졌는지 확인
    for (const kind of ["audioinput", "audiooutput", "videoinput"]) {
      const selectedId = this._selectedDevices[kind];
      if (!selectedId) continue;

      const stillExists = this._devices.some(
        (d) => d.kind === kind && d.deviceId === selectedId
      );

      if (!stillExists) {
        console.warn(`[DEVICE] selected ${kind} (${selectedId}) disconnected — fallback to default`);
        this._selectedDevices[kind] = null;

        // 출력이면 default로 setSinkId
        if (kind === "audiooutput") {
          const defaultDev = this._devices.find((d) => d.kind === kind);
          if (defaultDev) await this.setAudioOutput(defaultDev.deviceId);
        }

        this.sdk.emit("device:disconnected", { kind, deviceId: selectedId });
      }
    }

    // 장치 추가/제거 알림
    const added = this._devices.filter(
      (d) => !prevDevices.some((p) => p.deviceId === d.deviceId && p.kind === d.kind)
    );
    const removed = prevDevices.filter(
      (d) => !this._devices.some((n) => n.deviceId === d.deviceId && n.kind === d.kind)
    );

    if (added.length > 0 || removed.length > 0) {
      console.log(`[DEVICE] hotplug: +${added.length} -${removed.length}`);
      this.sdk.emit("device:list", {
        devices: this._devices,
        added,
        removed,
      });
    }
  }
}
