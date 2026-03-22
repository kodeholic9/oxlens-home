// author: kodeholic (powered by Claude)
// media-session.js — WebRTC 미디어 세션 관리 (Publish + Subscribe 2PC)
//
// 책임:
//   - 미디어 스트림 획득 (getUserMedia)
//   - Publish PeerConnection 생성 + SDP 협상 (client-offer)
//   - Subscribe PeerConnection 생성 + re-negotiation
//   - 트랙 목록 관리 (mid 할당, active/inactive)
//   - SSRC 추출 (getStats 폴링) + PUBLISH_TRACKS 전송
//   - 카메라 전환
//   - WebRTC teardown

import {
  buildPublishRemoteAnswer,
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

    // Phase 1: Simulcast 지원
    this._simulcastEnabled = false;
    this._pendingPublishTracks = false;
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

    // Fallback 전략: audio+video → audio-only → 에러
    // 카메라 거부/미지원 환경에서도 음성만으로 진입 가능
    if (enableVideo) {
      try {
        this._stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: mc.width }, height: { ideal: mc.height }, frameRate: { ideal: mc.frameRate } },
        });
        this.sdk.emit("media:local", this._stream);
        return;
      } catch (e) {
        console.warn(`[MEDIA] audio+video 실패 (${e.name}), audio-only fallback 시도`);
        this.sdk.emit("media:fallback", { kind: "video", reason: e.name });
      }
    }

    // audio-only (video 미요청이거나 위에서 fallback)
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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

    // Simulcast: ROOM_JOIN 응답의 simulcast.enabled
    this._simulcastEnabled = options?.simulcastEnabled || false;
    console.log(`[MEDIA] simulcast=${this._simulcastEnabled}`);

    if (this._sdpOptions?.pttVirtualSsrc) {
      console.log("[MEDIA] PTT virtual SSRC:", JSON.stringify(this._sdpOptions.pttVirtualSsrc));
    }

    console.log("[MEDIA] server_config received:", JSON.stringify(serverConfig, null, 2));
    console.log("[MEDIA] initial tracks:", tracks);

    // 1. Publish PC (client-offer)
    await this._setupPublishPc();
    // 2. Subscribe PC
    await this._setupSubscribePc();
    // 3. PUBLISH_TRACKS → 서버에 SSRC 등록 (getStats 폴링, fire-and-forget)
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
          // inactive m-line 재활용: 같은 kind의 inactive entry가 있으면 mid 재사용 (SDP 비대화 방지)
          const recyclable = this._subscribeTracks.find(
            (st) => st.active === false && st.kind === t.kind
          );
          if (recyclable) {
            Object.assign(recyclable, t, { active: true }); // mid 유지, 나머지 교체
          } else {
            this._subscribeTracks.push({ ...t, active: true, mid: String(this._nextMid++) });
          }
        }
      }
    } else if (action === "remove") {
      for (const t of tracks) {
        const existing = this._subscribeTracks.find((st) => st.track_id === t.track_id);
        if (existing) {
          existing.active = false;
          // mid는 유지! 절대 제거 안 함 (WebRTC SDP m-line 삭제 불가)
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
  //  Publish PC — 내 미디어 → 서버 (client-offer 방식)
  //
  //  협상 순서:
  //    addTransceiver(sendonly) → createOffer → DTX munging
  //    → setLocalDescription(offer)
  //    → buildPublishRemoteAnswer(server_config, offer)
  //    → setRemoteDescription(answer)
  //
  //  simulcast ON: sendEncodings [{rid:'h',...},{rid:'l',...}]
  //  simulcast OFF: sendEncodings 없이 addTransceiver(sendonly)
  // ============================================================

  async _setupPublishPc() {
    const sc = this._serverConfig;
    if (this._pubPc && this._pubPc.signalingState !== "closed") {
      console.log("[MEDIA] publish PC already exists, skipping");
      return;
    }

    console.log(`[MEDIA] creating publish PC (client-offer, simulcast=${this._simulcastEnabled})`);
    this._pubPc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: "all" });

    // ── addTransceiver (sendonly) — addTrack() 사용 금지 (direction sendrecv 문제) ──
    if (this._stream) {
      const audioTrack = this._stream.getAudioTracks()[0];
      if (audioTrack) {
        const audioTx = this._pubPc.addTransceiver(audioTrack, { direction: "sendonly" });
        this._audioSender = audioTx.sender;
      }

      const videoTrack = this._stream.getVideoTracks()[0];
      if (videoTrack) {
        const txOpts = { direction: "sendonly" };
        if (this._simulcastEnabled) {
          txOpts.sendEncodings = [
            { rid: "h", maxBitrate: 1_650_000 },
            { rid: "l", maxBitrate: 250_000, scaleResolutionDownBy: 4 },
          ];
        }
        const videoTx = this._pubPc.addTransceiver(videoTrack, txOpts);
        this._videoSender = videoTx.sender;

        // setCodecPreferences: 선호 코덱을 offer SDP 앞에 배치 → 브라우저가 해당 코덱으로 인코딩
        // Safari: H264 HW 가속, Chrome: VP8/H264 모두 SW
        try {
          const preferred = this.sdk.mediaConfig.preferredCodec || "H264";
          const allCodecs = RTCRtpReceiver.getCapabilities("video")?.codecs;
          if (allCodecs && videoTx.setCodecPreferences) {
            const sorted = this._sortCodecsByPreference(allCodecs, `video/${preferred}`);
            videoTx.setCodecPreferences(sorted);
            console.log(`[MEDIA] setCodecPreferences: preferred=${preferred}`);
          }
        } catch (e) {
          console.warn(`[MEDIA] setCodecPreferences failed: ${e.message}`);
        }
      }
    }

    // 비트레이트 제한 (simulcast OFF일 때만 — ON이면 sendEncodings에서 처리)
    if (this._videoSender && !this._simulcastEnabled) {
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

    // ── ICE logging ──
    this._pubPc.oniceconnectionstatechange = () => {
      console.log(`[DBG:ICE] pub iceConnectionState=${this._pubPc.iceConnectionState}`);
      this.sdk.emit("media:ice", { pc: "publish", state: this._pubPc.iceConnectionState });
      // connected 시점에 pending publish tracks 재시도
      if ((this._pubPc.iceConnectionState === "connected" || this._pubPc.iceConnectionState === "completed") && this._pendingPublishTracks) {
        this._pendingPublishTracks = false;
        console.log("[MEDIA] ICE connected → retrying PUBLISH_TRACKS");
        this._sendPublishTracks();
      }
      // pub PC failed → auto-reconnect 트리거
      if (this._pubPc.iceConnectionState === "failed") {
        this.sdk.emit("pc:failed", { pc: "publish" });
      }
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

    // ── Client-offer SDP 협상 ──
    const offer = await this._pubPc.createOffer();

    // DTX 활성화 (offer SDP에 적용 — client-offer이므로 offer가 local)
    const mungedSdp = offer.sdp.replace(/(a=fmtp:\d+ [^\r\n]+)/g, (line) => {
      if (!/usedtx/.test(line)) return line + ";usedtx=1";
      return line.replace(/usedtx=\d/, "usedtx=1");
    });

    await this._pubPc.setLocalDescription({ type: "offer", sdp: mungedSdp });
    console.log("[MEDIA] pub setLocalDescription (offer) OK");
    console.log("[MEDIA] pub offer SDP:");
    mungedSdp.split("\r\n").forEach((l) => l && console.log(`  ${l}`));

    // Fake answer: server_config + Chrome offer의 extmap ID 사용
    const answerSdp = buildPublishRemoteAnswer(sc, mungedSdp, this._simulcastEnabled);
    console.log("[MEDIA] pub remote answer SDP:");
    answerSdp.split("\r\n").forEach((l) => l && console.log(`  ${l}`));

    const v = validateSdp(answerSdp);
    if (!v.valid) console.error("[MEDIA] publish answer SDP validation failed:", v.errors);

    await this._pubPc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    console.log("[MEDIA] pub setRemoteDescription (answer) OK");
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
        // sub PC failed → auto-reconnect 트리거
        if (this._subPc.iceConnectionState === "failed") {
          this.sdk.emit("pc:failed", { pc: "subscribe" });
        }
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
  //  PUBLISH_TRACKS → 서버에 SSRC 등록 (getStats 폴링)
  //
  //  Chrome offerer는 SDP/getParameters 모두에서 simulcast SSRC 미노출.
  //  getStats() outbound-rtp가 유일한 추출 경로.
  //  200ms 간격 폴링, 최대 15회(3초). 실패 시 ICE connected에서 재시도.
  // ============================================================

  async _sendPublishTracks() {
    if (!this._pubPc) return;
    try {
      const tracks = await this._extractPublishTracks();
      if (tracks.length === 0) {
        console.warn("[MEDIA] no publish tracks extracted, will retry on ICE connected");
        this._pendingPublishTracks = true;
        return;
      }

      // twcc_extmap_id: Chrome offer SDP에서 추출
      const offerSdp = this._pubPc.localDescription?.sdp || "";
      const twccExtmapId = this._parseTwccExtmapId(offerSdp);

      const payload = { tracks };
      if (twccExtmapId != null) payload.twcc_extmap_id = twccExtmapId;

      console.log("[MEDIA] PUBLISH_TRACKS:", JSON.stringify(payload));
      this.sdk.sig.send(OP.PUBLISH_TRACKS, payload);
    } catch (e) {
      console.error("[MEDIA] _sendPublishTracks error:", e);
      this._pendingPublishTracks = true;
    }
  }

  /**
   * getStats() 폴링으로 outbound-rtp에서 SSRC 추출.
   *
   * simulcast ON:  audio(1) + video h(1) + video l(1) = 3개 기대
   * simulcast OFF: audio(1) + video(1) = 2개 기대
   * audio-only:    audio(1) = 1개 기대
   *
   * @returns {Promise<Array<{kind, ssrc, rid?}>>}
   */
  async _extractPublishTracks() {
    const MAX_RETRIES = 15;
    const RETRY_MS = 200;

    const hasVideo = (this._stream?.getVideoTracks()?.length || 0) > 0;
    const hasAudio = (this._stream?.getAudioTracks()?.length || 0) > 0;
    const expectedVideo = hasVideo ? (this._simulcastEnabled ? 2 : 1) : 0;
    const expectedAudio = hasAudio ? 1 : 0;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const tracks = await this._getOutboundTracks();

      const videoCount = tracks.filter((t) => t.kind === "video").length;
      const audioCount = tracks.filter((t) => t.kind === "audio").length;

      if (audioCount >= expectedAudio && videoCount >= expectedVideo) {
        console.log(`[MEDIA] publish tracks extracted (attempt ${attempt + 1}/${MAX_RETRIES}):`, JSON.stringify(tracks));
        return tracks;
      }

      if (attempt < MAX_RETRIES - 1) {
        console.log(`[MEDIA] waiting for publish tracks... (attempt ${attempt + 1}, audio=${audioCount}/${expectedAudio}, video=${videoCount}/${expectedVideo})`);
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }

    // 최대 재시도 초과 — 있는 만큼이라도 반환
    const fallback = await this._getOutboundTracks();
    console.warn(`[MEDIA] publish track extraction timeout after ${MAX_RETRIES} attempts, got ${fallback.length} tracks`);
    return fallback;
  }

  /**
   * getStats()에서 outbound-rtp 항목 추출.
   * @returns {Promise<Array<{kind, ssrc, rid?}>>}
   */
  async _getOutboundTracks() {
    const stats = await this._pubPc.getStats();
    const tracks = [];
    stats.forEach((report) => {
      if (report.type !== "outbound-rtp" || !report.ssrc) return;
      // RTX(rtxSsrc) 제외 — Chrome은 RTX도 outbound-rtp로 보고할 수 있음
      if (report.encoderImplementation === undefined && report.kind === "video" && report.bytesSent === 0) return;
      const entry = { kind: report.kind, ssrc: report.ssrc };
      if (report.rid) entry.rid = report.rid;
      // 비디오 코덱 + PT 전달 (서버 PT 정규화용)
      if (report.kind === "video") {
        // 1) codecId → mimeType + payloadType (Chrome)
        if (report.codecId) {
          const codecReport = stats.get(report.codecId);
          if (codecReport?.mimeType) {
            entry.codec = codecReport.mimeType.split("/")[1];
          }
          if (codecReport?.payloadType != null) {
            entry.pt = codecReport.payloadType;
          }
        }
        // 2) fallback: answer SDP에서 video PT 파싱 (Safari getStats quirk 대응)
        if (entry.pt == null) {
          const answerPt = this._parseAnswerVideoPt();
          if (answerPt != null) entry.pt = answerPt;
        }
        // 3) RTX PT: answer SDP에서 apt=N 매핑
        if (entry.pt != null) {
          const rtxPt = this._parseAnswerRtxPt(entry.pt);
          if (rtxPt != null) entry.rtx_pt = rtxPt;
        }
      }
      tracks.push(entry);
    });
    return tracks;
  }

  /**
   * Chrome offer SDP에서 TWCC extmap ID 추출.
   * a=extmap:5 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
   * @returns {number|null}
   */
  /**
   * Publish answer SDP에서 첫 번째 video 코덱 PT 추출.
   * answer는 우리가 buildPublishRemoteAnswer로 조립했으므로, 첫 PT가 협상된 코덱.
   */
  _parseAnswerVideoPt() {
    const sdp = this._pubPc?.remoteDescription?.sdp;
    if (!sdp) return null;
    const videoSection = sdp.split(/(?=m=video)/m).find(s => s.startsWith("m=video"));
    if (!videoSection) return null;
    const mMatch = videoSection.match(/^m=video\s+\d+\s+\S+\s+(\d+)/);
    return mMatch ? parseInt(mMatch[1], 10) : null;
  }

  /**
   * Publish answer SDP에서 media PT에 대응하는 RTX PT 추출.
   * a=fmtp:120 apt=119 → mediaPt=119이면 return 120
   */
  _parseAnswerRtxPt(mediaPt) {
    const sdp = this._pubPc?.remoteDescription?.sdp;
    if (!sdp) return null;
    const regex = new RegExp(`a=fmtp:(\\d+)\\s+apt=${mediaPt}(?:\\b|;)`);
    const m = sdp.match(regex);
    return m ? parseInt(m[1], 10) : null;
  }

  _parseTwccExtmapId(sdp) {
    const match = sdp.match(
      /a=extmap:(\d+)\s+http:\/\/www\.ietf\.org\/id\/draft-holmer-rmcat-transport-wide-cc-extensions-01/
    );
    return match ? parseInt(match[1], 10) : null;
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
   * PTT 모드: 가상 SSRC(__virtual__)일 때 현재 floor speaker로 해석
   */
  resolveSourceUser(ssrc) {
    const track = this._subscribeTracks.find((t) => t.ssrc === ssrc);
    const uid = track?.user_id || null;
    // PTT 가상 SSRC → 현재 발화자로 치환 (스냅샷에서 "U071←U900" 형태로 표시)
    if (uid === "__virtual__" || uid === null) {
      const speaker = this.sdk.ptt?.speaker;
      if (speaker) return speaker;
    }
    return uid;
  }

  // ============================================================
  //  Teardown
  // ============================================================

  // ============================================================
  //  Codec preference helper
  // ============================================================

  /**
   * 코덱 배열을 선호 MIME type 순으로 정렬.
   * 선호 코덱의 media + rtx를 앞으로, 나머지를 뒤로.
   * 배열을 절대 잘라내지 않음 (fallback 코덱 유지 — Mozilla 권장).
   */
  _sortCodecsByPreference(codecs, preferredMime) {
    const preferred = [];
    const rest = [];
    for (const c of codecs) {
      if (c.mimeType?.toLowerCase() === preferredMime.toLowerCase()) {
        preferred.push(c);
      } else {
        rest.push(c);
      }
    }
    return [...preferred, ...rest];
  }

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
    this._simulcastEnabled = false;
    this._pendingPublishTracks = false;
  }
}
