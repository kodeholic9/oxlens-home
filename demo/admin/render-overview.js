// author: kodeholic (powered by Claude)
// admin/render-overview.js — 방 목록 + 실시간 개요 테이블

import {
  $, roomsSnapshot, latestTelemetry, selectedRoom, selectedUser,
  joinedAtMap, fmtElapsed,
  setSelectedRoom, setSelectedUser,
} from "./state.js";
import { renderDetail, renderSdpPanel } from "./render-detail.js";

// ============================================================
//  Room 목록 렌더
// ============================================================
export function renderRoomList() {
  const tbody = $("room-tbody");
  tbody.innerHTML = "";

  if (roomsSnapshot.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="py-6 text-center text-gray-500">방 없음</td></tr>';
    return;
  }

  roomsSnapshot.forEach((room) => {
    const isSelected = room.room_id === selectedRoom;
    const pCount = room.participants.length;
    const isPtt = room.mode === "ptt";
    const modeBadge = isPtt
      ? '<span class="text-[9px] font-mono px-1 py-0.5 bg-brand-rust/20 text-brand-rust rounded">PTT</span>'
      : "";
    const floorInfo =
      isPtt && room.ptt?.floor_speaker
        ? `<div class="text-[9px] text-brand-cyan font-mono">🎙 ${room.ptt.floor_speaker}</div>`
        : "";
    tbody.insertAdjacentHTML(
      "beforeend",
      `
      <tr data-room="${room.room_id}" class="hover:bg-white/5 cursor-pointer transition-colors ${isSelected ? "row-selected" : ""}">
        <td class="py-2 px-3">
          <div class="font-medium text-white text-xs flex items-center gap-1">${room.name} ${modeBadge}</div>
          <div class="text-[10px] text-gray-500 truncate max-w-[160px]">${room.room_id.substring(0, 8)}…</div>
          ${floorInfo}
        </td>
        <td class="py-2 px-3 text-center">
          <span class="text-xs ${pCount > 0 ? "text-brand-cyan" : "text-gray-500"}">${pCount}/${room.capacity}</span>
        </td>
        <td class="py-2 px-3">
          ${room.participants
            .map((p) => {
              const pubOk = p.pub_ready;
              const cls = pubOk
                ? "bg-green-500/20 text-green-400"
                : "bg-white/5 text-gray-500";
              return `<span class="inline-block text-[10px] px-1.5 py-0.5 rounded ${cls} mr-1">${p.user_id}</span>`;
            })
            .join("")}
        </td>
      </tr>
    `,
    );
  });

  tbody.querySelectorAll("tr[data-room]").forEach((row) => {
    row.addEventListener("click", () => {
      setSelectedRoom(row.dataset.room);
      setSelectedUser(null);
      renderRoomList();
      renderOverview();
    });
  });
}

// ============================================================
//  실시간 개요 테이블
// ============================================================
export function renderOverview() {
  const tbody = $("overview-tbody");
  tbody.innerHTML = "";

  const targetUsers = new Set();
  if (selectedRoom) {
    const room = roomsSnapshot.find((r) => r.room_id === selectedRoom);
    if (room) room.participants.forEach((p) => targetUsers.add(p.user_id));
  } else {
    latestTelemetry.forEach((_, uid) => targetUsers.add(uid));
  }

  if (targetUsers.size === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="py-6 text-center text-gray-500">데이터 없음</td></tr>';
    return;
  }

  targetUsers.forEach((userId) => {
    const tel = latestTelemetry.get(userId);
    if (!tel) return;

    const joinedAt = joinedAtMap.get(userId);
    const elapsedStr = joinedAt ? fmtElapsed(Date.now() - joinedAt) : "—";

    if (tel.publish) {
      tel.publish.outbound.forEach((ob) => {
        const rtt = tel.publish.network?.rtt ?? "—";
        const limitCls =
          ob.qualityLimitationReason && ob.qualityLimitationReason !== "none"
            ? "text-yellow-400"
            : "text-gray-500";
        tbody.insertAdjacentHTML(
          "beforeend",
          `
          <tr class="hover:bg-white/5 cursor-pointer" data-user="${userId}">
            <td class="py-1.5 px-2">
              <span class="text-white font-medium">${userId}</span>
              <span class="text-[9px] text-gray-500 ml-1">${elapsedStr}</span>
            </td>
            <td class="py-1.5 px-2"><span class="text-brand-rust">pub</span></td>
            <td class="py-1.5 px-2">${ob.kind}</td>
            <td class="py-1.5 px-2 font-mono">${ob.packetsSentDelta ?? ob.packetsSent ?? 0}<span class="text-gray-600">/3s</span></td>
            <td class="py-1.5 px-2 font-mono">—</td>
            <td class="py-1.5 px-2 font-mono">—</td>
            <td class="py-1.5 px-2 font-mono">${rtt}ms</td>
            <td class="py-1.5 px-2">
              <span class="${limitCls} text-[10px]">${ob.qualityLimitationReason || "none"}</span>
            </td>
          </tr>
        `,
        );
      });
    }

    if (tel.subscribe) {
      tel.subscribe.inbound.forEach((ib) => {
        const jitterMs =
          ib.jitter != null ? (ib.jitter * 1000).toFixed(1) : "—";
        const lossRate =
          ib.lossRateDelta != null
            ? ib.lossRateDelta.toFixed(1)
            : ib.packetsReceived > 0
              ? (
                  (ib.packetsLost / (ib.packetsReceived + ib.packetsLost)) *
                  100
                ).toFixed(1)
              : "0.0";
        const rtt = tel.subscribe.network?.rtt ?? "—";
        const lossClass = parseFloat(lossRate) > 1 ? "text-red-400" : "";
        const jitterClass = parseFloat(jitterMs) > 30 ? "text-yellow-400" : "";
        const freezeClass = ib.freezeCount > 0 ? "text-red-400" : "";
        const lossLabel =
          ib.lossRateDelta != null ? `${lossRate}%△` : `${lossRate}%`;

        tbody.insertAdjacentHTML(
          "beforeend",
          `
          <tr class="hover:bg-white/5 cursor-pointer" data-user="${userId}">
            <td class="py-1.5 px-2">
              <span class="text-white font-medium">${userId}</span>
              <span class="text-[9px] text-gray-500 ml-1">${elapsedStr}</span>
            </td>
            <td class="py-1.5 px-2"><span class="text-brand-cyan">sub${ib.sourceUser ? "←" + ib.sourceUser : ""}</span></td>
            <td class="py-1.5 px-2">${ib.kind}</td>
            <td class="py-1.5 px-2 font-mono">${ib.packetsReceivedDelta ?? ib.packetsReceived ?? 0}<span class="text-gray-600">/3s</span></td>
            <td class="py-1.5 px-2 font-mono ${lossClass}">${lossLabel}</td>
            <td class="py-1.5 px-2 font-mono ${jitterClass}">${jitterMs}ms</td>
            <td class="py-1.5 px-2 font-mono">${rtt}ms</td>
            <td class="py-1.5 px-2">
              ${
                ib.freezeCount > 0
                  ? `<span class="${freezeClass} text-[10px]">freeze:${ib.freezeCount}</span>`
                  : '<span class="text-gray-500 text-[10px]">ok</span>'
              }
            </td>
          </tr>
        `,
        );
      });
    }
  });

  tbody.querySelectorAll("tr[data-user]").forEach((row) => {
    row.addEventListener("click", () => {
      setSelectedUser(row.dataset.user);
      renderDetail();
      renderSdpPanel();
    });
  });
}
