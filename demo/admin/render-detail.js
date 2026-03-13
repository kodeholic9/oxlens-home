// author: kodeholic (powered by Claude)
// admin/render-detail.js — 참가자 상세 + 구간 손실 + 타임라인 + SDP 패널

import {
  $, selectedUser, latestTelemetry, sdpTelemetry,
  latestServerMetrics, joinedAtMap, eventHistory, serverEventLog,
  fmtElapsed,
} from "./state.js";

// ============================================================
//  참가자 상세 패널
// ============================================================
export function renderDetail() {
  const panel = $("detail-body");
  if (!selectedUser) {
    panel.innerHTML =
      '<div class="text-gray-500 italic text-center py-8">참가자를 클릭하세요</div>';
    $("detail-title").textContent = "참가자 상세";
    return;
  }

  $("detail-title").textContent = `상세: ${selectedUser}`;
  const tel = latestTelemetry.get(selectedUser);
  if (!tel) {
    panel.innerHTML =
      '<div class="text-gray-500 text-center py-4">데이터 없음</div>';
    return;
  }

  let html = "";

  // --- 세션 경과 시간 ---
  const joinedAtDetail = joinedAtMap.get(selectedUser);
  if (joinedAtDetail) {
    const elapsed = fmtElapsed(Date.now() - joinedAtDetail);
    const joinedIso = new Date(joinedAtDetail).toLocaleTimeString("ko-KR", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    html += `<div class="px-2 py-1 bg-brand-cyan/5 border border-brand-cyan/20 rounded text-[11px] mb-3 flex justify-between">
      <span class="text-gray-400">입장 시각</span>
      <span class="text-brand-cyan font-mono">${joinedIso} <span class="text-gray-500">(+${elapsed})</span></span>
    </div>`;
  }

  // P1: subscribe 트랙 카운트 — 누락 감지용
  if (tel.subTracks) {
    const st = tel.subTracks;
    const warnCls = st.inactive > 0 ? "text-yellow-400" : "text-gray-400";
    html += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] mb-3 flex justify-between">
      <span class="text-gray-400">Sub Tracks</span>
      <span class="font-mono">
        <span class="text-green-400">${st.active} active</span>
        <span class="${warnCls}"> / ${st.inactive} inactive</span>
        <span class="text-gray-500"> (total ${st.total})</span>
      </span>
    </div>`;
  }

  if (tel.codecs && tel.codecs.length > 0) {
    html +=
      '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">코덱 상태</div>';
    html += '<div class="space-y-1 mb-4">';
    tel.codecs.forEach((c) => {
      const labelCls = c.pc === "pub" ? "text-brand-rust" : "text-brand-cyan";
      const label = c.pc === "pub" ? "pub" : "sub";
      const impl = c.encoderImpl || c.decoderImpl || "—";
      const hw =
        c.powerEfficient === true
          ? "HW"
          : c.powerEfficient === false
            ? "SW"
            : "—";
      const fps = c.fps ?? "—";
      html += `
        <div class="flex items-center justify-between px-2 py-1.5 bg-brand-dark rounded text-[11px]">
          <div class="flex items-center gap-2">
            <span class="${labelCls} font-bold w-12">${label}</span>
            <span class="text-white">${c.kind}</span>
            <span class="text-gray-400">${impl}</span>
          </div>
          <div class="flex items-center gap-3 text-gray-400">
            <span>${hw}</span>
            <span>${fps} fps</span>
            ${
              c.qualityLimitReason && c.qualityLimitReason !== "none"
                ? `<span class="text-yellow-400">${c.qualityLimitReason}</span>`
                : ""
            }
          </div>
        </div>`;
    });
    html += "</div>";
  }

  if (tel.publish?.outbound) {
    html +=
      '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">Publish 상세</div>';
    html += '<div class="space-y-1 mb-4">';
    tel.publish.outbound.forEach((ob) => {
      const actualBps =
        ob.bitrate != null ? `${(ob.bitrate / 1000).toFixed(0)} kbps` : "—";
      const targetBps = ob.targetBitrate
        ? `${(ob.targetBitrate / 1000).toFixed(0)}`
        : "—";

      let frameGapHtml = "";
      if (
        ob.kind === "video" &&
        ob.framesEncoded != null &&
        ob.framesSent != null
      ) {
        const gap = ob.framesEncoded - ob.framesSent;
        const gapCls =
          gap > 5
            ? "text-red-400"
            : gap > 0
              ? "text-yellow-400"
              : "text-gray-500";
        frameGapHtml = `<span class="${gapCls}">enc-sent gap:${gap}</span>`;
      }

      let hugeHtml = "";
      if (
        ob.kind === "video" &&
        ob.hugeFramesSent != null &&
        ob.hugeFramesSent > 0
      ) {
        hugeHtml = `<span class="text-yellow-400">huge:${ob.hugeFramesSent}</span>`;
      }

      let qldHtml = "";
      if (ob.kind === "video" && ob.qualityLimitationDurations) {
        const qld = ob.qualityLimitationDurations;
        const parts = [];
        if (qld.bandwidth > 0)
          parts.push(
            `<span class="text-yellow-400">bw:${qld.bandwidth.toFixed(1)}s</span>`,
          );
        if (qld.cpu > 0)
          parts.push(
            `<span class="text-red-400">cpu:${qld.cpu.toFixed(1)}s</span>`,
          );
        if (parts.length > 0) {
          qldHtml = `<span class="text-gray-500">qld:</span>${parts.join(" ")}`;
        }
      }

      let encTimeHtml = "";
      if (
        ob.kind === "video" &&
        ob.totalEncodeTime != null &&
        ob.framesEncoded > 0
      ) {
        const avgMs = ((ob.totalEncodeTime / ob.framesEncoded) * 1000).toFixed(
          1,
        );
        const cls =
          parseFloat(avgMs) > 30
            ? "text-red-400"
            : parseFloat(avgMs) > 16
              ? "text-yellow-400"
              : "text-gray-500";
        encTimeHtml = `<span class="${cls}">enc:${avgMs}ms/f</span>`;
      }

      html += `
        <div class="px-2 py-1.5 bg-brand-dark rounded text-[11px]">
          <div class="flex justify-between text-gray-300">
            <span>${ob.kind} (ssrc:${ob.ssrc})</span><span>${actualBps} (target:${targetBps})</span>
          </div>
          <div class="flex gap-3 text-gray-500 mt-1">
            <span>pkts:${ob.packetsSent}</span><span>nack:${ob.nackCount}</span>
            <span>pli:${ob.pliCount}</span><span>retx:${ob.retransmittedPacketsSent}</span>
            ${ob.framesPerSecond != null ? `<span>${ob.framesPerSecond} fps</span>` : ""}
          </div>
          ${
            frameGapHtml || hugeHtml || qldHtml || encTimeHtml
              ? `
          <div class="flex gap-3 mt-1">
            ${frameGapHtml}${hugeHtml}${encTimeHtml}${qldHtml}
          </div>`
              : ""
          }
        </div>`;
    });
    if (tel.publish.network) {
      html += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] text-gray-400">
        RTT: ${tel.publish.network.rtt ?? "—"}ms · BW: ${tel.publish.network.availableBitrate ? (tel.publish.network.availableBitrate / 1000).toFixed(0) + " kbps" : "—"}
      </div>`;
    }
    html += "</div>";
  }

  if (tel.subscribe?.inbound) {
    html +=
      '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">Subscribe 상세</div>';
    html += '<div class="space-y-1 mb-4">';
    tel.subscribe.inbound.forEach((ib) => {
      const jitterMs = ib.jitter != null ? (ib.jitter * 1000).toFixed(1) : "—";
      const jbDelay = ib.jitterBufferDelay != null ? ib.jitterBufferDelay : "—";
      const srcLabel = ib.sourceUser ? `←${ib.sourceUser}` : "";
      const subBps =
        ib.bitrate != null ? `${(ib.bitrate / 1000).toFixed(0)} kbps` : "—";
      html += `
        <div class="px-2 py-1.5 bg-brand-dark rounded text-[11px]">
          <div class="flex justify-between text-gray-300">
            <span>${ib.kind} ${srcLabel} (ssrc:${ib.ssrc})</span><span>${subBps} · ${ib.framesPerSecond ?? "—"} fps</span>
          </div>
          <div class="flex gap-3 text-gray-500 mt-1">
            <span>pkts:${ib.packetsReceived}</span><span>lost:${ib.packetsLost}</span>
            <span>jitter:${jitterMs}ms</span><span>JB:${jbDelay}ms</span>
          </div>
          <div class="flex gap-3 text-gray-500 mt-0.5">
            <span>freeze:${ib.freezeCount}</span><span>dropped:${ib.framesDropped ?? 0}</span>
            <span>conceal:${ib.concealedSamples}</span>
          </div>
        </div>`;
    });
    html += "</div>";
  }

  // --- 구간별 손실 Cross-Reference ---
  html += renderLossCrossRef(selectedUser, tel);

  // --- 이벤트 타임라인 ---
  html += renderEventTimeline(selectedUser);

  panel.innerHTML =
    html || '<div class="text-gray-500 text-center py-4">데이터 없음</div>';
}

// ============================================================
//  구간별 손실 cross-reference (델타 기반) + NACK hit rate
// ============================================================
function renderLossCrossRef(userId, tel) {
  if (!tel.publish?.outbound) return "";
  const pubByKind = {};
  tel.publish.outbound.forEach((ob) => {
    pubByKind[ob.kind] = ob;
  });

  const sfu = latestServerMetrics;

  const matches = [];
  latestTelemetry.forEach((otherTel, otherUid) => {
    if (otherUid === userId) return;
    (otherTel.subscribe?.inbound || []).forEach((ib) => {
      if (ib.sourceUser !== userId || !pubByKind[ib.kind]) return;
      const pub = pubByKind[ib.kind];

      const pubDelta = pub.packetsSentDelta ?? 0;
      const subRecvDelta = ib.packetsReceivedDelta ?? 0;
      const subLostDelta = ib.packetsLostDelta ?? 0;

      // P3: delta 미지원 클라이언트 방어
      // delta=0이고 누적값>0이면 구버전 클라이언트 — "N/A" 표시
      const pubNoDelta = pubDelta === 0 && (pub.packetsSent ?? 0) > 0;
      const subNoDelta = subRecvDelta === 0 && subLostDelta === 0 && (ib.packetsReceived ?? 0) > 0;

      const abLoss = Math.max(0, pubDelta - (subRecvDelta + subLostDelta));
      const abLossRate = pubNoDelta
        ? "N/A"
        : pubDelta > 0 ? ((abLoss / pubDelta) * 100).toFixed(1) : "0.0";

      const bcLossRate = subNoDelta
        ? "N/A"
        : subRecvDelta + subLostDelta > 0
          ? ((subLostDelta / (subRecvDelta + subLostDelta)) * 100).toFixed(1)
          : "0.0";

      // P2: NACK hit rate — nack_seqs_requested 기준 (방 전체 집계, user별 귀속 불가)
      const sfuRtx = sfu?.rtx_sent ?? 0;
      const sfuNackSeqs = sfu?.nack_seqs_requested ?? 0;
      const sfuNackRecv = sfu?.nack_received ?? 0;
      const nackHitRate =
        sfuNackSeqs > 0 ? ((sfuRtx / sfuNackSeqs) * 100).toFixed(0) : null;
      const clientNackDelta = ib.nackCountDelta ?? 0;

      matches.push({
        subscriber: otherUid,
        kind: ib.kind,
        pubDelta,
        subRecvDelta,
        subLostDelta,
        abLoss,
        abLossRate,
        bcLossRate,
        clientNackDelta,
        sfuRtx,
        sfuNackSeqs,
        sfuNackRecv,
        nackHitRate,
      });
    });
  });

  if (matches.length === 0) return "";

  let h =
    '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5 mt-2">구간별 손실 (델타/3s)</div>';
  h += '<div class="space-y-1 mb-4">';
  matches.forEach((m) => {
    const abIsNA = m.abLossRate === "N/A";
    const abCls = abIsNA ? "text-gray-600 italic"
      : parseFloat(m.abLossRate) > 1 ? "text-yellow-400" : "text-gray-400";
    const bcIsNA = m.bcLossRate === "N/A";
    const bcCls = bcIsNA ? "text-gray-600 italic"
      : parseFloat(m.bcLossRate) > 1 ? "text-red-400" : "text-gray-400";
    const hitNum = m.nackHitRate != null ? parseInt(m.nackHitRate) : 100;
    const hitCls =
      hitNum < 50
        ? "text-red-400"
        : hitNum < 80
          ? "text-yellow-400"
          : "text-green-400";
    const hitStr = m.nackHitRate != null ? `${m.nackHitRate}%` : "—";

    h += `<div class="px-2 py-1.5 bg-brand-dark rounded text-[11px]">
      <div class="flex justify-between text-gray-300 mb-0.5">
        <span>${userId} → SFU → ${m.subscriber} (${m.kind})</span>
        <span class="text-gray-500">${m.pubDelta}/3s 전송</span>
      </div>
      <div class="flex gap-4 flex-wrap">
        <span><span class="text-gray-500">A→SFU:</span> <span class="${abCls}">${abIsNA ? m.abLossRate : m.abLossRate + '%'}</span></span>
        <span><span class="text-gray-500">SFU→B:</span> <span class="${bcCls}">${bcIsNA ? m.bcLossRate : m.bcLossRate + '%'}</span></span>
        <span><span class="text-gray-500">NACK hit:</span> <span class="${hitCls}">${hitStr}</span>
          <span class="text-gray-600 text-[10px]"> cli:${m.clientNackDelta} seqs:${m.sfuNackSeqs} rtx:${m.sfuRtx}</span>
        </span>
      </div>
    </div>`;
  });
  h += "</div>";
  return h;
}

// ============================================================
//  통합 타임라인: 클라이언트 + 서버 이벤트 병합
// ============================================================
function renderEventTimeline(userId) {
  const clientEvents = (eventHistory.get(userId) || []).map((ev) => ({
    ...ev,
    _src: "cli",
  }));
  const minTs = clientEvents.length > 0 ? clientEvents[0].ts : 0;
  const sfuEvents = serverEventLog
    .filter((ev) => ev.ts >= minTs)
    .map((ev) => ({ ...ev, _src: "sfu" }));

  const all = [...clientEvents, ...sfuEvents].sort((a, b) => a.ts - b.ts);
  if (all.length === 0) return "";

  const joinedAt = joinedAtMap.get(userId);

  let h =
    '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5 mt-2">통합 타임라인</div>';
  h += '<div class="space-y-0.5 mb-4 max-h-64 overflow-y-auto">';

  const sorted = [...all].reverse();
  sorted.forEach((ev) => {
    const absTime = new Date(ev.ts).toLocaleTimeString("ko-KR", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const relTime = joinedAt ? `+${fmtElapsed(ev.ts - joinedAt)}` : absTime;
    const isSfu = ev._src === "sfu";
    const srcBadge = isSfu
      ? '<span class="text-[9px] px-1 py-0.5 rounded bg-brand-rust/20 text-brand-rust font-mono shrink-0">SFU</span>'
      : '<span class="text-[9px] px-1 py-0.5 rounded bg-brand-cyan/10 text-brand-cyan font-mono shrink-0">CLI</span>';
    const icon = isSfu ? sfuEventIcon(ev.type) : eventIcon(ev.type);
    const cls = isSfu ? sfuEventColorClass(ev.type) : eventColorClass(ev.type);
    const desc = isSfu ? sfuEventDescription(ev) : eventDescription(ev);

    h += `<div class="px-2 py-0.5 bg-brand-dark rounded text-[10px] flex items-center gap-1.5">
      <span class="text-gray-600 font-mono w-14 shrink-0 text-right">${relTime}</span>
      ${srcBadge}
      <span>${icon}</span>
      <span class="${cls} truncate">${desc}</span>
    </div>`;
  });
  h += "</div>";
  return h;
}

// ============================================================
//  SDP 상태 패널
// ============================================================
export function renderSdpPanel() {
  const panel = $("sdp-body");
  if (!selectedUser) {
    panel.innerHTML =
      '<div class="text-gray-500 italic text-center py-4">참가자를 클릭하세요</div>';
    return;
  }
  const sdp = sdpTelemetry.get(selectedUser);
  if (!sdp) {
    panel.innerHTML =
      '<div class="text-gray-500 text-center py-4">SDP 데이터 없음</div>';
    return;
  }

  let html = "";
  const renderMlines = (label, mlines) => {
    if (!mlines || mlines.length === 0) return "";
    let h = `<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">${label} m-lines</div>`;
    h += '<div class="space-y-1 mb-3">';
    mlines.forEach((m) => {
      const dirClass =
        m.direction === "inactive" ? "text-red-400" : "text-gray-300";
      h += `<div class="flex items-center gap-2 px-2 py-1 bg-brand-dark rounded text-[11px] whitespace-nowrap">
        <span class="text-gray-500">mid=${m.mid ?? "—"}</span>
        <span class="text-white">${m.kind}</span>
        <span class="${dirClass}">${m.direction}</span>
        <span class="text-gray-400">${m.codec ?? "—"}</span>
        <span class="text-gray-500">pt=${m.pt ?? "—"}</span>
        <span class="text-gray-500">ssrc=${m.ssrc ?? "—"}</span>
      </div>`;
    });
    h += "</div>";
    return h;
  };
  html += renderMlines("Publish", sdp.pub_mline_summary);
  html += renderMlines("Subscribe", sdp.sub_mline_summary);
  panel.innerHTML =
    html || '<div class="text-gray-500 text-center py-4">SDP 요약 없음</div>';
}

// ============================================================
//  이벤트 아이콘 / 색상 / 설명 헬퍼
// ============================================================

// ──── 클라이언트 이벤트 ────

function eventIcon(type) {
  switch (type) {
    case "quality_limit_change": return "⚡";
    case "encoder_impl_change":  return "🔧";
    case "decoder_impl_change":  return "🔧";
    case "pli_burst":            return "🔑";
    case "nack_burst":           return "📦";
    case "bitrate_drop":         return "📉";
    case "fps_zero":             return "⏸";
    case "video_freeze":         return "🧊";
    case "loss_burst":           return "💀";
    case "frames_dropped_burst": return "🗑";
    default:                     return "•";
  }
}

function eventColorClass(type) {
  switch (type) {
    case "quality_limit_change": return "text-yellow-400";
    case "encoder_impl_change":  return "text-yellow-400";
    case "decoder_impl_change":  return "text-yellow-400";
    case "pli_burst":            return "text-yellow-400";
    case "nack_burst":           return "text-yellow-400";
    case "bitrate_drop":         return "text-red-400";
    case "fps_zero":             return "text-red-400";
    case "video_freeze":         return "text-red-400";
    case "loss_burst":           return "text-red-400";
    case "frames_dropped_burst": return "text-red-400";
    default:                     return "text-gray-400";
  }
}

function eventDescription(ev) {
  switch (ev.type) {
    case "quality_limit_change":
      return `${ev.pc}:${ev.kind} quality ${ev.from}→${ev.to}`;
    case "encoder_impl_change":
      return `${ev.pc}:${ev.kind} encoder ${ev.from}→${ev.to}`;
    case "decoder_impl_change":
      return `${ev.pc}:${ev.kind} decoder ${ev.from}→${ev.to}`;
    case "pli_burst":
      return `${ev.pc}:${ev.kind} PLI burst ×${ev.count}`;
    case "nack_burst":
      return `${ev.pc}:${ev.kind} NACK burst ×${ev.count}`;
    case "bitrate_drop":
      return `${ev.pc}:${ev.kind} bitrate ${Math.round(ev.from / 1000)}k→${Math.round(ev.to / 1000)}k`;
    case "fps_zero":
      return `${ev.pc}:${ev.kind} FPS ${ev.prevFps}→0`;
    case "video_freeze":
      return `${ev.pc}:${ev.kind} freeze ×${ev.count}`;
    case "loss_burst":
      return `${ev.pc}:${ev.kind} loss burst ×${ev.count}`;
    case "frames_dropped_burst":
      return `${ev.pc}:${ev.kind} frames dropped ×${ev.count}`;
    default:
      return `${ev.type}`;
  }
}

// ──── 서버(SFU) 이벤트 ────

function sfuEventIcon(type) {
  switch (type) {
    case "sfu_pli":       return "🔑";
    case "sfu_nack_recv": return "📬";
    case "sfu_rtx":       return "🔁";
    case "sfu_drop":      return "🚨";
    case "sfu_enc_fail":  return "🔒";
    case "sfu_dec_fail":  return "🔓";
    case "ptt_granted":   return "🎙";
    case "ptt_released":  return "🔇";
    case "ptt_revoked":   return "⛔";
    default:              return "▪";
  }
}

function sfuEventColorClass(type) {
  switch (type) {
    case "sfu_pli":       return "text-yellow-400";
    case "sfu_nack_recv": return "text-yellow-400";
    case "sfu_rtx":       return "text-gray-300";
    case "sfu_drop":      return "text-red-400";
    case "sfu_enc_fail":  return "text-red-400";
    case "sfu_dec_fail":  return "text-red-400";
    case "ptt_granted":   return "text-brand-cyan";
    case "ptt_released":  return "text-gray-400";
    case "ptt_revoked":   return "text-red-400";
    default:              return "text-gray-400";
  }
}

export function sfuEventDescription(ev) {
  switch (ev.type) {
    case "sfu_pli":       return `SFU PLI 발송 ×${ev.count}`;
    case "sfu_nack_recv": return `SFU NACK 수신 ×${ev.count}`;
    case "sfu_rtx":       return `SFU RTX 재전송 ×${ev.count}`;
    case "sfu_drop":      return `SFU egress drop ×${ev.count}`;
    case "sfu_enc_fail":  return `SFU 암호화 실패 ×${ev.count}`;
    case "sfu_dec_fail":  return `SFU 복호화 실패 ×${ev.count}`;
    case "ptt_granted":   return `PTT 발화권 획득 ×${ev.count}`;
    case "ptt_released":  return `PTT 발화권 해제 ×${ev.count}`;
    case "ptt_revoked":   return `PTT 발화권 강제회수 ×${ev.count}`;
    default:              return ev.type;
  }
}

export function eventDescriptionExport(ev) {
  return eventDescription(ev);
}
