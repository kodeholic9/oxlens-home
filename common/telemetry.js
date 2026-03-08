// author: kodeholic (powered by Claude)
// telemetry.js — Media Telemetry 수집 + 서버 전송
//
// 책임:
//   - 구간 S-1: SDP 상태 1회 보고
//   - 구간 S-2: encoder/decoder 코덱 상태
//   - 구간 A: publish outbound-rtp + candidate-pair (3초 주기)
//   - 구간 C: subscribe inbound-rtp (3초 주기)
//   - delta bitrate / jitterBuffer delta 계산

import { OP } from "./constants.js";

export class Telemetry {
  constructor(sdk) {
    this.sdk = sdk;
    this._statsTimer = null;
    this._prevStats = null;
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
  //  3초 주기 stats monitor
  // ============================================================

  start() {
    this.stop();
    this._prevStats = { pub: new Map(), sub: new Map(), jb: new Map() };
    let tick = 0;

    this._statsTimer = setInterval(async () => {
      const media = this.sdk.media;
      const telemetry = { section: "stats", tick };

      // 구간 A: publish PC
      if (media.pubPc) {
        try {
          const stats = await media.pubPc.getStats();
          telemetry.publish = this._collectPublishStats(stats);
        } catch (_) { /* pc closed */ }
      }

      // 구간 C: subscribe PC
      if (media.subPc) {
        try {
          const stats = await media.subPc.getStats();
          telemetry.subscribe = this._collectSubscribeStats(stats);
        } catch (_) { /* pc closed */ }
      }

      // 구간 S-2: codec
      telemetry.codecs = await this._collectCodecStats();

      // 구간 P: PTT 진단 (트랙/인코더/PC 건강성)
      telemetry.ptt = this._collectPttDiagnostics();

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

        result.outbound.push({
          kind: r.kind, ssrc: r.ssrc,
          packetsSent: r.packetsSent, bytesSent: r.bytesSent, bitrate,
          nackCount: r.nackCount || 0, pliCount: r.pliCount || 0,
          targetBitrate: r.targetBitrate || null,
          retransmittedPacketsSent: r.retransmittedPacketsSent || 0,
          framesEncoded: r.framesEncoded || null,
          keyFramesEncoded: r.keyFramesEncoded || null,
          framesPerSecond: r.framesPerSecond || null,
          qualityLimitationReason: r.qualityLimitationReason || null,
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

        result.inbound.push({
          kind: r.kind, ssrc: r.ssrc, sourceUser,
          packetsReceived: r.packetsReceived, packetsLost: r.packetsLost,
          bytesReceived: r.bytesReceived || 0, bitrate,
          jitter: r.jitter != null ? r.jitter : null,
          nackCount: r.nackCount || 0,
          jitterBufferDelay: jbDelayMs,
          jitterBufferEmittedCount: r.jitterBufferEmittedCount || null,
          framesDecoded: r.framesDecoded || null,
          keyFramesDecoded: r.keyFramesDecoded || null,
          framesDropped: r.framesDropped || null,
          framesPerSecond: r.framesPerSecond || null,
          freezeCount: r.freezeCount || 0,
          totalFreezesDuration: r.totalFreezesDuration || 0,
          concealedSamples: r.concealedSamples || 0,
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
