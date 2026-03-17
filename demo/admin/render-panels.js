// author: kodeholic (powered by Claude)
// admin/render-panels.js — SFU 서버 지표 + Contract 체크리스트

import {
  $, latestServerMetrics, latestTelemetry, sdpTelemetry,
} from "./state.js";

// ============================================================
//  SFU 서버 지표 패널
// ============================================================
export function renderServerMetrics() {
  const panel = $("sfu-body");
  if (!latestServerMetrics) {
    panel.innerHTML =
      '<div class="text-gray-500 italic text-center py-4">데이터 대기</div>';
    return;
  }
  const m = latestServerMetrics;

  const fmtTiming = (t) => {
    if (!t || t === null) return '<span class="text-gray-600">—</span>';
    const avgClass =
      t.avg_us > 5000
        ? "text-red-400"
        : t.avg_us > 2000
          ? "text-yellow-400"
          : "text-gray-300";
    return `<span class="${avgClass}">${(t.avg_us / 1000).toFixed(2)}</span>/<span class="text-gray-400">${(t.max_us / 1000).toFixed(2)}</span>ms <span class="text-gray-600">(${t.count})</span>`;
  };

  let html = "";
  html +=
    '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">타이밍 (avg/max)</div>';
  html += '<div class="space-y-0.5 mb-3 text-[11px]">';
  html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">decrypt</span>${fmtTiming(m.decrypt)}</div>`;
  html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">egress encrypt</span>${fmtTiming(m.egress_encrypt)}</div>`;
  html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">lock wait</span>${fmtTiming(m.lock_wait)}</div>`;
  html += "</div>";

  if (m.fan_out) {
    html +=
      '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">Fan-out</div>';
    html += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] text-gray-300 mb-3">avg:${m.fan_out.avg} min:${m.fan_out.min} max:${m.fan_out.max}</div>`;
  }

  html +=
    '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">RTCP (3s window)</div>';
  html += '<div class="grid grid-cols-2 gap-1 text-[11px]">';
  [
    ["nack", m.nack_received],
    ["nack_seqs", m.nack_seqs_requested],
    ["rtx", m.rtx_sent],
    ["miss", m.rtx_cache_miss],
    ["pli", m.pli_sent],
    ["SR", m.sr_relayed],
    ["RR", m.rr_relayed],
    ["twcc_fb", m.twcc_sent],
    ["twcc_rec", m.twcc_recorded],
    ["remb", m.remb_sent],
    ["cached", m.rtp_cache_stored],
    ["no_pub", m.nack_pub_not_found],
    ["no_rtx", m.nack_no_rtx],
    ["lk_fail", m.cache_lock_fail],
    ["eg_drop", m.egress_drop],
    ["ack_mis", m.tracks_ack_mismatch],
    ["resync", m.tracks_resync_sent],
  ].forEach(([label, val]) => {
    const cls = val > 0 ? "text-white" : "text-gray-600";
    html += `<div class="px-2 py-0.5 bg-brand-dark rounded flex justify-between"><span class="text-gray-400">${label}</span><span class="${cls}">${val ?? 0}</span></div>`;
  });
  html += "</div>";

  if ((m.encrypt_fail || 0) + (m.decrypt_fail || 0) > 0) {
    html += `<div class="mt-2 px-2 py-1 bg-red-500/10 border border-red-500/30 rounded text-[11px] text-red-400">⚠ enc_fail:${m.encrypt_fail} dec_fail:${m.decrypt_fail}</div>`;
  }
  if ((m.egress_drop || 0) > 0) {
    html += `<div class="mt-1 px-2 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-[11px] text-yellow-400">⚠ egress_drop:${m.egress_drop} (큐 포화 — 구독자 처리 지연)</div>`;
  }

  // --- PTT (v0.5.1) ---
  if (m.ptt) {
    const p = m.ptt;
    html +=
      '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mt-3 mb-1">PTT (3s window)</div>';
    html += '<div class="grid grid-cols-2 gap-1 text-[11px] mb-3">';
    [
      ["gated", p.rtp_gated],
      ["rewritten", p.rtp_rewritten],
      ["audio_rw", p.audio_rewritten],
      ["video_rw", p.video_rewritten],
      ["vid_skip", p.video_skip],
      ["kf_pend_drop", p.video_pending_drop],
      ["kf_arrived", p.keyframe_arrived],
      ["granted", p.floor_granted],
      ["released", p.floor_released],
      ["revoked", p.floor_revoked],
      ["switches", p.speaker_switches],
      ["nack_remap", p.nack_remapped],
    ].forEach(([label, val]) => {
      const v = val ?? 0;
      const cls = v > 0 ? "text-white" : "text-gray-600";
      html += `<div class="px-2 py-0.5 bg-brand-dark rounded flex justify-between"><span class="text-gray-400">${label}</span><span class="${cls}">${v}</span></div>`;
    });
    html += "</div>";
    if ((p.video_pending_drop || 0) > 0 && (p.keyframe_arrived || 0) === 0) {
      html +=
        '<div class="px-2 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-[11px] text-yellow-400 mb-2">⚠ 키프레임 미도착 — PLI 전송 또는 VP8 감지 확인 필요</div>';
    }
    if ((p.floor_revoked || 0) > 0) {
      html +=
        '<div class="px-2 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-[11px] text-yellow-400 mb-2">⚠ Floor Revoke 발생 — 클라이언트 PING 미전송 또는 네트워크 문제</div>';
    }
  }

  // --- Tokio Runtime (v0.3.9) ---
  if (m.tokio_runtime) {
    const rt = m.tokio_runtime;
    const busyPct = (parseFloat(rt.busy_ratio) * 100).toFixed(1);
    const busyClass =
      busyPct > 95
        ? "text-red-400"
        : busyPct > 85
          ? "text-yellow-400"
          : "text-green-400";
    html +=
      '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mt-3 mb-1">Tokio Runtime</div>';
    html += '<div class="space-y-0.5 mb-3 text-[11px]">';
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">busy</span><span class="${busyClass} font-bold">${busyPct}%</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">alive tasks</span><span class="text-gray-300">${rt.alive_tasks}</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">global queue</span><span class="${rt.global_queue > 50 ? "text-yellow-400" : "text-gray-300"}">${rt.global_queue}</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">budget yield</span><span class="${rt.budget_yield > 100 ? "text-yellow-400" : "text-gray-300"}">${rt.budget_yield}</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">io ready</span><span class="text-gray-300">${rt.io_ready}</span></div>`;
    if (rt.workers && rt.workers.length > 0) {
      html +=
        '<div class="text-[10px] text-gray-600 font-mono mt-1 mb-0.5 px-1">workers</div>';
      rt.workers.forEach((w, i) => {
        const wBusy = (parseFloat(w.busy_ratio) * 100).toFixed(1);
        const wCls =
          wBusy > 95
            ? "text-red-400"
            : wBusy > 85
              ? "text-yellow-400"
              : "text-gray-300";
        html += `<div class="flex justify-between px-2 py-0.5 bg-brand-dark/50 rounded text-[10px]"><span class="text-gray-500">W${i}</span><span class="${wCls}">${wBusy}%</span><span class="text-gray-600">polls:${w.polls} steal:${w.steals}</span></div>`;
      });
    }
    html += "</div>";
  }

  // --- Environment meta (v0.3.9) ---
  if (m.env) {
    const e = m.env;
    html +=
      '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mt-3 mb-1">Environment</div>';
    html += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] text-gray-500 font-mono">v${e.version} · ${e.build_mode} · ${e.bwe_mode} · W${e.worker_count} · ${e.log_level}</div>`;
  }

  panel.innerHTML = html;
}

// ============================================================
//  Contract 체크리스트
// ============================================================
export function buildContractChecks() {
  const checks = [];
  const m = latestServerMetrics;

  let sdpOk = true;
  sdpTelemetry.forEach((sdp) => {
    (sdp.pub_mline_summary || []).forEach((ml) => {
      if (ml.direction === "inactive") sdpOk = false;
    });
  });
  checks.push({
    name: "sdp_negotiation",
    pass: sdpOk,
    detail: sdpOk ? "all m-lines OK" : "inactive detected",
  });

  let encoderOk = true;
  latestTelemetry.forEach((tel) => {
    (tel.codecs || []).forEach((c) => {
      if (c.qualityLimitReason && c.qualityLimitReason !== "none")
        encoderOk = false;
    });
  });
  checks.push({
    name: "encoder_healthy",
    pass: encoderOk,
    detail: encoderOk ? "no limitation" : "quality limited",
  });

  checks.push({
    name: "sr_relay",
    pass: m && (m.sr_relayed || 0) > 0,
    detail: `${m?.sr_relayed || 0} in 3s`,
  });
  checks.push({
    name: "rr_generated",
    pass: m && (m.rr_generated || 0) > 0,
    detail: `${m?.rr_generated || 0} in 3s`,
  });

  const nR = m?.nack_received || 0,
    rS = m?.rtx_sent || 0,
    rM = m?.rtx_cache_miss || 0;
  checks.push({
    name: "nack_rtx",
    pass: nR === 0 || rS / (rS + rM) > 0.8,
    detail: nR === 0 ? "no NACK" : `${rS}/${rS + rM} hit`,
  });

  let jbOk = true;
  latestTelemetry.forEach((tel) => {
    (tel.subscribe?.inbound || []).forEach((ib) => {
      if (ib.jitterBufferDelay != null && ib.jitterBufferDelay > 100)
        jbOk = false;
    });
  });
  checks.push({
    name: "jitter_buffer",
    pass: jbOk,
    detail: jbOk ? "< 100ms" : "> 100ms",
  });

  let fzOk = true;
  latestTelemetry.forEach((tel) => {
    (tel.subscribe?.inbound || []).forEach((ib) => {
      if ((ib.freezeCount || 0) > 0) fzOk = false;
    });
  });
  checks.push({
    name: "video_freeze",
    pass: fzOk,
    detail: fzOk ? "0 freezes" : "freeze detected",
  });

  const bweMode = m?.env?.bwe_mode || "twcc";
  if (bweMode === "remb") {
    const rembSent = m?.remb_sent || 0;
    checks.push({
      name: "bwe_feedback",
      pass: rembSent > 0,
      detail: rembSent > 0 ? `REMB ${rembSent}/3s` : "no REMB sent",
    });
  } else {
    const twccSent = m?.twcc_sent || 0;
    checks.push({
      name: "bwe_feedback",
      pass: twccSent > 0,
      detail: twccSent > 0 ? `TWCC ${twccSent}/3s` : "no TWCC sent",
    });
  }

  let trackOk = true,
    trackDetail = "all live";
  let pcOk = true,
    pcDetail = "connected";
  let tabWarn = false;
  latestTelemetry.forEach((tel) => {
    const p = tel.ptt;
    if (!p) return;
    if (!p.tabVisible) tabWarn = true;
    (p.tracks || []).forEach((t) => {
      if (t.readyState === "ended") {
        trackOk = false;
        trackDetail = `${t.kind} ended`;
      }
    });
    if (
      p.pubPc &&
      (p.pubPc.connectionState === "failed" ||
        p.pubPc.connectionState === "closed")
    ) {
      pcOk = false;
      pcDetail = `pub ${p.pubPc.connectionState}`;
    }
  });
  checks.push({ name: "track_health", pass: trackOk, detail: trackDetail });
  checks.push({ name: "pc_connection", pass: pcOk, detail: pcDetail });
  if (tabWarn)
    checks.push({
      name: "tab_visibility",
      pass: true,
      warn: true,
      detail: "tab hidden",
    });

  const busyRatio = m?.tokio_runtime
    ? parseFloat(m.tokio_runtime.busy_ratio)
    : 0;
  const busyPct = (busyRatio * 100).toFixed(1);
  checks.push({
    name: "runtime_busy",
    pass: busyRatio < 0.85,
    warn: busyRatio >= 0.85 && busyRatio < 0.95,
    detail: `${busyPct}%${busyRatio >= 0.95 ? " SATURATED" : busyRatio >= 0.85 ? " HIGH" : ""}`,
  });

  let encGapOk = true,
    encGapDetail = "no gap";
  latestTelemetry.forEach((tel) => {
    (tel.publish?.outbound || []).forEach((ob) => {
      if (
        ob.kind === "video" &&
        ob.framesEncoded != null &&
        ob.framesSent != null
      ) {
        const gap = ob.framesEncoded - ob.framesSent;
        if (gap > 5) {
          encGapOk = false;
          encGapDetail = `gap=${gap}`;
        }
      }
    });
  });
  checks.push({
    name: "encoder_bottleneck",
    pass: encGapOk,
    detail: encGapDetail,
  });

  return checks;
}

export function showContractCheck() {
  const checks = buildContractChecks();
  const panel = $("sfu-body");
  let html =
    '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">WebRTC Contract</div><div class="space-y-0.5">';
  checks.forEach((c) => {
    const icon = c.warn ? "⚠️" : c.pass ? "✅" : "❌";
    const cls = c.warn
      ? "text-yellow-400"
      : c.pass
        ? "text-green-400"
        : "text-red-400";
    html += `<div class="flex items-center justify-between px-2 py-1 bg-brand-dark rounded text-[11px]">
      <span class="${cls}">${icon} ${c.name}</span><span class="text-gray-500">${c.detail}</span></div>`;
  });
  html += "</div>";
  panel.innerHTML = html;
}
