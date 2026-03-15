// author: kodeholic (powered by Claude)
// admin/app.js — 0xLENS Admin Dashboard (진입점)
// Admin WS (/admin/ws) 접속 → telemetry 수신 → 실시간 모니터링

import {
  $, latestTelemetry, sdpTelemetry, telemetryHistory,
  sfuHistory, eventHistory, serverEventLog, joinedAtMap, roomCreatedAtMap,
  selectedUser, MAX_HISTORY, EVENT_HISTORY_MAX, SERVER_EVENT_MAX,
  setRoomsSnapshot, setSelectedRoom, setSelectedUser, setLatestServerMetrics,
  resetAllState,
  pushUserSnapshot, pushSfuSnapshot,
} from "./state.js";
import { renderRoomList, renderOverview } from "./render-overview.js";
import { renderDetail, renderSdpPanel } from "./render-detail.js";
import { renderServerMetrics, showContractCheck } from "./render-panels.js";
import { copySnapshot } from "./snapshot.js";

// ============================================================
//  WS 연결 상태
// ============================================================
const getWsUrl = () => $("srv-url").value;
let adminWs = null;
let wantConnected = false;
let isConnected = false;
let reconnectTimer = null;
const RECONNECT_DELAY = 3000;

// ============================================================
//  1. Admin WebSocket 연결 (ON이면 자동 재접속)
// ============================================================
function connectAdmin() {
  clearReconnectTimer();
  if (adminWs) {
    adminWs.onclose = null;
    adminWs.close();
    adminWs = null;
  }

  const url = getWsUrl();
  console.log("[ADMIN] connecting to", url);
  setConnUI("connecting");

  try {
    adminWs = new WebSocket(url);
  } catch (e) {
    setConnUI("offline");
    scheduleReconnect();
    return;
  }

  adminWs.onopen = () => {
    console.log("[ADMIN] connected");
    isConnected = true;
    setConnUI("connected");
  };

  adminWs.onclose = () => {
    console.log("[ADMIN] disconnected");
    isConnected = false;
    adminWs = null;
    setConnUI("offline");
    if (wantConnected) {
      scheduleReconnect();
    }
  };

  adminWs.onerror = () => {
    console.error("[ADMIN] ws error");
  };

  adminWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleAdminMessage(msg);
    } catch (err) {
      console.error("[ADMIN] parse error:", err);
    }
  };
}

function disconnectAdmin() {
  clearReconnectTimer();
  if (adminWs) {
    adminWs.onclose = null;
    adminWs.close();
    adminWs = null;
  }
  isConnected = false;
  setConnUI("offline");
}

function scheduleReconnect() {
  clearReconnectTimer();
  if (!wantConnected) return;
  reconnectTimer = setTimeout(() => {
    if (wantConnected && !isConnected) {
      console.log("[ADMIN] reconnecting...");
      connectAdmin();
    }
  }, RECONNECT_DELAY);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function toggleConnection() {
  if (wantConnected) {
    wantConnected = false;
    disconnectAdmin();
  } else {
    wantConnected = true;
    connectAdmin();
  }
}

function setConnUI(state) {
  const dot = $("conn-dot");
  const status = $("conn-status");
  const iconOn = $("icon-connect");
  const iconOff = $("icon-disconnect");
  const btn = $("btn-connect");

  switch (state) {
    case "connected":
      dot.className = "w-2 h-2 rounded-full bg-green-500 animate-pulse";
      status.textContent = "연결됨";
      iconOn.classList.add("hidden");
      iconOff.classList.remove("hidden");
      btn.title = "서버 접속 끊기";
      break;
    case "connecting":
      dot.className = "w-2 h-2 rounded-full bg-yellow-500 animate-pulse";
      status.textContent = "연결 중...";
      iconOn.classList.add("hidden");
      iconOff.classList.remove("hidden");
      btn.title = "접속 취소";
      break;
    default:
      dot.className = "w-2 h-2 rounded-full bg-gray-600";
      status.textContent = wantConnected ? "재접속 대기" : "OFFLINE";
      iconOn.classList.remove("hidden");
      iconOff.classList.add("hidden");
      btn.title = "서버 접속";
      break;
  }
}

// ============================================================
//  2. 메시지 처리 + Ring Buffer Push
// ============================================================
function handleAdminMessage(msg) {
  switch (msg.type) {
    case "snapshot":
      setRoomsSnapshot(msg.rooms || []);
      // 입장 시각 / 방 생성 시각 업데이트
      (msg.rooms || []).forEach((room) => {
        if (room.created_at)
          roomCreatedAtMap.set(room.room_id, room.created_at);
        (room.participants || []).forEach((p) => {
          if (p.joined_at && !joinedAtMap.has(p.user_id)) {
            joinedAtMap.set(p.user_id, p.joined_at);
          }
        });
      });
      renderRoomList();
      renderOverview();
      break;

    case "client_telemetry":
      handleClientTelemetry(msg);
      break;

    case "server_metrics":
      setLatestServerMetrics(msg);
      sfuHistory.push(msg);
      while (sfuHistory.length > MAX_HISTORY) sfuHistory.shift();

      // ── Ring Buffer: SFU 스냅샷 ──
      pushSfuSnapshot({
        ts: msg.ts || Date.now(),
        nack_received: msg.nack_received ?? 0,
        rtx_sent: msg.rtx_sent ?? 0,
        pli_sent: msg.pli_sent ?? 0,
        egress_drop: msg.egress_drop ?? 0,
        decrypt: msg.decrypt,
        egress_encrypt: msg.egress_encrypt,
        tokio_busy: msg.tokio_runtime?.busy_ratio ?? 0,
      });

      // 서버 이벤트 타임라인
      {
        const ts = msg.ts || Date.now();
        if ((msg.pli_sent || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_pli", count: msg.pli_sent });
        if ((msg.nack_received || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_nack_recv", count: msg.nack_received });
        if ((msg.rtx_sent || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_rtx", count: msg.rtx_sent });
        if ((msg.egress_drop || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_drop", count: msg.egress_drop });
        if ((msg.encrypt_fail || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_enc_fail", count: msg.encrypt_fail });
        if ((msg.tracks_ack_mismatch || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_tracks_mismatch", count: msg.tracks_ack_mismatch });
        if ((msg.tracks_resync_sent || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_tracks_resync", count: msg.tracks_resync_sent });
        if ((msg.decrypt_fail || 0) > 0)
          serverEventLog.push({ ts, type: "sfu_dec_fail", count: msg.decrypt_fail });
        if (msg.ptt) {
          const p = msg.ptt;
          if ((p.floor_granted || 0) > 0)
            serverEventLog.push({ ts, type: "ptt_granted", count: p.floor_granted });
          if ((p.floor_released || 0) > 0)
            serverEventLog.push({ ts, type: "ptt_released", count: p.floor_released });
          if ((p.floor_revoked || 0) > 0)
            serverEventLog.push({ ts, type: "ptt_revoked", count: p.floor_revoked });
        }
        while (serverEventLog.length > SERVER_EVENT_MAX) serverEventLog.shift();
      }
      renderServerMetrics();
      break;

    default:
      console.log("[ADMIN] unknown msg type:", msg.type);
  }
}

function handleClientTelemetry(msg) {
  const { user_id, room_id, data } = msg;

  if (data.section === "sdp") {
    sdpTelemetry.set(user_id, { ...data, room_id, ts: Date.now() });
    if (selectedUser === user_id) renderSdpPanel();
    return;
  }

  if (data.section === "stats") {
    latestTelemetry.set(user_id, { ...data, room_id, ts: Date.now() });

    if (!telemetryHistory.has(user_id)) telemetryHistory.set(user_id, []);
    const buf = telemetryHistory.get(user_id);
    buf.push({
      ts: Date.now(),
      publish: data.publish,
      subscribe: data.subscribe,
      codecs: data.codecs,
    });
    while (buf.length > MAX_HISTORY) buf.shift();

    // ── Ring Buffer: user별 핵심 delta 스냅샷 (20개 로테이션) ──
    {
      const now = Date.now();
      const snap = { ts: now };

      // publish 요약
      if (data.publish?.outbound) {
        snap.pub = data.publish.outbound.map((ob) => ({
          kind: ob.kind,
          ssrc: ob.ssrc,
          pktsDelta: ob.packetsSentDelta ?? 0,
          bitrate: ob.bitrate ?? 0,
          nackDelta: ob.nackCountDelta ?? 0,
          retxDelta: ob.retransmittedPacketsSentDelta ?? 0,
          fps: ob.framesPerSecond ?? 0,
        }));
      }
      if (data.publish?.network) {
        snap.pubNet = {
          rtt: data.publish.network.rtt ?? 0,
          bw: data.publish.network.availableBitrate ?? 0,
        };
      }

      // subscribe 요약
      if (data.subscribe?.inbound) {
        snap.sub = data.subscribe.inbound.map((ib) => ({
          kind: ib.kind,
          ssrc: ib.ssrc,
          src: ib.sourceUser ?? null,
          recvDelta: ib.packetsReceivedDelta ?? 0,
          lostDelta: ib.packetsLostDelta ?? 0,
          lossRate: ib.lossRateDelta ?? 0,
          jitter: ib.jitter != null ? (ib.jitter * 1000) : 0,
          jbDelay: ib.jitterBufferDelay ?? 0,
          nackDelta: ib.nackCountDelta ?? 0,
          fps: ib.framesPerSecond ?? 0,
          freeze: ib.freezeCount ?? 0,
        }));
      }

      // P1: subTracks 카운트
      if (data.subTracks) {
        snap.subTracks = data.subTracks;
      }

      pushUserSnapshot(user_id, snap);
    }

    // 이벤트 타임라인 누적
    if (data.events && data.events.length > 0) {
      if (!eventHistory.has(user_id)) eventHistory.set(user_id, []);
      const evBuf = eventHistory.get(user_id);
      data.events.forEach((ev) => evBuf.push(ev));
      while (evBuf.length > EVENT_HISTORY_MAX) evBuf.shift();
    }

    renderOverview();
    if (selectedUser === user_id) renderDetail();
  }
}

// ============================================================
//  3. 이벤트 바인딩
// ============================================================
$("btn-connect").onclick = () => toggleConnection();
$("btn-contract").onclick = () => showContractCheck();
$("btn-snapshot").onclick = () => copySnapshot();

$("srv-url").addEventListener("change", () => {
  wantConnected = false;
  disconnectAdmin();
  resetAllState();
  renderRoomList();
  renderOverview();
});

// ============================================================
//  4. 좌우 리사이즈 (col-splitter)
// ============================================================
{
  const splitter = $("col-splitter");
  const rightPanel = $("right-panel");
  let dragging = false;
  let startX = 0;
  let startW = 0;
  const MIN_W = 200;
  const MAX_W = 700;

  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = rightPanel.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const newW = Math.max(MIN_W, Math.min(MAX_W, startW + delta));
    rightPanel.style.width = newW + "px";
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

// ============================================================
//  5. SDP 패널 상하 리사이즈 (sdp-splitter)
// ============================================================
{
  const splitter = $("sdp-splitter");
  const sdpPanel = $("sdp-panel");
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const MIN_H = 80;
  const MAX_H = 500;

  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = sdpPanel.offsetHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(MIN_H, Math.min(MAX_H, startH + delta));
    sdpPanel.style.height = newH + "px";
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

// ============================================================
//  6. 초기화
// ============================================================
setConnUI("offline");

(function autoSelectServer() {
  const sel = $("srv-url");
  const host = location.hostname;
  let match = "";
  if (host === "127.0.0.1" || host === "localhost") {
    match = "ws://127.0.0.1:1974/admin/ws";
  } else if (host === "192.168.0.29") {
    match = "ws://192.168.0.29:1974/admin/ws";
  } else if (host.includes("oxlens.com")) {
    match = "wss://www.oxlens.com/admin/ws";
  }
  if (match) {
    for (const opt of sel.options) {
      if (opt.value === match) {
        sel.value = match;
        break;
      }
    }
  }
})();
