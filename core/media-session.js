// author: kodeholic (powered by Claude)
// media-session.js — WebRTC 미디어 세션 관리 (Publish + Subscribe 2PC)
//
// 책임:
//   - 미디어 스트림 획득 (getUserMedia)
//   - Publish PeerConnection 생성 + SDP 협상
//   - Subscribe PeerConnection 생성 + re-negotiation
//   - 트랙 목록 관리 (mid 할당, active/inactive)
//   - SSRC 추출 + PUBLISH_TRACKS 전송
//   - 카메라 전환
//   - WebRTC teardown

import {
  buildPublishRemoteSdp,
  buildSubscribeRemoteSdp,
  updateSubscribeRemoteSdp,
  validateSdp,
} from "./sdp-builder.js";
import { OP } from "./constants.js";

export class MediaSession {
  constructor(sdk) {
    this.sdk = sdk;

    this._pubPc = null;
    this._subPc = null;
    this._stream = null;
    this._audioSender = null;
    this._videoSender = null;
    this._serverConfig = null;
    this._subscribeTracks = [];
    this._nextMid = 0;
    this._facingMode = "user";

    // Phase E-5: PTT 모드 subscribe SDP 옵션
    this._sdpOptions = null;

    // Subscribe PC re-negotiation 직렬화 큐
    // 동시에 여러 TRACKS_UPDATE가 도착해도 순차 처리
    this._subPcQueue = Promise.resolve();
  }

  // ── Getters ──

  get pubPc() { return this._pubPc; }
  get subPc() { return this._subPc; }
  get stream() { return this._stream; }
  get audioSender() { return this._audioSender; }
  get videoSender() { return this._videoSender; }
  get subscribeTracks() { return this._subscribeTracks; }
  get facingMode() { return this._facingMode; }
  get serverConfig() { return this._serverConfig; }

  // ============================================================
  //  Media acquisition
  // ============================================================

  async acquireMedia(enableVideo) {
    if (this._stream) return;

    const mc = this.sdk.mediaConfig;
    const constraints = {
      audio: true,
      video: enableVideo
        ? { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } }
        : false,
    };
    this._stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.sdk.emit("media:local", this._stream);
  }

  async switchCamera() {
    const next = this._facingMode === "user" ? "environment" : "user";
    const mc = this.sdk.mediaConfig;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: next }, width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (this._videoSender) await this._videoSender.replaceTrack(newTrack);
      if (this._stream) {
        this._stream.getVideoTracks().forEach((t) => { t.stop(); this._stream.removeTrack(t); });
        this._stream.addTrack(newTrack);
      }
      this._facingMode = next;
      this.sdk.emit("media:local", this._stream);
      this.sdk.emit("camera:switched", { facingMode: next });
      return next;
    } catch (e) {
      this.sdk.emit("error", { code: 0, msg: `카메라 전환 실패: ${e.message}` });
      return this._facingMode;
    }
  }

  // ============================================================
  //  ROOM_JOIN 응답 처리 — 2PC 셋업
  // ============================================================

  async setup(serverConfig, tracks, options) {
    this._serverConfig = serverConfig;
    this._nextMid = 0;
    this._subscribeTracks = (tracks || []).map((t) => ({
      ...t, active: true, mid: String(this._nextMid++),
    }));

    // Phase E-5: PTT subscribe SDP용 옵션 저장
    this._sdpOptions = options || null;
    if (this._sdpOptions?.pttVirtualSsrc) {
      console.log("[MEDIA] PTT virtual SSRC:", JSON.stringify(this._sdpOptions.pttVirtualSsrc));
    }

    console.log("[MEDIA] server_config received:", JSON.stringify(serverConfig, null, 2));
    console.log("[MEDIA] initial tracks:", tracks);

    // 1. Publish PC
    await this._setupPublishPc();
    // 2. Subscribe PC
    await this._setupSubscribePc();
    // 3. PUBLISH_TRACKS → 서버에 SSRC 등록
    this._sendPublishTracks();
  }

  // ============================================================
  //  TRACKS_UPDATE → subscribe PC re-negotiation
  // ============================================================

  async onTracksUpdate(action, tracks) {
    console.log(`[MEDIA] tracks_update action=${action} (${(tracks || []).length})`, JSON.stringify(tracks));

    if (action === "add") {
      for (const t of tracks) {
        const existing = this._subscribeTracks.find((st) => st.track_id === t.track_id);
        if (existing) {
          Object.assign(existing, t, { active: true });
        } else {
          this._subscribeTracks.push({ ...t, active: true, mid: String(this._nextMid++) });
        }
      }
    } else if (action === "remove") {
      for (const t of tracks) {
        const existing = this._subscribeTracks.find((st) => st.track_id === t.track_id);
        if (existing) {
          existing.active = false;
          // mid는 유지! 절대 제거 안 함
        }
      }
    }

    if (this._serverConfig) {
      await this._queueSubscribePc();
    }
  }

  // ============================================================
  //  TRACKS_RESYNC → subscribe 트랙 전체 교체 + subscribe PC 재생성
  // ============================================================

  async onTracksResync(tracks) {
    console.log("[MEDIA] TRACKS_RESYNC: replacing subscribe tracks", JSON.stringify(tracks));

    // 1. subscribe PC 닫기
    if (this._subPc) {
      this._subPc.ontrack = null;
      this._subPc.oniceconnectionstatechange = null;
      this._subPc.onconnectionstatechange = null;
      this._subPc.onicegatheringstatechange = null;
      this._subPc.onicecandidate = null;
      this._subPc.close();
      this._subPc = null;
    }

    // 2. subscribe 트랙 목록 통째 교체 (mid 재배치)
    this._nextMid = 0;
    this._subscribeTracks = (tracks || []).map((t) => ({
      ...t, active: true, mid: String(this._nextMid++),
    }));

    // 3. subscribe PC 재생성
    if (this._serverConfig) {
      await this._queueSubscribePc();
    }
  }

  // ============================================================
  //  TRACKS_ACK — 현재 인식한 subscribe SSRC 목록 서버에 보고
  // ============================================================

  sendTracksAck() {
    const ssrcs = this._subscribeTracks
      .filter((t) => t.active !== false)
      .map((t) => t.ssrc)
      .filter((s) => s != null);
    console.log("[MEDIA] sendTracksAck ssrcs:", ssrcs);
    this.sdk.sig.send(OP.TRACKS_ACK, { ssrcs });
  }

  // ============================================================
  //  Subscribe PC re-nego 직렬화 큐
  // ============================================================

  _queueSubscribePc() {
    this._subPcQueue = this._subPcQueue
      .then(() => this._setupSubscribePc())
      .catch((e) => console.error("[MEDIA] subscribe PC queue error:", e));
    return this._subPcQueue;
  }

  // ============================================================
  //  Publish PC — 내 미디어 → 서버
  // ============================================================

  async _setupPublishPc() {
    const sc = this._serverConfig;
    if (this._pubPc && this._pubPc.signalingState !== "closed") {
      console.log("[MEDIA] publish PC already exists, skipping");
      return;
    }

    console.log("[MEDIA] creating publish PC");
    this._pubPc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: "all" });

    // addTrack
    if (this._stream) {
      const audioTrack = this._stream.getAudioTracks()[0];
      if (audioTrack) this._audioSender = this._pubPc.addTrack(audioTrack, this._stream);
      const videoTrack = this._stream.getVideoTracks()[0];
      if (videoTrack) this._videoSender = this._pubPc.addTrack(videoTrack, this._stream);
    }

    // 비트레이트 제한: 서버 지정값 우선, 없으면 클라이언트 기본값
    if (this._videoSender) {
      try {
        const params = this._videoSender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          const serverMax = this._serverConfig?.max_bitrate_bps;
          const clientMax = this.sdk.mediaConfig.maxBitrate;
          const maxBitrate = serverMax || clientMax;
          if (maxBitrate > 0) params.encodings[0].maxBitrate = maxBitrate;
          else delete params.encodings[0].maxBitrate;
          console.log(`[MEDIA] maxBitrate=${maxBitrate} (server=${serverMax || "none"}, client=${clientMax})`);
        }
        await this._videoSender.setParameters(params);
      } catch (_) { /* ignore */ }
    }

    // ICE logging
    this._pubPc.oniceconnectionstatechange = () => {
      console.log(`[DBG:ICE] pub iceConnectionState=${this._pubPc.iceConnectionState}`);
      this.sdk.emit("media:ice", { pc: "publish", state: this._pubPc.iceConnectionState });
    };
    this._pubPc.onconnectionstatechange = () => {
      console.log(`[DBG:ICE] pub connectionState=${this._pubPc.connectionState}`);
      this.sdk.emit("media:conn", { pc: "publish", state: this._pubPc.connectionState });
    };
    this._pubPc.onicegatheringstatechange = () =>
      console.log(`[DBG:ICE] pub gatheringState=${this._pubPc.iceGatheringState}`);
    this._pubPc.onicecandidate = (e) => {
      if (e.candidate) console.log(`[DBG:ICE] pub local candidate: ${e.candidate.candidate}`);
    };

    // Fake remote SDP
    const remoteSdp = buildPublishRemoteSdp(sc);
    console.log("[MEDIA] publish remote SDP:");
    remoteSdp.split("\r\n").forEach((l) => l && console.log(`  ${l}`));

    const v = validateSdp(remoteSdp);
    if (!v.valid) console.error("[MEDIA] publish SDP validation failed:", v.errors);

    await this._pubPc.setRemoteDescription({ type: "offer", sdp: remoteSdp });
    console.log("[MEDIA] pub setRemoteDescription OK");

    const answer = await this._pubPc.createAnswer();

    // DTX 활성화
    const mungedSdp = answer.sdp.replace(/(a=fmtp:\d+ [^\r\n]+)/g, (line) => {
      if (!/usedtx/.test(line)) return line + ";usedtx=1";
      return line.replace(/usedtx=\d/, "usedtx=1");
    });

    await this._pubPc.setLocalDescription({ type: answer.type, sdp: mungedSdp });
    console.log("[MEDIA] pub setLocalDescription OK");
    console.log("[MEDIA] pub answer SDP:");
    mungedSdp.split("\r\n").forEach((l) => l && console.log(`  ${l}`));
  }

  // ============================================================
  //  Subscribe PC — 다른 참가자 미디어 ← 서버
  // ============================================================

  async _setupSubscribePc() {
    const sc = this._serverConfig;
    const activeTracks = this._subscribeTracks.filter((t) => t.active !== false);

    // PTT 모드는 트랙 없어도 가상 SSRC로 subscribe PC를 미리 생성해야 함
    const isPtt = this._sdpOptions?.mode === 'ptt' && this._sdpOptions?.pttVirtualSsrc;
    if (activeTracks.length === 0 && !this._subPc && !isPtt) {
      console.log("[MEDIA] no tracks to subscribe, skipping");
      return;
    }

    const isNew = !this._subPc || this._subPc.signalingState === "closed";
    console.log("[MEDIA] subscribeTracks state:", JSON.stringify(
      this._subscribeTracks.map((t) => ({ mid: t.mid, user_id: t.user_id, kind: t.kind, ssrc: t.ssrc, active: t.active })),
    ));

    if (isNew) {
      console.log("[MEDIA] creating subscribe PC");
      this._subPc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: "all" });

      this._subPc.oniceconnectionstatechange = () => {
        console.log(`[DBG:ICE] sub iceConnectionState=${this._subPc.iceConnectionState}`);
        this.sdk.emit("media:ice", { pc: "subscribe", state: this._subPc.iceConnectionState });
      };
      this._subPc.onconnectionstatechange = () => {
        console.log(`[DBG:ICE] sub connectionState=${this._subPc.connectionState}`);
        this.sdk.emit("media:conn", { pc: "subscribe", state: this._subPc.connectionState });
      };
      this._subPc.onicegatheringstatechange = () =>
        console.log(`[DBG:ICE] sub gatheringState=${this._subPc.iceGatheringState}`);
      this._subPc.onicecandidate = (e) => {
        if (e.candidate) console.log(`[DBG:ICE] sub local candidate: ${e.candidate.candidate}`);
      };

      this._subPc.ontrack = (e) => {
        const stream = e.streams?.[0] || new MediaStream([e.track]);
        console.log(`[DBG:TRACK] ontrack kind=${e.track.kind} id=${e.track.id} readyState=${e.track.readyState} stream.id=${stream.id} mid=${e.transceiver?.mid}`);
        e.track.onmute = () => console.log(`[DBG:TRACK] muted kind=${e.track.kind} id=${e.track.id}`);
        e.track.onunmute = () => console.log(`[DBG:TRACK] unmuted kind=${e.track.kind} id=${e.track.id}`);
        e.track.onended = () => console.log(`[DBG:TRACK] ended kind=${e.track.kind} id=${e.track.id}`);
        this.sdk.emit("media:track", { kind: e.track.kind, stream, track: e.track });
      };
    }

    const remoteSdp = isNew
      ? buildSubscribeRemoteSdp(sc, this._subscribeTracks, this._sdpOptions)
      : updateSubscribeRemoteSdp(sc, this._subscribeTracks, this._sdpOptions);

    console.log(`[MEDIA] subscribe remote SDP (${isNew ? "new" : "re-nego"}):`);
    remoteSdp.split("\r\n").forEach((l) => l && console.log(`  ${l}`));

    const v = validateSdp(remoteSdp);
    if (!v.valid) console.error("[MEDIA] subscribe SDP validation failed:", v.errors);

    if (this._subPc.signalingState !== "stable" && !isNew) {
      console.warn(`[MEDIA] sub signalingState=${this._subPc.signalingState}, rolling back`);
      await this._subPc.setLocalDescription({ type: "rollback" });
    }

    await this._subPc.setRemoteDescription({ type: "offer", sdp: remoteSdp });
    console.log("[MEDIA] sub setRemoteDescription OK");

    const answer = await this._subPc.createAnswer();
    await this._subPc.setLocalDescription(answer);
    console.log("[MEDIA] sub setLocalDescription OK");
  }

  // ============================================================
  //  PUBLISH_TRACKS → 서버에 SSRC 등록
  // ============================================================

  _sendPublishTracks() {
    if (!this._pubPc) return;

    const tracks = [];
    const senders = this._pubPc.getSenders();

    for (const sender of senders) {
      if (!sender.track) continue;
      const localSdp = this._pubPc.localDescription?.sdp || "";
      const ssrc = this.extractSsrcFromSdp(localSdp, sender.track.kind);
      if (ssrc) {
        tracks.push({ kind: sender.track.kind, ssrc });
        console.log(`[MEDIA] publish track: kind=${sender.track.kind} ssrc=${ssrc}`);
      }
    }

    if (tracks.length > 0) {
      this.sdk.sig.send(OP.PUBLISH_TRACKS, { tracks });
    }
  }

  // ============================================================
  //  SSRC 유틸
  // ============================================================

  /**
   * local SDP에서 특정 kind의 SSRC 추출
   * m=audio 섹션의 a=ssrc:NNNN, m=video 섹션의 a=ssrc:NNNN
   */
  extractSsrcFromSdp(sdp, kind) {
    const sections = sdp.split(/(?=^m=)/m);
    for (const sec of sections) {
      if (sec.startsWith(`m=${kind}`)) {
        const match = sec.match(/a=ssrc:(\d+)/);
        if (match) return parseInt(match[1], 10);
      }
    }
    return null;
  }

  /**
   * publish PC local SDP에서 kind의 SSRC 추출
   */
  getPublishSsrc(kind) {
    if (!this._pubPc) return null;
    return this.extractSsrcFromSdp(this._pubPc.localDescription?.sdp || "", kind);
  }

  /**
   * SSRC → source user_id 매핑
   */
  resolveSourceUser(ssrc) {
    const track = this._subscribeTracks.find((t) => t.ssrc === ssrc);
    return track?.user_id || null;
  }

  // ============================================================
  //  Teardown
  // ============================================================

  teardown() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }

    if (this._pubPc) {
      this._pubPc.ontrack = null;
      this._pubPc.oniceconnectionstatechange = null;
      this._pubPc.onconnectionstatechange = null;
      this._pubPc.onicegatheringstatechange = null;
      this._pubPc.onicecandidate = null;
      this._pubPc.close();
      this._pubPc = null;
    }

    if (this._subPc) {
      this._subPc.ontrack = null;
      this._subPc.oniceconnectionstatechange = null;
      this._subPc.onconnectionstatechange = null;
      this._subPc.onicegatheringstatechange = null;
      this._subPc.onicecandidate = null;
      this._subPc.close();
      this._subPc = null;
    }

    this._audioSender = null;
    this._videoSender = null;
    this._serverConfig = null;
    this._sdpOptions = null;
    this._subscribeTracks = [];
    this._nextMid = 0;
    this._subPcQueue = Promise.resolve();
  }
}
