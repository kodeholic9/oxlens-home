// author: kodeholic (powered by Claude)
// telemetry.js — Media Telemetry 수집 + 서버 전송
//
// 책임:
//   - 구간 S-1: SDP 상태 1회 보고
//   - 구간 S-2: encoder/decoder 코덱 상태
//   - 구간 A: publish outbound-rtp + candidate-pair (3초 주기)
//     - framesSent / hugeFramesSent / qualityLimitationDurations delta 포함
//   - 구간 C: subscribe inbound-rtp (3초 주기)
//   - delta bitrate / jitterBuffer delta 계산
//   - 이벤트 타임라인: 상태 전이 감지 + 링버퍼 기록

import { OP } from "./constants.js";

const EVENT_LOG_MAX = 50;   // 링버퍼 최대 크기

export class Telemetry {
  constructor(sdk) {
    this.sdk = sdk;
    this._statsTimer = null;
    this._prevStats = null;
    // 이벤트 타임라인 — 상태 전이 감지용
    this._eventLog = [];        // 링버퍼 (최근 EVENT_LOG_MAX개)
    this._watchState = {};      // 이전 감시 상태값 (SSRC별)
    this._pendingEvents = [];   // 현재 tick에서 감지된 이벤트 (전송 후 클리어)
  }

  // ============================================================
  //  구간 S-1: SDP 상태 1회 보고
  // ============================================================

  sendSdpTelemetry() {
    const media = this.sdk.media;
    const data = { section: "sdp" };

    if (media.pubPc) {
      data.pub_local_sdp = media.pubPc.localDescription?.sdp || null;
      data.pub_remote_sdp = media.pubPc.remoteDescription?.sdp || null;
      data.pub_mline_summary = this._parseMlineSummary(media.pubPc.localDescription?.sdp, "pub");
    }

    if (media.subPc) {
      data.sub_local_sdp = media.subPc.localDescription?.sdp || null;
      data.sub_remote_sdp = media.subPc.remoteDescription?.sdp || null;
      data.sub_mline_summary = this._parseMlineSummary(media.subPc.localDescription?.sdp, "sub");
    }

    this.sdk.sig.send(OP.TELEMETRY, data);
    console.log("[TEL] SDP telemetry sent");
  }

  _parseMlineSummary(sdp, _pcLabel) {
    if (!sdp) return [];
    const sections = sdp.split(/(?=^m=)/m).filter((s) => s.startsWith("m="));
    return sections.map((sec) => {
      const firstLine = sec.split("\r\n")[0];
      const parts = firstLine.split(" ");
      const kind = parts[0].replace("m=", "");
      const port = parseInt(parts[1], 10);

      const midMatch = sec.match(/a=mid:(\S+)/);
      const dirMatch = sec.match(/a=(sendonly|recvonly|sendrecv|inactive)/);
      const ssrcMatch = sec.match(/a=ssrc:(\d+)/);
      const codecMatch = sec.match(/a=rtpmap:(\d+)\s+([\w]+)\/([\d]+)/);

      return {
        mid: midMatch ? midMatch[1] : null,
        kind,
        direction: dirMatch ? dirMatch[1] : (port === 0 ? "inactive" : "unknown"),
        codec: codecMatch ? `${codecMatch[2]}/${codecMatch[3]}` : null,
        pt: codecMatch ? parseInt(codecMatch[1], 10) : null,
        ssrc: ssrcMatch ? parseInt(ssrcMatch[1], 10) : null,
        port,
      };
    });
  }

  // ============================================================
  //  이벤트 타임라인 — 상태 전이 감지
  // ============================================================

  /** 이벤트를 링버퍼에 기록 + 현재 tick pending에 추가 */
  _pushEvent(event, ts) {
    const entry = { ts: ts || Date.now(), ...event };
    this._eventLog.push(entry);
    while (this._eventLog.length > EVENT_LOG_MAX) this._eventLog.shift();
    this._pendingEvents.push(entry);
  }

  /** publish outbound-rtp 상태 전이 감지 */
  _detectPublishEvents(stats, ts) {
    stats.forEach((r) => {
      if (r.type !== "outbound-rtp") return;
      const key = `pub_${r.ssrc}`;
      const prev = this._watchState[key] || {};

      // 1) qualityLimitationReason 변화
      const curReason = r.qualityLimitationReason || "none";
      if (prev.qualityLimitReason && curReason !== prev.qualityLimitReason) {
        this._pushEvent({
          type: "quality_limit_change",
          pc: "pub", kind: r.kind, ssrc: r.ssrc,
          from: prev.qualityLimitReason, to: curReason,
        }, ts);
      }

      // 2) encoderImplementation 변화 (HW↔SW fallback)
      const curImpl = r.encoderImplementation || null;
      if (prev.encoderImpl && curImpl && curImpl !== prev.encoderImpl) {
        this._pushEvent({
          type: "encoder_impl_change",
          pc: "pub", kind: r.kind, ssrc: r.ssrc,
          from: prev.encoderImpl, to: curImpl,
        }, ts);
      }

      // 3) PLI 급증 (이번 3초에 3개 이상)
      const curPli = r.pliCount || 0;
      const deltaPli = curPli - (prev.pliCount || 0);
      if (deltaPli >= 3) {
        this._pushEvent({
          type: "pli_burst",
          pc: "pub", kind: r.kind, ssrc: r.ssrc,
          count: deltaPli,
        }, ts);
      }

      // 4) NACK 급증 (이번 3초에 10개 이상)
      const curNack = r.nackCount || 0;
      const deltaNack = curNack - (prev.nackCount || 0);
      if (deltaNack >= 10) {
        this._pushEvent({
          type: "nack_burst",
          pc: "pub", kind: r.kind, ssrc: r.ssrc,
          count: deltaNack,
        }, ts);
      }

      // 5) bitrate 급락 (이전 targetBitrate 대비 50% 이하로 떨어짐)
      const curTarget = r.targetBitrate || 0;
      if (prev.targetBitrate && curTarget > 0 && curTarget < prev.targetBitrate * 0.5) {
        this._pushEvent({
          type: "bitrate_drop",
          pc: "pub", kind: r.kind, ssrc: r.ssrc,
          from: prev.targetBitrate, to: curTarget,
        }, ts);
      }

      // 6) framesPerSecond 급락 (0이 되면)
      const curFps = r.framesPerSecond || 0;
      if (r.kind === "video" && prev.fps > 0 && curFps === 0) {
        this._pushEvent({
          type: "fps_zero",
          pc: "pub", kind: r.kind, ssrc: r.ssrc,
          prevFps: prev.fps,
        }, ts);
      }

      // 상태 저장
      this._watchState[key] = {
        qualityLimitReason: curReason,
        encoderImpl: curImpl,
        pliCount: curPli,
        nackCount: curNack,
        targetBitrate: curTarget,
        fps: curFps,
      };
    });
  }

  /** subscribe inbound-rtp 상태 전이 감지 */
  _detectSubscribeEvents(stats, ts) {
    stats.forEach((r) => {
      if (r.type !== "inbound-rtp") return;
      const key = `sub_${r.ssrc}`;
      const prev = this._watchState[key] || {};

      // 1) freeze 발생 (누적값 증가)
      const curFreeze = r.freezeCount || 0;
      if (prev.freezeCount != null && curFreeze > prev.freezeCount) {
        this._pushEvent({
          type: "video_freeze",
          pc: "sub", kind: r.kind, ssrc: r.ssrc,
          count: curFreeze - prev.freezeCount,
          totalDuration: r.totalFreezesDuration || 0,
        }, ts);
      }

      // 2) 손실 급증 (이번 3초에 20패킷 이상 새로 lost)
      const curLost = r.packetsLost || 0;
      const deltaLost = curLost - (prev.packetsLost || 0);
      if (deltaLost >= 20) {
        this._pushEvent({
          type: "loss_burst",
          pc: "sub", kind: r.kind, ssrc: r.ssrc,
          count: deltaLost,
        }, ts);
      }

      // 3) framesDropped 급증 (이번 3초에 5 이상)
      const curDropped = r.framesDropped || 0;
      const deltaDropped = curDropped - (prev.framesDropped || 0);
      if (deltaDropped >= 5) {
        this._pushEvent({
          type: "frames_dropped_burst",
          pc: "sub", kind: r.kind, ssrc: r.ssrc,
          count: deltaDropped,
        }, ts);
      }

      // 4) decoderImplementation 변화
      const curDecImpl = r.decoderImplementation || null;
      if (prev.decoderImpl && curDecImpl && curDecImpl !== prev.decoderImpl) {
        this._pushEvent({
          type: "decoder_impl_change",
          pc: "sub", kind: r.kind, ssrc: r.ssrc,
          from: prev.decoderImpl, to: curDecImpl,
        }, ts);
      }

      // 5) FPS 0으로 떨어짐 (수신 중단)
      const curFps = r.framesPerSecond || 0;
      if (r.kind === "video" && prev.fps > 0 && curFps === 0) {
        this._pushEvent({
          type: "fps_zero",
          pc: "sub", kind: r.kind, ssrc: r.ssrc,
          prevFps: prev.fps,
        }, ts);
      }

      // 6) Audio concealment 급증 (이번 3초에 concealedSamples 480 이상 증가 = 10ms×48 프레임 이상)
      const curConcealed = r.concealedSamples || 0;
      const deltaConcealed = curConcealed - (prev.concealedSamples || 0);
      if (r.kind === "audio" && deltaConcealed > 480) {
        const curTotal = r.totalSamplesReceived || 0;
        const deltaTotal = curTotal - (prev.totalSamplesReceived || 0);
        const ratio = deltaTotal > 0 ? Math.round((deltaConcealed / deltaTotal) * 1000) / 10 : 0;
        this._pushEvent({
          type: "audio_concealment",
          pc: "sub", kind: "audio", ssrc: r.ssrc,
          concealedDelta: deltaConcealed,
          totalDelta: deltaTotal,
          ratio,
        }, ts);
        console.warn(`[TEL:AUDIO] concealment spike ssrc=0x${r.ssrc.toString(16)} concealed=${deltaConcealed} total=${deltaTotal} ratio=${ratio}%`);
      }

      this._watchState[key] = {
        freezeCount: curFreeze,
        packetsLost: curLost,
        framesDropped: curDropped,
        decoderImpl: curDecImpl,
        fps: curFps,
        concealedSamples: curConcealed,
        totalSamplesReceived: r.totalSamplesReceived || 0,
      };
    });
  }

  // ============================================================
  //  3초 주기 stats monitor
  // ============================================================

  start() {
    this.stop();
    this._prevStats = {
      pub: new Map(),   // bytes: `pub_${ssrc}` / pkts: `pkt_${ssrc}` / rtx: `rtx_${ssrc}` / nack: `nack_${ssrc}`
      sub: new Map(),   // bytes: `sub_${ssrc}` / lost: `lost_${ssrc}` / nack: `nack_${ssrc}`
      jb: new Map(),
      qld: new Map(),   // qualityLimitationDurations 이전값 (SSRC별)
    };
    this._eventLog = [];
    this._watchState = {};
    this._pendingEvents = [];
    let tick = 0;

    this._statsTimer = setInterval(async () => {
      const media = this.sdk.media;
      const telemetry = { section: "stats", tick };
      const ts = Date.now();

      // 이벤트 감지 (pending 클리어)
      this._pendingEvents = [];

      // 구간 A: publish PC
      if (media.pubPc) {
        try {
          const stats = await media.pubPc.getStats();
          this._detectPublishEvents(stats, ts);
          telemetry.publish = this._collectPublishStats(stats);
        } catch (_) { /* pc closed */ }
      }

      // 구간 C: subscribe PC
      if (media.subPc) {
        try {
          const stats = await media.subPc.getStats();
          this._detectSubscribeEvents(stats, ts);
          telemetry.subscribe = this._collectSubscribeStats(stats);
        } catch (_) { /* pc closed */ }
      }

      // 구간 S-2: codec
      telemetry.codecs = await this._collectCodecStats();

      // 구간 P: PTT 진단 (트랙/인코더/PC 건강성)
      telemetry.ptt = this._collectPttDiagnostics();

      // P1: subscribe 트랙 카운트 — 누락 감지용
      const subTracks = media.subscribeTracks || [];
      telemetry.subTracks = {
        total: subTracks.length,
        active: subTracks.filter(t => t.active !== false).length,
        inactive: subTracks.filter(t => t.active === false).length,
      };

      // 이벤트 타임라인 (이번 tick에서 감지된 이벤트)
      if (this._pendingEvents.length > 0) {
        telemetry.events = this._pendingEvents;
      }

      this.sdk.sig.send(OP.TELEMETRY, telemetry);
      tick++;
    }, 3000);
  }

  stop() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
    this._prevStats = null;
  }

  /** 전체 이벤트 로그 반환 (스냅샷/디버그용) */
  getEventLog() {
    return [...this._eventLog];
  }

  // ============================================================
  //  구간 A: publish outbound-rtp + candidate-pair
  // ============================================================

  _collectPublishStats(stats) {
    const result = { outbound: [], network: null };

    stats.forEach((r) => {
      if (r.type === "outbound-rtp") {
        const prevKey = `pub_${r.ssrc}`;
        const prevBytes = this._prevStats?.pub.get(prevKey) || 0;
        const deltaBytes = Math.max(0, (r.bytesSent || 0) - prevBytes);
        const bitrate = Math.round((deltaBytes * 8) / 3);
        if (this._prevStats) this._prevStats.pub.set(prevKey, r.bytesSent || 0);

        // --- qualityLimitationDurations 3초 delta ---
        let qldDelta = null;
        const curQld = r.qualityLimitationDurations || null;
        if (curQld && this._prevStats) {
          const qldKey = `qld_${r.ssrc}`;
          const prevQld = this._prevStats.qld.get(qldKey);
          if (prevQld) {
            qldDelta = {};
            for (const reason of ["none", "bandwidth", "cpu", "other"]) {
              const cur = curQld[reason] || 0;
              const prev = prevQld[reason] || 0;
              qldDelta[reason] = Math.round((cur - prev) * 1000) / 1000;
            }
          }
          this._prevStats.qld.set(qldKey, { ...curQld });
        }

        // --- packetsSent delta ---
        const prevPkts = this._prevStats?.pub.get(`pkt_${r.ssrc}`) || 0;
        const deltaPackets = Math.max(0, (r.packetsSent || 0) - prevPkts);
        if (this._prevStats) this._prevStats.pub.set(`pkt_${r.ssrc}`, r.packetsSent || 0);

        // --- retransmittedPacketsSent delta ---
        const prevRtx = this._prevStats?.pub.get(`rtx_${r.ssrc}`) || 0;
        const deltaRtx = Math.max(0, (r.retransmittedPacketsSent || 0) - prevRtx);
        if (this._prevStats) this._prevStats.pub.set(`rtx_${r.ssrc}`, r.retransmittedPacketsSent || 0);

        // --- nackCount delta (pub: 내가 받은 NACK 수) ---
        const prevNackPub = this._prevStats?.pub.get(`nack_${r.ssrc}`) || 0;
        const deltaNackPub = Math.max(0, (r.nackCount || 0) - prevNackPub);
        if (this._prevStats) this._prevStats.pub.set(`nack_${r.ssrc}`, r.nackCount || 0);

        result.outbound.push({
          kind: r.kind, ssrc: r.ssrc,
          packetsSent: r.packetsSent,
          packetsSentDelta: deltaPackets,
          bytesSent: r.bytesSent, bitrate,
          nackCount: r.nackCount || 0,
          nackCountDelta: deltaNackPub,
          pliCount: r.pliCount || 0,
          targetBitrate: r.targetBitrate || null,
          retransmittedPacketsSent: r.retransmittedPacketsSent || 0,
          retransmittedPacketsSentDelta: deltaRtx,
          framesEncoded: r.framesEncoded || null,
          framesSent: r.framesSent || null,
          hugeFramesSent: r.hugeFramesSent || null,
          keyFramesEncoded: r.keyFramesEncoded || null,
          framesPerSecond: r.framesPerSecond || null,
          totalEncodeTime: r.totalEncodeTime || null,
          qualityLimitationReason: r.qualityLimitationReason || null,
          qualityLimitationDurations: qldDelta,
          encoderImplementation: r.encoderImplementation || null,
          powerEfficientEncoder: r.powerEfficientEncoder || null,
        });
      }
      if (r.type === "candidate-pair" && r.state === "succeeded") {
        result.network = {
          rtt: r.currentRoundTripTime ? Math.round(r.currentRoundTripTime * 1000) : null,
          availableBitrate: r.availableOutgoingBitrate || null,
        };
      }
    });

    return result;
  }

  // ============================================================
  //  구간 C: subscribe inbound-rtp
  // ============================================================

  _collectSubscribeStats(stats) {
    const result = { inbound: [], network: null };

    stats.forEach((r) => {
      if (r.type === "inbound-rtp") {
        const sourceUser = this.sdk.media.resolveSourceUser(r.ssrc);

        // delta bitrate
        const prevKey = `sub_${r.ssrc}`;
        const prevBytes = this._prevStats?.sub.get(prevKey) || 0;
        const deltaBytes = Math.max(0, (r.bytesReceived || 0) - prevBytes);
        const bitrate = Math.round((deltaBytes * 8) / 3);
        if (this._prevStats) this._prevStats.sub.set(prevKey, r.bytesReceived || 0);

        // jitterBuffer delta
        const jbKey = `jb_${r.ssrc}`;
        const prevJb = this._prevStats?.jb.get(jbKey);
        const curDelay = r.jitterBufferDelay || 0;
        const curEmitted = r.jitterBufferEmittedCount || 0;
        let jbDelayMs = null;
        if (prevJb && curEmitted > prevJb.emitted) {
          const deltaDelay = curDelay - prevJb.delay;
          const deltaEmitted = curEmitted - prevJb.emitted;
          jbDelayMs = Math.round((deltaDelay / deltaEmitted) * 1000);
        }
        if (this._prevStats) {
          this._prevStats.jb.set(jbKey, { delay: curDelay, emitted: curEmitted });
        }

        // --- packetsLost delta ---
        const prevLost = this._prevStats?.sub.get(`lost_${r.ssrc}`) || 0;
        const deltaLost = Math.max(0, (r.packetsLost || 0) - prevLost);
        if (this._prevStats) this._prevStats.sub.set(`lost_${r.ssrc}`, r.packetsLost || 0);

        // --- packetsReceived delta ---
        const prevRecv = this._prevStats?.sub.get(`recv_${r.ssrc}`) || 0;
        const deltaRecv = Math.max(0, (r.packetsReceived || 0) - prevRecv);
        if (this._prevStats) this._prevStats.sub.set(`recv_${r.ssrc}`, r.packetsReceived || 0);

        // --- nackCount delta (sub: 내가 보낸 NACK 수) ---
        const prevNackSub = this._prevStats?.sub.get(`nack_${r.ssrc}`) || 0;
        const deltaNackSub = Math.max(0, (r.nackCount || 0) - prevNackSub);
        if (this._prevStats) this._prevStats.sub.set(`nack_${r.ssrc}`, r.nackCount || 0);

        // --- delta 손실율 (0~100, 소수점 1자리) ---
        const deltaTotal = deltaRecv + deltaLost;
        const deltaLossRate = deltaTotal > 0
          ? Math.round((deltaLost / deltaTotal) * 1000) / 10
          : 0;

        // --- concealedSamples delta (audio 음성 보상 감지) ---
        const prevConcealed = this._prevStats?.sub.get(`concealed_${r.ssrc}`) || 0;
        const deltaConcealedSamples = Math.max(0, (r.concealedSamples || 0) - prevConcealed);
        if (this._prevStats) this._prevStats.sub.set(`concealed_${r.ssrc}`, r.concealedSamples || 0);

        result.inbound.push({
          kind: r.kind, ssrc: r.ssrc, sourceUser,
          packetsReceived: r.packetsReceived,
          packetsReceivedDelta: deltaRecv,
          packetsLost: r.packetsLost,
          packetsLostDelta: deltaLost,
          lossRateDelta: deltaLossRate,
          bytesReceived: r.bytesReceived || 0, bitrate,
          jitter: r.jitter != null ? r.jitter : null,
          nackCount: r.nackCount || 0,
          nackCountDelta: deltaNackSub,
          jitterBufferDelay: jbDelayMs,
          jitterBufferEmittedCount: r.jitterBufferEmittedCount || null,
          framesDecoded: r.framesDecoded || null,
          keyFramesDecoded: r.keyFramesDecoded || null,
          framesDropped: r.framesDropped || null,
          framesPerSecond: r.framesPerSecond || null,
          freezeCount: r.freezeCount || 0,
          totalFreezesDuration: r.totalFreezesDuration || 0,
          concealedSamples: r.concealedSamples || 0,
          concealedSamplesDelta: deltaConcealedSamples,
          totalSamplesReceived: r.totalSamplesReceived || 0,
          silentConcealedSamples: r.silentConcealedSamples || 0,
          decoderImplementation: r.decoderImplementation || null,
        });
      }
      if (r.type === "candidate-pair" && r.state === "succeeded") {
        result.network = {
          rtt: r.currentRoundTripTime ? Math.round(r.currentRoundTripTime * 1000) : null,
        };
      }
    });

    return result;
  }

  // ============================================================
  //  구간 S-2: encoder/decoder codec 상세
  // ============================================================

  async _collectCodecStats() {
    const media = this.sdk.media;
    const codecs = [];

    if (media.pubPc) {
      try {
        const stats = await media.pubPc.getStats();
        stats.forEach((r) => {
          if (r.type === "outbound-rtp") {
            codecs.push({
              pc: "pub", kind: r.kind,
              encoderImpl: r.encoderImplementation || null,
              powerEfficient: r.powerEfficientEncoder || null,
              qualityLimitReason: r.qualityLimitationReason || null,
              qualityLimitDurations: r.qualityLimitationDurations || null,
              fps: r.framesPerSecond || null,
              framesEncoded: r.framesEncoded || null,
              keyFramesEncoded: r.keyFramesEncoded || null,
            });
          }
        });
      } catch (_) { /* closed */ }
    }

    if (media.subPc) {
      try {
        const stats = await media.subPc.getStats();
        stats.forEach((r) => {
          if (r.type === "inbound-rtp") {
            codecs.push({
              pc: "sub", kind: r.kind, ssrc: r.ssrc,
              decoderImpl: r.decoderImplementation || null,
              fps: r.framesPerSecond || null,
              framesDecoded: r.framesDecoded || null,
              keyFramesDecoded: r.keyFramesDecoded || null,
            });
          }
        });
      } catch (_) { /* closed */ }
    }

    return codecs;
  }

  // ============================================================
  //  구간 P: PTT 진단 (track/sender/PC 건강성)
  // ============================================================

  _collectPttDiagnostics() {
    const sdk = this.sdk;
    const media = sdk.media;
    const result = {
      // ── SDK 상태 ──
      roomMode:     sdk.roomMode,
      floorState:   sdk.floorState,
      pttTrackState: { audio: sdk._pttTrackState.audio, video: sdk._pttTrackState.video },
      userVideoOff: sdk.userVideoOff,
      tabVisible:   document.visibilityState === "visible",

      // ── 트랙 건강성 (MediaStreamTrack 직접 조회) ──
      tracks: [],

      // ── Sender 상태 (RTCRtpSender) ──
      senders: [],

      // ── PC 연결 상태 ──
      pubPc: null,
      subPc: null,
    };

    // 트랙 건강성: stream이 있으면 각 track의 enabled/readyState/muted
    const stream = media.stream;
    if (stream) {
      stream.getTracks().forEach(t => {
        result.tracks.push({
          kind:       t.kind,
          enabled:    t.enabled,
          readyState: t.readyState,   // "live" | "ended"
          muted:      t.muted,        // OS/브라우저 강제 음소거
          label:      t.label || "",
        });
      });
    }

    // Sender 상태: track 유무 + encoding active + maxBitrate
    if (media.pubPc) {
      try {
        media.pubPc.getSenders().forEach(sender => {
          const track = sender.track;
          const params = sender.getParameters?.() || {};
          const enc0 = params.encodings?.[0];
          result.senders.push({
            kind:       track?.kind || "unknown",
            hasTrack:   !!track,
            trackLabel: track?.label || "(none)",
            readyState: track?.readyState || "(no track)",
            active:     enc0?.active ?? null,
            maxBitrate: enc0?.maxBitrate ?? null,
          });
        });
      } catch (_) { /* pc closed */ }
    }

    // PC 연결 상태
    if (media.pubPc) {
      result.pubPc = {
        connectionState: media.pubPc.connectionState,
        iceState:        media.pubPc.iceConnectionState,
        dtlsState:       media.pubPc.sctp?.transport?.state
                         ?? this._getDtlsState(media.pubPc),
      };
    }
    if (media.subPc) {
      result.subPc = {
        connectionState: media.subPc.connectionState,
        iceState:        media.subPc.iceConnectionState,
        dtlsState:       media.subPc.sctp?.transport?.state
                         ?? this._getDtlsState(media.subPc),
      };
    }

    return result;
  }

  /** DTLS state 추출 (SCTP 없는 경우 dtlsTransport에서 직접 조회) */
  _getDtlsState(pc) {
    try {
      const sender = pc.getSenders()[0];
      return sender?.transport?.state || null;
    } catch (_) {
      return null;
    }
  }
}
