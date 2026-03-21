// author: kodeholic (powered by Claude)
// admin/snapshot.js — 텍스트 스냅샷 빌더 + 클립보드 복사

import {
  $, latestTelemetry, sdpTelemetry, latestServerMetrics,
  joinedAtMap, roomCreatedAtMap, eventHistory, serverEventLog,
  fmtElapsed, fmtLocalTs, pipelineRing, aggLogRing,
  selectedRoom, roomsSnapshot,
} from "./state.js";
import { buildContractChecks } from "./render-panels.js";
import { sfuEventDescription, eventDescriptionExport } from "./render-detail.js";

// ============================================================
//  스냅샷 텍스트 빌드
// ============================================================
export function buildSnapshot() {
  const tz = -(new Date().getTimezoneOffset() / 60);
  const tzLabel = `UTC${tz >= 0 ? "+" : ""}${tz}`;
  const L = [];
  L.push("=== OXLENS-SFU TELEMETRY SNAPSHOT ===");
  L.push(`timestamp: ${fmtLocalTs(Date.now())} (${tzLabel})`);

  // 방 필터: selectedRoom이 있으면 해당 방 참가자만
  const targetUsers = new Set();
  let roomLabel = "(all rooms)";
  if (selectedRoom) {
    const room = roomsSnapshot.find((r) => r.room_id === selectedRoom);
    if (room) {
      room.participants.forEach((p) => targetUsers.add(p.user_id));
      const modeBadge = room.mode === "ptt" ? " PTT" : "";
      roomLabel = `${room.name}${modeBadge} (${room.room_id.substring(0, 8)}…) ${room.participants.length}/${room.capacity}`;
    }
  }
  const skip = (uid) => targetUsers.size > 0 && !targetUsers.has(uid);
  L.push(`room: ${roomLabel}`);
  L.push("");

  L.push("--- SDP STATE ---");
  sdpTelemetry.forEach((sdp, uid) => {
    if (skip(uid)) return;
    (sdp.pub_mline_summary || []).forEach((m) =>
      L.push(
        `[${uid}:pub] mid=${m.mid} ${m.kind} ${m.direction} ${m.codec || "?"} pt=${m.pt} ssrc=${m.ssrc}`,
      ),
    );
    (sdp.sub_mline_summary || []).forEach((m) =>
      L.push(
        `[${uid}:sub] mid=${m.mid} ${m.kind} ${m.direction} ${m.codec || "?"} pt=${m.pt} ssrc=${m.ssrc}`,
      ),
    );
  });
  L.push("");

  L.push("--- ENCODER/DECODER ---");
  latestTelemetry.forEach((tel, uid) => {
    if (skip(uid)) return;
    (tel.codecs || []).forEach((c) => {
      const impl = c.encoderImpl || c.decoderImpl || "?",
        hw = c.powerEfficient === true ? "Y" : "N";
      L.push(
        c.pc === "pub"
          ? `[${uid}:pub:${c.kind}] impl=${impl} hw=${hw} fps=${c.fps ?? "?"} quality_limit=${c.qualityLimitReason || "none"}`
          : `[${uid}:sub:${c.kind}] impl=${impl} hw=${hw} fps=${c.fps ?? "?"}`,
      );
    });
  });
  L.push("");

  L.push("--- SESSION INFO ---");
  latestTelemetry.forEach((tel, uid) => {
    if (skip(uid)) return;
    const joinedAt = joinedAtMap.get(uid);
    const elapsed = joinedAt ? fmtElapsed(Date.now() - joinedAt) : "?";
    const joinedIso = joinedAt ? fmtLocalTs(joinedAt) : "?";
    L.push(`[${uid}] joined_at=${joinedIso} elapsed=${elapsed}`);
  });
  if (selectedRoom) {
    // 선택된 방만
    const createdAt = roomCreatedAtMap.get(selectedRoom);
    if (createdAt) {
      const roomElapsed = fmtElapsed(Date.now() - createdAt);
      L.push(`[room:${selectedRoom.substring(0, 8)}…] created_at=${fmtLocalTs(createdAt)} elapsed=${roomElapsed}`);
    }
  } else {
    roomCreatedAtMap.forEach((createdAt, roomId) => {
      const roomElapsed = fmtElapsed(Date.now() - createdAt);
      L.push(
        `[room:${roomId.substring(0, 8)}…] created_at=${fmtLocalTs(createdAt)} elapsed=${roomElapsed}`,
      );
    });
  }
  L.push("");

  L.push("--- PUBLISH (3s window) ---");
  latestTelemetry.forEach((tel, uid) => {
    if (skip(uid)) return;
    (tel.publish?.outbound || []).forEach((ob) => {
      const bps = ob.bitrate != null ? Math.round(ob.bitrate / 1000) : "?";
      const tgt = ob.targetBitrate ? Math.round(ob.targetBitrate) : "?";
      const fpsStr =
        ob.framesPerSecond != null ? ` fps=${ob.framesPerSecond}` : "";
      const deltaStr =
        ob.packetsSentDelta != null ? ` pkts_delta=${ob.packetsSentDelta}` : "";
      const nackDeltaStr =
        ob.nackCountDelta != null ? ` nack_delta=${ob.nackCountDelta}` : "";
      const rtxDeltaStr =
        ob.retransmittedPacketsSentDelta != null
          ? ` retx_delta=${ob.retransmittedPacketsSentDelta}`
          : "";
      L.push(
        `[${uid}:${ob.kind}] pkts=${ob.packetsSent}${deltaStr} nack=${ob.nackCount}${nackDeltaStr} pli=${ob.pliCount} bitrate=${bps}kbps target=${tgt} retx=${ob.retransmittedPacketsSent}${rtxDeltaStr}${fpsStr}`,
      );
      if (ob.kind === "video") {
        const encSent = ob.framesSent ?? "?";
        const encEnc = ob.framesEncoded ?? "?";
        const huge = ob.hugeFramesSent ?? 0;
        const encTime =
          ob.totalEncodeTime != null && ob.framesEncoded > 0
            ? ((ob.totalEncodeTime / ob.framesEncoded) * 1000).toFixed(1) +
              "ms/f"
            : "?";
        const qld = ob.qualityLimitationDurations;
        const qldStr = qld
          ? `bw=${qld.bandwidth?.toFixed(1) || 0}s cpu=${qld.cpu?.toFixed(1) || 0}s`
          : "N/A";
        L.push(
          `[${uid}:video:enc] encoded=${encEnc} sent=${encSent} gap=${encEnc !== "?" && encSent !== "?" ? encEnc - encSent : "?"} huge=${huge} enc_time=${encTime} qld_delta=[${qldStr}]`,
        );
      }
    });
  });
  L.push("");

  L.push("--- SUBSCRIBE (3s window) ---");
  latestTelemetry.forEach((tel, uid) => {
    if (skip(uid)) return;
    (tel.subscribe?.inbound || []).forEach((ib) => {
      const src = ib.sourceUser ? `←${ib.sourceUser}` : "";
      const bps = ib.bitrate != null ? Math.round(ib.bitrate / 1000) : "?";
      const jMs = ib.jitter != null ? (ib.jitter * 1000).toFixed(1) : "?";
      const jbMs = ib.jitterBufferDelay != null ? ib.jitterBufferDelay : "?";
      const lossRateStr =
        ib.lossRateDelta != null ? ` loss_rate=${ib.lossRateDelta}%▲` : "";
      const recvDeltaStr =
        ib.packetsReceivedDelta != null
          ? ` recv_delta=${ib.packetsReceivedDelta}`
          : "";
      const lostDeltaStr =
        ib.packetsLostDelta != null ? ` lost_delta=${ib.packetsLostDelta}` : "";
      const nackDeltaStr =
        ib.nackCountDelta != null ? ` nack_delta=${ib.nackCountDelta}` : "";
      L.push(
        `[${uid}${src}:${ib.kind}] pkts=${ib.packetsReceived}${recvDeltaStr} lost=${ib.packetsLost}${lostDeltaStr}${lossRateStr} bitrate=${bps}kbps jitter=${jMs}ms jb_delay=${jbMs}ms nack_sent=${ib.nackCount}${nackDeltaStr} freeze=${ib.freezeCount} dropped=${ib.framesDropped ?? 0}${ib.framesPerSecond != null ? ` fps=${ib.framesPerSecond}` : ""}`,
      );
    });
  });
  L.push("");

  L.push("--- NETWORK ---");
  latestTelemetry.forEach((tel, uid) => {
    if (skip(uid)) return;
    if (tel.publish?.network)
      L.push(
        `[${uid}:pub] rtt=${tel.publish.network.rtt ?? "?"}ms available_bitrate=${tel.publish.network.availableBitrate ?? "?"}`,
      );
    if (tel.subscribe?.network)
      L.push(`[${uid}:sub] rtt=${tel.subscribe.network.rtt ?? "?"}ms`);
  });
  L.push("");

  // --- LOSS CROSS-REFERENCE (델타 기반) ---
  L.push("--- LOSS CROSS-REFERENCE ---");
  const sfu = latestServerMetrics;
  latestTelemetry.forEach((tel, uid) => {
    if (skip(uid)) return;
    const pubByKind = {};
    (tel.publish?.outbound || []).forEach((ob) => {
      pubByKind[ob.kind] = ob;
    });
    latestTelemetry.forEach((otherTel, otherUid) => {
      if (otherUid === uid || skip(otherUid)) return;
      (otherTel.subscribe?.inbound || []).forEach((ib) => {
        if (ib.sourceUser !== uid || !pubByKind[ib.kind]) return;
        const pub = pubByKind[ib.kind];
        const pubDelta = pub.packetsSentDelta ?? 0;
        const subRecvDelta = ib.packetsReceivedDelta ?? 0;
        const subLostDelta = ib.packetsLostDelta ?? 0;
        // P3: delta 미지원 방어
        const pubNoDelta = pubDelta === 0 && (pub.packetsSent ?? 0) > 0;
        const subNoDelta = subRecvDelta === 0 && subLostDelta === 0 && (ib.packetsReceived ?? 0) > 0;
        const abLoss = Math.max(0, pubDelta - (subRecvDelta + subLostDelta));
        const abRate = pubNoDelta ? "N/A"
          : pubDelta > 0 ? ((abLoss / pubDelta) * 100).toFixed(1) : "0.0";
        const bcRate = subNoDelta ? "N/A"
          : subRecvDelta + subLostDelta > 0
            ? ((subLostDelta / (subRecvDelta + subLostDelta)) * 100).toFixed(1)
            : "0.0";
        const sfuRtx = sfu?.rtx_sent ?? 0;
        const sfuNackSeqs = sfu?.nack_seqs_requested ?? 0;
        const hitRate =
          sfuNackSeqs > 0 ? ((sfuRtx / sfuNackSeqs) * 100).toFixed(0) + "%" : "N/A";
        L.push(
          `[${uid}→${otherUid}:${ib.kind}] pub_delta=${pubDelta} sub_recv_delta=${subRecvDelta} sub_lost_delta=${subLostDelta} A→SFU=${abRate}% SFU→B=${bcRate}% nack_hit=${hitRate}(seqs=${sfuNackSeqs} rtx=${sfuRtx})`,
        );
      });
    });
  });
  L.push("");

  // --- UNIFIED TIMELINE ---
  L.push("--- UNIFIED TIMELINE ---");
  {
    const allEvents = [];
    eventHistory.forEach((events, uid) => {
      if (skip(uid)) return;
      events.forEach((ev) => allEvents.push({ ...ev, _uid: uid, _src: "CLI" }));
    });
    serverEventLog.forEach((ev) =>
      allEvents.push({ ...ev, _uid: "—", _src: "SFU" }),
    );
    allEvents.sort((a, b) => a.ts - b.ts);

    allEvents.forEach((ev) => {
      const localTime = fmtLocalTs(ev.ts);
      const joinedAt = joinedAtMap.get(ev._uid);
      const relTime = joinedAt ? `+${fmtElapsed(ev.ts - joinedAt)}` : "—";
      const desc =
        ev._src === "SFU" ? sfuEventDescription(ev) : eventDescriptionExport(ev);
      L.push(
        `[${ev._src}] ${localTime} (${relTime}) uid=${ev._uid} ${ev.type} ${desc}`,
      );
    });
  }
  L.push("");

  L.push("--- PTT DIAGNOSTICS ---");
  latestTelemetry.forEach((tel, uid) => {
    if (skip(uid)) return;
    const p = tel.ptt;
    if (!p) return;
    const pts = p.pttTrackState || {};
    L.push(
      `[${uid}:state] mode=${p.roomMode || "?"} floor=${p.floorState} ptt_audio=${pts.audio || "?"} ptt_video=${pts.video || "?"} video_off=${p.userVideoOff} tab=${p.tabVisible ? "visible" : "hidden"}`,
    );
    (p.tracks || []).forEach((t) => {
      L.push(
        `[${uid}:track:${t.kind}] enabled=${t.enabled} readyState=${t.readyState} muted=${t.muted} label=${t.label || "?"}`,
      );
    });
    (p.senders || []).forEach((s) => {
      L.push(
        `[${uid}:sender:${s.kind}] hasTrack=${s.hasTrack} active=${s.active} readyState=${s.readyState} maxBitrate=${s.maxBitrate ?? "none"}`,
      );
    });
    if (p.pubPc)
      L.push(
        `[${uid}:pubPc] conn=${p.pubPc.connectionState} ice=${p.pubPc.iceState} dtls=${p.pubPc.dtlsState ?? "?"}`,
      );
    if (p.subPc)
      L.push(
        `[${uid}:subPc] conn=${p.subPc.connectionState} ice=${p.subPc.iceState} dtls=${p.subPc.dtlsState ?? "?"}`,
      );
  });
  L.push("");

  L.push("--- SFU SERVER (3s window) ---");
  if (latestServerMetrics) {
    const m = latestServerMetrics;
    const f = (t) =>
      t
        ? `avg=${(t.avg_us / 1000).toFixed(2)}ms max=${(t.max_us / 1000).toFixed(2)}ms count=${t.count}`
        : "N/A";
    L.push(`[server] decrypt: ${f(m.decrypt)}`);
    L.push(`[server] egress_encrypt: ${f(m.egress_encrypt)}`);
    L.push(`[server] lock_wait: ${f(m.lock_wait)}`);
    L.push(
      `[server] nack_recv=${m.nack_received} nack_seqs=${m.nack_seqs_requested} rtx_sent=${m.rtx_sent} rtx_miss=${m.rtx_cache_miss} pli_sent=${m.pli_sent} sr_relay=${m.sr_relayed} rr_relay=${m.rr_relayed} twcc_fb=${m.twcc_sent} twcc_rec=${m.twcc_recorded} remb=${m.remb_sent}`,
    );
    L.push(
      `[server:rtx_diag] cache_stored=${m.rtp_cache_stored ?? 0} pub_not_found=${m.nack_pub_not_found ?? 0} no_rtx=${m.nack_no_rtx ?? 0} lock_fail=${m.cache_lock_fail ?? 0} egress_drop=${m.egress_drop ?? 0}`,
    );
    if (m.ptt) {
      const p = m.ptt;
      L.push(
        `[server:ptt] gated=${p.rtp_gated ?? 0} rewritten=${p.rtp_rewritten ?? 0} audio_rw=${p.audio_rewritten ?? 0} video_rw=${p.video_rewritten ?? 0} vid_skip=${p.video_skip ?? 0} kf_pending_drop=${p.video_pending_drop ?? 0} kf_arrived=${p.keyframe_arrived ?? 0} granted=${p.floor_granted ?? 0} released=${p.floor_released ?? 0} revoked=${p.floor_revoked ?? 0} switches=${p.speaker_switches ?? 0} nack_remap=${p.nack_remapped ?? 0}`,
      );
    }
    if (m.env) {
      const e = m.env;
      L.push(
        `[server] env: v${e.version} build=${e.build_mode} bwe=${e.bwe_mode} workers=${e.worker_count} log=${e.log_level}`,
      );
    }
    if (m.tokio_runtime) {
      const rt = m.tokio_runtime;
      L.push(
        `[tokio] busy=${(parseFloat(rt.busy_ratio) * 100).toFixed(1)}% alive_tasks=${rt.alive_tasks} global_queue=${rt.global_queue} budget_yield=${rt.budget_yield} io_ready=${rt.io_ready} blocking=${rt.blocking_threads}`,
      );
      if (rt.workers) {
        rt.workers.forEach((w, i) =>
          L.push(
            `[tokio:W${i}] busy=${(parseFloat(w.busy_ratio) * 100).toFixed(1)}% polls=${w.polls} steals=${w.steals} noops=${w.noops}`,
          ),
        );
      }
    }
  }
  L.push("");

  // --- PIPELINE STATS (per-participant, delta + total) ---
  L.push("--- PIPELINE STATS ---");
  if (pipelineRing.size > 0) {
    pipelineRing.forEach((state, key) => {
      const ring = state.ring;
      if (ring.length === 0) return;
      const latest = ring[ring.length - 1];
      // 방 필터: selectedRoom이 있으면 해당 방만
      if (selectedRoom && latest.roomId !== selectedRoom) return;
      const since = latest.since ? fmtLocalTs(latest.since) : "?";
      const elapsed = latest.since ? fmtElapsed(Date.now() - latest.since) : "?";
      const activeSince = latest.activeSince ? fmtLocalTs(latest.activeSince) : "?";
      L.push(`[${latest.userId}@${latest.roomId.substring(0, 8)}] since=${since} (${elapsed}) room_active=${activeSince}`);
      L.push(`  [pub] in=${latest.pub_rtp_in}(+${latest.pub_rtp_in_d}) gated=${latest.pub_rtp_gated}(+${latest.pub_rtp_gated_d}) rewritten=${latest.pub_rtp_rewritten}(+${latest.pub_rtp_rewritten_d}) vid_pending=${latest.pub_video_pending}(+${latest.pub_video_pending_d}) pli=${latest.pub_pli_received}(+${latest.pub_pli_received_d})`);
      L.push(`  [sub] relayed=${latest.sub_rtp_relayed}(+${latest.sub_rtp_relayed_d}) dropped=${latest.sub_rtp_dropped}(+${latest.sub_rtp_dropped_d}) sr=${latest.sub_sr_relayed}(+${latest.sub_sr_relayed_d}) nack=${latest.sub_nack_sent}(+${latest.sub_nack_sent_d}) rtx=${latest.sub_rtx_received}(+${latest.sub_rtx_received_d})`);
      // 최근 20슬롯 delta 추이
      if (ring.length > 1) {
        L.push(`  [trend:pub_in]  ${ring.map(e => e.pub_rtp_in_d).join(",")}`);
        L.push(`  [trend:sub_rel] ${ring.map(e => e.sub_rtp_relayed_d).join(",")}`);
        L.push(`  [trend:pub_pli] ${ring.map(e => e.pub_pli_received_d).join(",")}`);
        L.push(`  [trend:sub_nack] ${ring.map(e => e.sub_nack_sent_d).join(",")}`);
      }
    });
  } else {
    L.push("(no pipeline data)");
  }
  L.push("");

  // --- AGG LOG (3초×20 = 1분치 집계 로그) ---
  L.push("--- AGG LOG ---");
  if (aggLogRing.length > 0) {
    aggLogRing.forEach((slot) => {
      if (!slot.entries || slot.entries.length === 0) return;
      const t = fmtLocalTs(slot.ts);
      slot.entries.forEach((e) => {
        // 방 필터: selectedRoom이 있으면 해당 방 + global만
        if (selectedRoom && e.room_id && e.room_id !== selectedRoom) return;
        const room = e.room_id ? `room=${e.room_id.substring(0, 8)}` : "global";
        L.push(`[${t}] ${e.label} ×${e.count} (${e.delta_ms}ms) [${room}]`);
      });
    });
  } else {
    L.push("(no agg data)");
  }
  L.push("");

  L.push("--- CONTRACT CHECK ---");
  buildContractChecks().forEach((c) =>
    L.push(
      `[${c.warn ? "WARN" : c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`,
    ),
  );
  return L.join("\n");
}

// ============================================================
//  클립보드 복사
// ============================================================
export function copySnapshot() {
  const text = buildSnapshot();
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const btn = $("btn-snapshot");
      const orig = btn.textContent;
      btn.textContent = "✅ 복사됨!";
      setTimeout(() => (btn.textContent = orig), 1500);
    })
    .catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
}
