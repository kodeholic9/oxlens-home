// author: kodeholic (powered by Claude)
// livechat-admin/app.js — 0xLENS Admin Dashboard
// Admin WS (/admin/ws) 접속 → telemetry 수신 → 실시간 모니터링

// ============================================================
//  Config & Helpers
// ============================================================
const $ = (id) => document.getElementById(id);
const getWsUrl = () => $('srv-url').value;

let adminWs = null;

// 상태 저장
let roomsSnapshot = [];
let latestTelemetry = new Map();
let sdpTelemetry = new Map();
let selectedRoom = null;
let selectedUser = null;
let latestServerMetrics = null;

// 시계열 버퍼 (향후 차트용, 데이터만 수집)
const MAX_HISTORY = 100;
const telemetryHistory = new Map();
const sfuHistory = [];

// 이벤트 타임라인 버퍼 (user_id → 최근 이벤트 배열)
const EVENT_HISTORY_MAX = 50;
const eventHistory = new Map();

// 접속 의도 (ON/OFF 토글)
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
  console.log('[ADMIN] connecting to', url);
  setConnUI('connecting');

  try {
    adminWs = new WebSocket(url);
  } catch (e) {
    setConnUI('offline');
    scheduleReconnect();
    return;
  }

  adminWs.onopen = () => {
    console.log('[ADMIN] connected');
    isConnected = true;
    setConnUI('connected');
  };

  adminWs.onclose = () => {
    console.log('[ADMIN] disconnected');
    isConnected = false;
    adminWs = null;
    setConnUI('offline');
    if (wantConnected) {
      scheduleReconnect();
    }
  };

  adminWs.onerror = () => {
    console.error('[ADMIN] ws error');
  };

  adminWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleAdminMessage(msg);
    } catch (err) {
      console.error('[ADMIN] parse error:', err);
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
  setConnUI('offline');
}

function scheduleReconnect() {
  clearReconnectTimer();
  if (!wantConnected) return;
  reconnectTimer = setTimeout(() => {
    if (wantConnected && !isConnected) {
      console.log('[ADMIN] reconnecting...');
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
  const dot = $('conn-dot');
  const status = $('conn-status');
  const iconOn = $('icon-connect');
  const iconOff = $('icon-disconnect');
  const btn = $('btn-connect');

  switch (state) {
    case 'connected':
      dot.className = 'w-2 h-2 rounded-full bg-green-500 animate-pulse';
      status.textContent = '연결됨';
      iconOn.classList.add('hidden');
      iconOff.classList.remove('hidden');
      btn.title = '서버 접속 끊기';
      break;
    case 'connecting':
      dot.className = 'w-2 h-2 rounded-full bg-yellow-500 animate-pulse';
      status.textContent = '연결 중...';
      iconOn.classList.add('hidden');
      iconOff.classList.remove('hidden');
      btn.title = '접속 취소';
      break;
    default:
      dot.className = 'w-2 h-2 rounded-full bg-gray-600';
      status.textContent = wantConnected ? '재접속 대기' : 'OFFLINE';
      iconOn.classList.remove('hidden');
      iconOff.classList.add('hidden');
      btn.title = '서버 접속';
      break;
  }
}

// ============================================================
//  2. 메시지 처리
// ============================================================
function handleAdminMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      roomsSnapshot = msg.rooms || [];
      renderRoomList();
      renderOverview();
      break;

    case 'client_telemetry':
      handleClientTelemetry(msg);
      break;

    case 'server_metrics':
      latestServerMetrics = msg;
      sfuHistory.push(msg);
      while (sfuHistory.length > MAX_HISTORY) sfuHistory.shift();
      renderServerMetrics();
      break;

    default:
      console.log('[ADMIN] unknown msg type:', msg.type);
  }
}

function handleClientTelemetry(msg) {
  const { user_id, room_id, data } = msg;

  if (data.section === 'sdp') {
    sdpTelemetry.set(user_id, { ...data, room_id, ts: Date.now() });
    if (selectedUser === user_id) renderSdpPanel();
    return;
  }

  if (data.section === 'stats') {
    latestTelemetry.set(user_id, { ...data, room_id, ts: Date.now() });

    if (!telemetryHistory.has(user_id)) telemetryHistory.set(user_id, []);
    const buf = telemetryHistory.get(user_id);
    buf.push({ ts: Date.now(), publish: data.publish, subscribe: data.subscribe, codecs: data.codecs });
    while (buf.length > MAX_HISTORY) buf.shift();

    // 이벤트 타임라인 누적
    if (data.events && data.events.length > 0) {
      if (!eventHistory.has(user_id)) eventHistory.set(user_id, []);
      const evBuf = eventHistory.get(user_id);
      data.events.forEach(ev => evBuf.push(ev));
      while (evBuf.length > EVENT_HISTORY_MAX) evBuf.shift();
    }

    renderOverview();
    if (selectedUser === user_id) renderDetail();
  }
}

// ============================================================
//  3. Room 목록 렌더
// ============================================================
function renderRoomList() {
  const tbody = $('room-tbody');
  tbody.innerHTML = '';

  if (roomsSnapshot.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="py-6 text-center text-gray-500">방 없음</td></tr>';
    return;
  }

  roomsSnapshot.forEach(room => {
    const isSelected = room.room_id === selectedRoom;
    const pCount = room.participants.length;
    const isPtt = room.mode === 'ptt';
    const modeBadge = isPtt
      ? '<span class="text-[9px] font-mono px-1 py-0.5 bg-brand-rust/20 text-brand-rust rounded">PTT</span>'
      : '';
    const floorInfo = (isPtt && room.ptt?.floor_speaker)
      ? `<div class="text-[9px] text-brand-cyan font-mono">🎙 ${room.ptt.floor_speaker}</div>`
      : '';
    tbody.insertAdjacentHTML('beforeend', `
      <tr data-room="${room.room_id}" class="hover:bg-white/5 cursor-pointer transition-colors ${isSelected ? 'row-selected' : ''}">
        <td class="py-2 px-3">
          <div class="font-medium text-white text-xs flex items-center gap-1">${room.name} ${modeBadge}</div>
          <div class="text-[10px] text-gray-500 truncate max-w-[160px]">${room.room_id.substring(0, 8)}…</div>
          ${floorInfo}
        </td>
        <td class="py-2 px-3 text-center">
          <span class="text-xs ${pCount > 0 ? 'text-brand-cyan' : 'text-gray-500'}">${pCount}/${room.capacity}</span>
        </td>
        <td class="py-2 px-3">
          ${room.participants.map(p => {
            const pubOk = p.pub_ready;
            const cls = pubOk ? 'bg-green-500/20 text-green-400' : 'bg-white/5 text-gray-500';
            return `<span class="inline-block text-[10px] px-1.5 py-0.5 rounded ${cls} mr-1">${p.user_id}</span>`;
          }).join('')}
        </td>
      </tr>
    `);
  });

  tbody.querySelectorAll('tr[data-room]').forEach(row => {
    row.addEventListener('click', () => {
      selectedRoom = row.dataset.room;
      selectedUser = null;
      renderRoomList();
      renderOverview();
    });
  });
}

// ============================================================
//  4. 실시간 개요 테이블
// ============================================================
function renderOverview() {
  const tbody = $('overview-tbody');
  tbody.innerHTML = '';

  const targetUsers = new Set();
  if (selectedRoom) {
    const room = roomsSnapshot.find(r => r.room_id === selectedRoom);
    if (room) room.participants.forEach(p => targetUsers.add(p.user_id));
  } else {
    latestTelemetry.forEach((_, uid) => targetUsers.add(uid));
  }

  if (targetUsers.size === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-gray-500">데이터 없음</td></tr>';
    return;
  }

  targetUsers.forEach(userId => {
    const tel = latestTelemetry.get(userId);
    if (!tel) return;

    if (tel.publish) {
      tel.publish.outbound.forEach(ob => {
        const rtt = tel.publish.network?.rtt ?? '—';
        tbody.insertAdjacentHTML('beforeend', `
          <tr class="hover:bg-white/5 cursor-pointer" data-user="${userId}">
            <td class="py-1.5 px-2"><span class="text-white font-medium">${userId}</span></td>
            <td class="py-1.5 px-2"><span class="text-brand-rust">pub</span></td>
            <td class="py-1.5 px-2">${ob.kind}</td>
            <td class="py-1.5 px-2 font-mono">${ob.packetsSent || 0}</td>
            <td class="py-1.5 px-2 font-mono">—</td>
            <td class="py-1.5 px-2 font-mono">—</td>
            <td class="py-1.5 px-2 font-mono">${rtt}ms</td>
            <td class="py-1.5 px-2">
              ${ob.qualityLimitationReason && ob.qualityLimitationReason !== 'none'
                ? `<span class="text-yellow-400 text-[10px]">${ob.qualityLimitationReason}</span>`
                : '<span class="text-gray-500 text-[10px]">none</span>'}
            </td>
          </tr>
        `);
      });
    }

    if (tel.subscribe) {
      tel.subscribe.inbound.forEach(ib => {
        const jitterMs = ib.jitter != null ? (ib.jitter * 1000).toFixed(1) : '—';
        const lossRate = ib.packetsReceived > 0
          ? ((ib.packetsLost / (ib.packetsReceived + ib.packetsLost)) * 100).toFixed(1)
          : '0.0';
        const rtt = tel.subscribe.network?.rtt ?? '—';
        const lossClass = parseFloat(lossRate) > 1 ? 'text-red-400' : '';
        const jitterClass = parseFloat(jitterMs) > 30 ? 'text-yellow-400' : '';
        const freezeClass = ib.freezeCount > 0 ? 'text-red-400' : '';

        tbody.insertAdjacentHTML('beforeend', `
          <tr class="hover:bg-white/5 cursor-pointer" data-user="${userId}">
            <td class="py-1.5 px-2"><span class="text-white font-medium">${userId}</span></td>
            <td class="py-1.5 px-2"><span class="text-brand-cyan">sub${ib.sourceUser ? '←'+ib.sourceUser : ''}</span></td>
            <td class="py-1.5 px-2">${ib.kind}</td>
            <td class="py-1.5 px-2 font-mono">${ib.packetsReceived || 0}</td>
            <td class="py-1.5 px-2 font-mono ${lossClass}">${lossRate}%</td>
            <td class="py-1.5 px-2 font-mono ${jitterClass}">${jitterMs}ms</td>
            <td class="py-1.5 px-2 font-mono">${rtt}ms</td>
            <td class="py-1.5 px-2">
              ${ib.freezeCount > 0
                ? `<span class="${freezeClass} text-[10px]">freeze:${ib.freezeCount}</span>`
                : '<span class="text-gray-500 text-[10px]">ok</span>'}
            </td>
          </tr>
        `);
      });
    }
  });

  tbody.querySelectorAll('tr[data-user]').forEach(row => {
    row.addEventListener('click', () => {
      selectedUser = row.dataset.user;
      renderDetail();
      renderSdpPanel();
    });
  });
}

// ============================================================
//  5. 참가자 상세 패널
// ============================================================
function renderDetail() {
  const panel = $('detail-body');
  if (!selectedUser) {
    panel.innerHTML = '<div class="text-gray-500 italic text-center py-8">참가자를 클릭하세요</div>';
    $('detail-title').textContent = '참가자 상세';
    return;
  }

  $('detail-title').textContent = `상세: ${selectedUser}`;
  const tel = latestTelemetry.get(selectedUser);
  if (!tel) {
    panel.innerHTML = '<div class="text-gray-500 text-center py-4">데이터 없음</div>';
    return;
  }

  let html = '';

  if (tel.codecs && tel.codecs.length > 0) {
    html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">코덱 상태</div>';
    html += '<div class="space-y-1 mb-4">';
    tel.codecs.forEach(c => {
      const label = c.pc === 'pub' ? '⬆ PUB' : '⬇ SUB';
      const labelCls = c.pc === 'pub' ? 'text-brand-rust' : 'text-brand-cyan';
      const impl = c.encoderImpl || c.decoderImpl || '—';
      const hw = c.powerEfficient === true ? 'HW' : c.powerEfficient === false ? 'SW' : '—';
      const fps = c.fps ?? '—';
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
            ${c.qualityLimitReason && c.qualityLimitReason !== 'none'
              ? `<span class="text-yellow-400">${c.qualityLimitReason}</span>` : ''}
          </div>
        </div>`;
    });
    html += '</div>';
  }

  if (tel.publish?.outbound) {
    html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">Publish 상세</div>';
    html += '<div class="space-y-1 mb-4">';
    tel.publish.outbound.forEach(ob => {
      const actualBps = ob.bitrate != null ? `${(ob.bitrate / 1000).toFixed(0)} kbps` : '—';
      const targetBps = ob.targetBitrate ? `${(ob.targetBitrate / 1000).toFixed(0)}` : '—';

      let frameGapHtml = '';
      if (ob.kind === 'video' && ob.framesEncoded != null && ob.framesSent != null) {
        const gap = ob.framesEncoded - ob.framesSent;
        const gapCls = gap > 5 ? 'text-red-400' : gap > 0 ? 'text-yellow-400' : 'text-gray-500';
        frameGapHtml = `<span class="${gapCls}">enc-sent gap:${gap}</span>`;
      }

      let hugeHtml = '';
      if (ob.kind === 'video' && ob.hugeFramesSent != null && ob.hugeFramesSent > 0) {
        hugeHtml = `<span class="text-yellow-400">huge:${ob.hugeFramesSent}</span>`;
      }

      let qldHtml = '';
      if (ob.kind === 'video' && ob.qualityLimitationDurations) {
        const qld = ob.qualityLimitationDurations;
        const parts = [];
        if (qld.bandwidth > 0) parts.push(`<span class="text-yellow-400">bw:${qld.bandwidth.toFixed(1)}s</span>`);
        if (qld.cpu > 0) parts.push(`<span class="text-red-400">cpu:${qld.cpu.toFixed(1)}s</span>`);
        if (parts.length > 0) {
          qldHtml = `<span class="text-gray-500">qld:</span>${parts.join(' ')}`;
        }
      }

      let encTimeHtml = '';
      if (ob.kind === 'video' && ob.totalEncodeTime != null && ob.framesEncoded > 0) {
        const avgMs = (ob.totalEncodeTime / ob.framesEncoded * 1000).toFixed(1);
        const cls = parseFloat(avgMs) > 30 ? 'text-red-400' : parseFloat(avgMs) > 16 ? 'text-yellow-400' : 'text-gray-500';
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
            ${ob.framesPerSecond != null ? `<span>${ob.framesPerSecond} fps</span>` : ''}
          </div>
          ${(frameGapHtml || hugeHtml || qldHtml || encTimeHtml) ? `
          <div class="flex gap-3 mt-1">
            ${frameGapHtml}${hugeHtml}${encTimeHtml}${qldHtml}
          </div>` : ''}
        </div>`;
    });
    if (tel.publish.network) {
      html += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] text-gray-400">
        RTT: ${tel.publish.network.rtt ?? '—'}ms · BW: ${tel.publish.network.availableBitrate ? (tel.publish.network.availableBitrate / 1000).toFixed(0) + ' kbps' : '—'}
      </div>`;
    }
    html += '</div>';
  }

  if (tel.subscribe?.inbound) {
    html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">Subscribe 상세</div>';
    html += '<div class="space-y-1 mb-4">';
    tel.subscribe.inbound.forEach(ib => {
      const jitterMs = ib.jitter != null ? (ib.jitter * 1000).toFixed(1) : '—';
      const jbDelay = ib.jitterBufferDelay != null ? ib.jitterBufferDelay : '—';
      const srcLabel = ib.sourceUser ? `←${ib.sourceUser}` : '';
      const subBps = ib.bitrate != null ? `${(ib.bitrate / 1000).toFixed(0)} kbps` : '—';
      html += `
        <div class="px-2 py-1.5 bg-brand-dark rounded text-[11px]">
          <div class="flex justify-between text-gray-300">
            <span>${ib.kind} ${srcLabel} (ssrc:${ib.ssrc})</span><span>${subBps} · ${ib.framesPerSecond ?? '—'} fps</span>
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
    html += '</div>';
  }

  // --- 구간별 손실 Cross-Reference (pub→sub 매칭) ---
  html += renderLossCrossRef(selectedUser, tel);

  // --- 이벤트 타임라인 ---
  html += renderEventTimeline(selectedUser);

  panel.innerHTML = html || '<div class="text-gray-500 text-center py-4">데이터 없음</div>';
}

/** 구간별 손실 cross-reference: pub.packetsSent vs sub.packetsReceived 매칭 */
function renderLossCrossRef(userId, tel) {
  // 현재 사용자의 pub 데이터와, 다른 사용자의 sub에서 sourceUser가 이 사용자인 inbound를 매칭
  if (!tel.publish?.outbound) return '';
  const pubByKind = {};
  tel.publish.outbound.forEach(ob => { pubByKind[ob.kind] = ob; });

  const matches = [];
  latestTelemetry.forEach((otherTel, otherUid) => {
    if (otherUid === userId) return;
    (otherTel.subscribe?.inbound || []).forEach(ib => {
      if (ib.sourceUser === userId && pubByKind[ib.kind]) {
        const pub = pubByKind[ib.kind];
        const subTotal = (ib.packetsReceived || 0) + (ib.packetsLost || 0);
        // 추정 누적 손실: pub 전송 - sub 수신(+lost) = SFU 이전 구간에서 사라진 패킷
        // 단, 누적값이라 타이밍 차이로 음수 가능 → 0 clamp
        const transitLoss = Math.max(0, (pub.packetsSent || 0) - subTotal);
        const subLoss = ib.packetsLost || 0;
        matches.push({
          subscriber: otherUid, kind: ib.kind,
          pubSent: pub.packetsSent || 0,
          subReceived: ib.packetsReceived || 0,
          subLost: subLoss,
          transitLoss,
        });
      }
    });
  });

  if (matches.length === 0) return '';
  let h = '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5 mt-2">구간별 손실 추정</div>';
  h += '<div class="space-y-0.5 mb-4">';
  matches.forEach(m => {
    const transitCls = m.transitLoss > 0 ? 'text-yellow-400' : 'text-gray-500';
    const subLossCls = m.subLost > 0 ? 'text-red-400' : 'text-gray-500';
    h += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] flex justify-between">
      <span class="text-gray-400">→${m.subscriber} ${m.kind}</span>
      <span><span class="${transitCls}">A→B:~${m.transitLoss}</span> <span class="${subLossCls}">B→C:${m.subLost}</span> <span class="text-gray-500">sent:${m.pubSent}</span></span>
    </div>`;
  });
  h += '</div>';
  return h;
}

/** 이벤트 타임라인 렌더 */
function renderEventTimeline(userId) {
  const events = eventHistory.get(userId);
  if (!events || events.length === 0) return '';

  let h = '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5 mt-2">이벤트 타임라인</div>';
  h += '<div class="space-y-0.5 mb-4 max-h-48 overflow-y-auto">';

  // 최신순으로 표시
  const sorted = [...events].reverse();
  sorted.forEach(ev => {
    const time = new Date(ev.ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const icon = eventIcon(ev.type);
    const cls = eventColorClass(ev.type);
    const desc = eventDescription(ev);
    h += `<div class="px-2 py-0.5 bg-brand-dark rounded text-[10px] flex items-center gap-2">
      <span class="text-gray-600 font-mono w-16 shrink-0">${time}</span>
      <span>${icon}</span>
      <span class="${cls}">${desc}</span>
    </div>`;
  });
  h += '</div>';
  return h;
}

function eventIcon(type) {
  switch (type) {
    case 'quality_limit_change': return '⚡';
    case 'encoder_impl_change':  return '🔧';
    case 'decoder_impl_change':  return '🔧';
    case 'pli_burst':            return '🔑';
    case 'nack_burst':           return '📦';
    case 'bitrate_drop':         return '📉';
    case 'fps_zero':             return '⏸';
    case 'video_freeze':         return '🧊';
    case 'loss_burst':           return '💀';
    case 'frames_dropped_burst': return '🗑';
    default:                     return '•';
  }
}

function eventColorClass(type) {
  switch (type) {
    case 'quality_limit_change': return 'text-yellow-400';
    case 'encoder_impl_change':  return 'text-yellow-400';
    case 'decoder_impl_change':  return 'text-yellow-400';
    case 'pli_burst':            return 'text-yellow-400';
    case 'nack_burst':           return 'text-yellow-400';
    case 'bitrate_drop':         return 'text-red-400';
    case 'fps_zero':             return 'text-red-400';
    case 'video_freeze':         return 'text-red-400';
    case 'loss_burst':           return 'text-red-400';
    case 'frames_dropped_burst': return 'text-red-400';
    default:                     return 'text-gray-400';
  }
}

function eventDescription(ev) {
  switch (ev.type) {
    case 'quality_limit_change':
      return `${ev.pc}:${ev.kind} quality ${ev.from}→${ev.to}`;
    case 'encoder_impl_change':
      return `${ev.pc}:${ev.kind} encoder ${ev.from}→${ev.to}`;
    case 'decoder_impl_change':
      return `${ev.pc}:${ev.kind} decoder ${ev.from}→${ev.to}`;
    case 'pli_burst':
      return `${ev.pc}:${ev.kind} PLI burst ×${ev.count}`;
    case 'nack_burst':
      return `${ev.pc}:${ev.kind} NACK burst ×${ev.count}`;
    case 'bitrate_drop':
      return `${ev.pc}:${ev.kind} bitrate ${Math.round(ev.from/1000)}k→${Math.round(ev.to/1000)}k`;
    case 'fps_zero':
      return `${ev.pc}:${ev.kind} FPS ${ev.prevFps}→0`;
    case 'video_freeze':
      return `${ev.pc}:${ev.kind} freeze ×${ev.count}`;
    case 'loss_burst':
      return `${ev.pc}:${ev.kind} loss burst ×${ev.count}`;
    case 'frames_dropped_burst':
      return `${ev.pc}:${ev.kind} frames dropped ×${ev.count}`;
    default:
      return `${ev.type}`;
  }
}

// ============================================================
//  6. SDP 상태 패널
// ============================================================
function renderSdpPanel() {
  const panel = $('sdp-body');
  if (!selectedUser) {
    panel.innerHTML = '<div class="text-gray-500 italic text-center py-4">참가자를 클릭하세요</div>';
    return;
  }
  const sdp = sdpTelemetry.get(selectedUser);
  if (!sdp) {
    panel.innerHTML = '<div class="text-gray-500 text-center py-4">SDP 데이터 없음</div>';
    return;
  }

  let html = '';
  const renderMlines = (label, mlines) => {
    if (!mlines || mlines.length === 0) return '';
    let h = `<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">${label} m-lines</div>`;
    h += '<div class="space-y-1 mb-3">';
    mlines.forEach(m => {
      const dirClass = m.direction === 'inactive' ? 'text-red-400' : 'text-gray-300';
      h += `<div class="flex items-center gap-2 px-2 py-1 bg-brand-dark rounded text-[11px] whitespace-nowrap">
        <span class="text-gray-500">mid=${m.mid ?? '—'}</span>
        <span class="text-white">${m.kind}</span>
        <span class="${dirClass}">${m.direction}</span>
        <span class="text-gray-400">${m.codec ?? '—'}</span>
        <span class="text-gray-500">pt=${m.pt ?? '—'}</span>
        <span class="text-gray-500">ssrc=${m.ssrc ?? '—'}</span>
      </div>`;
    });
    h += '</div>';
    return h;
  };
  html += renderMlines('Publish', sdp.pub_mline_summary);
  html += renderMlines('Subscribe', sdp.sub_mline_summary);
  panel.innerHTML = html || '<div class="text-gray-500 text-center py-4">SDP 요약 없음</div>';
}

// ============================================================
//  7. SFU 서버 지표 패널
// ============================================================
function renderServerMetrics() {
  const panel = $('sfu-body');
  if (!latestServerMetrics) {
    panel.innerHTML = '<div class="text-gray-500 italic text-center py-4">데이터 대기</div>';
    return;
  }
  const m = latestServerMetrics;

  const fmtTiming = (t) => {
    if (!t || t === null) return '<span class="text-gray-600">—</span>';
    const avgClass = t.avg_us > 5000 ? 'text-red-400' : t.avg_us > 2000 ? 'text-yellow-400' : 'text-gray-300';
    return `<span class="${avgClass}">${(t.avg_us/1000).toFixed(2)}</span>/<span class="text-gray-400">${(t.max_us/1000).toFixed(2)}</span>ms <span class="text-gray-600">(${t.count})</span>`;
  };

  let html = '';
  html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">타이밍 (avg/max)</div>';
  html += '<div class="space-y-0.5 mb-3 text-[11px]">';
  html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">decrypt</span>${fmtTiming(m.decrypt)}</div>`;
  html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">egress encrypt</span>${fmtTiming(m.egress_encrypt)}</div>`;
  html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">lock wait</span>${fmtTiming(m.lock_wait)}</div>`;
  html += '</div>';

  if (m.fan_out) {
    html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">Fan-out</div>';
    html += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] text-gray-300 mb-3">avg:${m.fan_out.avg} min:${m.fan_out.min} max:${m.fan_out.max}</div>`;
  }

  html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1">RTCP (3s window)</div>';
  html += '<div class="grid grid-cols-2 gap-1 text-[11px]">';
  [['nack', m.nack_received], ['rtx', m.rtx_sent], ['miss', m.rtx_cache_miss],
   ['pli', m.pli_sent], ['SR', m.sr_relayed], ['RR', m.rr_relayed],
   ['twcc_fb', m.twcc_sent], ['twcc_rec', m.twcc_recorded], ['remb', m.remb_sent],
   ['cached', m.rtp_cache_stored], ['no_pub', m.nack_pub_not_found],
   ['no_rtx', m.nack_no_rtx], ['lk_fail', m.cache_lock_fail],
   ['eg_drop', m.egress_drop]].forEach(([label, val]) => {
    const cls = val > 0 ? 'text-white' : 'text-gray-600';
    html += `<div class="px-2 py-0.5 bg-brand-dark rounded flex justify-between"><span class="text-gray-400">${label}</span><span class="${cls}">${val ?? 0}</span></div>`;
  });
  html += '</div>';

  if ((m.encrypt_fail || 0) + (m.decrypt_fail || 0) > 0) {
    html += `<div class="mt-2 px-2 py-1 bg-red-500/10 border border-red-500/30 rounded text-[11px] text-red-400">⚠ enc_fail:${m.encrypt_fail} dec_fail:${m.decrypt_fail}</div>`;
  }
  if ((m.egress_drop || 0) > 0) {
    html += `<div class="mt-1 px-2 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-[11px] text-yellow-400">⚠ egress_drop:${m.egress_drop} (큐 포화 — 구독자 처리 지연)</div>`;
  }

  // --- PTT (v0.5.1) ---
  if (m.ptt) {
    const p = m.ptt;
    html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mt-3 mb-1">PTT (3s window)</div>';
    html += '<div class="grid grid-cols-2 gap-1 text-[11px] mb-3">';
    [['gated', p.rtp_gated], ['rewritten', p.rtp_rewritten],
     ['audio_rw', p.audio_rewritten], ['video_rw', p.video_rewritten], ['vid_skip', p.video_skip],
     ['kf_pend_drop', p.video_pending_drop], ['kf_arrived', p.keyframe_arrived],
     ['granted', p.floor_granted], ['released', p.floor_released], ['revoked', p.floor_revoked],
     ['switches', p.speaker_switches],
     ['nack_remap', p.nack_remapped]].forEach(([label, val]) => {
      const v = val ?? 0;
      const cls = v > 0 ? 'text-white' : 'text-gray-600';
      html += `<div class="px-2 py-0.5 bg-brand-dark rounded flex justify-between"><span class="text-gray-400">${label}</span><span class="${cls}">${v}</span></div>`;
    });
    html += '</div>';
    if ((p.video_pending_drop||0) > 0 && (p.keyframe_arrived||0) === 0) {
      html += '<div class="px-2 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-[11px] text-yellow-400 mb-2">⚠ 키프레임 미도착 — PLI 전송 또는 VP8 감지 확인 필요</div>';
    }
    if ((p.floor_revoked||0) > 0) {
      html += '<div class="px-2 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-[11px] text-yellow-400 mb-2">⚠ Floor Revoke 발생 — 클라이언트 PING 미전송 또는 네트워크 문제</div>';
    }
  }

  // --- Tokio Runtime (v0.3.9) ---
  if (m.tokio_runtime) {
    const rt = m.tokio_runtime;
    const busyPct = (parseFloat(rt.busy_ratio) * 100).toFixed(1);
    const busyClass = busyPct > 95 ? 'text-red-400' : busyPct > 85 ? 'text-yellow-400' : 'text-green-400';
    html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mt-3 mb-1">Tokio Runtime</div>';
    html += '<div class="space-y-0.5 mb-3 text-[11px]">';
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">busy</span><span class="${busyClass} font-bold">${busyPct}%</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">alive tasks</span><span class="text-gray-300">${rt.alive_tasks}</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">global queue</span><span class="${rt.global_queue > 50 ? 'text-yellow-400' : 'text-gray-300'}">${rt.global_queue}</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">budget yield</span><span class="${rt.budget_yield > 100 ? 'text-yellow-400' : 'text-gray-300'}">${rt.budget_yield}</span></div>`;
    html += `<div class="flex justify-between px-2 py-1 bg-brand-dark rounded"><span class="text-gray-400">io ready</span><span class="text-gray-300">${rt.io_ready}</span></div>`;
    if (rt.workers && rt.workers.length > 0) {
      html += '<div class="text-[10px] text-gray-600 font-mono mt-1 mb-0.5 px-1">workers</div>';
      rt.workers.forEach((w, i) => {
        const wBusy = (parseFloat(w.busy_ratio) * 100).toFixed(1);
        const wCls = wBusy > 95 ? 'text-red-400' : wBusy > 85 ? 'text-yellow-400' : 'text-gray-300';
        html += `<div class="flex justify-between px-2 py-0.5 bg-brand-dark/50 rounded text-[10px]"><span class="text-gray-500">W${i}</span><span class="${wCls}">${wBusy}%</span><span class="text-gray-600">polls:${w.polls} steal:${w.steals}</span></div>`;
      });
    }
    html += '</div>';
  }

  // --- Environment meta (v0.3.9) ---
  if (m.env) {
    const e = m.env;
    html += '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mt-3 mb-1">Environment</div>';
    html += `<div class="px-2 py-1 bg-brand-dark rounded text-[11px] text-gray-500 font-mono">v${e.version} · ${e.build_mode} · ${e.bwe_mode} · W${e.worker_count} · ${e.log_level}</div>`;
  }

  panel.innerHTML = html;
}

// ============================================================
//  8. Contract 체크리스트
// ============================================================
function buildContractChecks() {
  const checks = [];
  const m = latestServerMetrics;

  let sdpOk = true;
  sdpTelemetry.forEach(sdp => {
    (sdp.pub_mline_summary || []).forEach(ml => { if (ml.direction === 'inactive') sdpOk = false; });
  });
  checks.push({ name: 'sdp_negotiation', pass: sdpOk, detail: sdpOk ? 'all m-lines OK' : 'inactive detected' });

  let encoderOk = true;
  latestTelemetry.forEach(tel => {
    (tel.codecs || []).forEach(c => { if (c.qualityLimitReason && c.qualityLimitReason !== 'none') encoderOk = false; });
  });
  checks.push({ name: 'encoder_healthy', pass: encoderOk, detail: encoderOk ? 'no limitation' : 'quality limited' });

  checks.push({ name: 'sr_relay', pass: m && (m.sr_relayed||0) > 0, detail: `${m?.sr_relayed||0} in 3s` });
  checks.push({ name: 'rr_relay', pass: m && (m.rr_relayed||0) > 0, detail: `${m?.rr_relayed||0} in 3s` });

  const nR = m?.nack_received||0, rS = m?.rtx_sent||0, rM = m?.rtx_cache_miss||0;
  checks.push({ name: 'nack_rtx', pass: nR === 0 || (rS/(rS+rM) > 0.8), detail: nR === 0 ? 'no NACK' : `${rS}/${rS+rM} hit` });

  let jbOk = true;
  latestTelemetry.forEach(tel => {
    (tel.subscribe?.inbound||[]).forEach(ib => {
      if (ib.jitterBufferDelay != null && ib.jitterBufferDelay > 100) jbOk = false;
    });
  });
  checks.push({ name: 'jitter_buffer', pass: jbOk, detail: jbOk ? '< 100ms' : '> 100ms' });

  let fzOk = true;
  latestTelemetry.forEach(tel => { (tel.subscribe?.inbound||[]).forEach(ib => { if ((ib.freezeCount||0) > 0) fzOk = false; }); });
  checks.push({ name: 'video_freeze', pass: fzOk, detail: fzOk ? '0 freezes' : 'freeze detected' });

  const bweMode = m?.env?.bwe_mode || 'twcc';
  if (bweMode === 'remb') {
    const rembSent = m?.remb_sent || 0;
    checks.push({ name: 'bwe_feedback', pass: rembSent > 0, detail: rembSent > 0 ? `REMB ${rembSent}/3s` : 'no REMB sent' });
  } else {
    const twccSent = m?.twcc_sent || 0;
    checks.push({ name: 'bwe_feedback', pass: twccSent > 0, detail: twccSent > 0 ? `TWCC ${twccSent}/3s` : 'no TWCC sent' });
  }

  let trackOk = true, trackDetail = 'all live';
  let pcOk = true, pcDetail = 'connected';
  let tabWarn = false;
  latestTelemetry.forEach((tel) => {
    const p = tel.ptt;
    if (!p) return;
    if (!p.tabVisible) tabWarn = true;
    (p.tracks||[]).forEach(t => {
      if (t.readyState === 'ended') { trackOk = false; trackDetail = `${t.kind} ended`; }
    });
    if (p.pubPc && (p.pubPc.connectionState === 'failed' || p.pubPc.connectionState === 'closed')) {
      pcOk = false; pcDetail = `pub ${p.pubPc.connectionState}`;
    }
  });
  checks.push({ name: 'track_health', pass: trackOk, detail: trackDetail });
  checks.push({ name: 'pc_connection', pass: pcOk, detail: pcDetail });
  if (tabWarn) checks.push({ name: 'tab_visibility', pass: true, warn: true, detail: 'tab hidden' });

  const busyRatio = m?.tokio_runtime ? parseFloat(m.tokio_runtime.busy_ratio) : 0;
  const busyPct = (busyRatio * 100).toFixed(1);
  checks.push({ name: 'runtime_busy', pass: busyRatio < 0.85, warn: busyRatio >= 0.85 && busyRatio < 0.95, detail: `${busyPct}%${busyRatio >= 0.95 ? ' SATURATED' : busyRatio >= 0.85 ? ' HIGH' : ''}` });

  let encGapOk = true, encGapDetail = 'no gap';
  latestTelemetry.forEach(tel => {
    (tel.publish?.outbound || []).forEach(ob => {
      if (ob.kind === 'video' && ob.framesEncoded != null && ob.framesSent != null) {
        const gap = ob.framesEncoded - ob.framesSent;
        if (gap > 5) { encGapOk = false; encGapDetail = `gap=${gap}`; }
      }
    });
  });
  checks.push({ name: 'encoder_bottleneck', pass: encGapOk, detail: encGapDetail });

  return checks;
}

function showContractCheck() {
  const checks = buildContractChecks();
  const panel = $('sfu-body');
  let html = '<div class="text-[10px] text-gray-500 uppercase tracking-wider font-mono mb-1.5">WebRTC Contract</div><div class="space-y-0.5">';
  checks.forEach(c => {
    const icon = c.warn ? '⚠️' : c.pass ? '✅' : '❌';
    const cls = c.warn ? 'text-yellow-400' : c.pass ? 'text-green-400' : 'text-red-400';
    html += `<div class="flex items-center justify-between px-2 py-1 bg-brand-dark rounded text-[11px]">
      <span class="${cls}">${icon} ${c.name}</span><span class="text-gray-500">${c.detail}</span></div>`;
  });
  html += '</div>';
  panel.innerHTML = html;
}

// ============================================================
//  9. 스냅샷 내보내기
// ============================================================
function buildSnapshot() {
  const ts = new Date().toISOString();
  const L = [];
  L.push('=== OXLENS-SFU TELEMETRY SNAPSHOT ===');
  L.push(`timestamp: ${ts}`);
  L.push('');

  L.push('--- SDP STATE ---');
  sdpTelemetry.forEach((sdp, uid) => {
    (sdp.pub_mline_summary||[]).forEach(m => L.push(`[${uid}:pub] mid=${m.mid} ${m.kind} ${m.direction} ${m.codec||'?'} pt=${m.pt} ssrc=${m.ssrc}`));
    (sdp.sub_mline_summary||[]).forEach(m => L.push(`[${uid}:sub] mid=${m.mid} ${m.kind} ${m.direction} ${m.codec||'?'} pt=${m.pt} ssrc=${m.ssrc}`));
  });
  L.push('');

  L.push('--- ENCODER/DECODER ---');
  latestTelemetry.forEach((tel, uid) => {
    (tel.codecs||[]).forEach(c => {
      const impl = c.encoderImpl||c.decoderImpl||'?', hw = c.powerEfficient===true?'Y':'N';
      L.push(c.pc==='pub' ? `[${uid}:pub:${c.kind}] impl=${impl} hw=${hw} fps=${c.fps??'?'} quality_limit=${c.qualityLimitReason||'none'}` : `[${uid}:sub:${c.kind}] impl=${impl} hw=${hw} fps=${c.fps??'?'}`);
    });
  });
  L.push('');

  L.push('--- PUBLISH (3s window) ---');
  latestTelemetry.forEach((tel, uid) => {
    (tel.publish?.outbound||[]).forEach(ob => {
      const bps = ob.bitrate != null ? Math.round(ob.bitrate/1000) : '?';
      const tgt = ob.targetBitrate ? Math.round(ob.targetBitrate) : '?';
      const fpsStr = ob.framesPerSecond != null ? ` fps=${ob.framesPerSecond}` : '';
      L.push(`[${uid}:${ob.kind}] pkts=${ob.packetsSent} bytes=${ob.bytesSent} nack=${ob.nackCount} pli=${ob.pliCount} bitrate=${bps}kbps target=${tgt} retx=${ob.retransmittedPacketsSent}${fpsStr}`);
      if (ob.kind === 'video') {
        const encSent = ob.framesSent ?? '?';
        const encEnc = ob.framesEncoded ?? '?';
        const huge = ob.hugeFramesSent ?? 0;
        const encTime = (ob.totalEncodeTime != null && ob.framesEncoded > 0) ? (ob.totalEncodeTime / ob.framesEncoded * 1000).toFixed(1) + 'ms/f' : '?';
        const qld = ob.qualityLimitationDurations;
        const qldStr = qld ? `bw=${qld.bandwidth?.toFixed(1)||0}s cpu=${qld.cpu?.toFixed(1)||0}s` : 'N/A';
        L.push(`[${uid}:video:enc] encoded=${encEnc} sent=${encSent} gap=${encEnc!=='?'&&encSent!=='?'?(encEnc-encSent):'?'} huge=${huge} enc_time=${encTime} qld_delta=[${qldStr}]`);
      }
    });
  });
  L.push('');

  L.push('--- SUBSCRIBE (3s window) ---');
  latestTelemetry.forEach((tel, uid) => {
    (tel.subscribe?.inbound||[]).forEach(ib => {
      const src = ib.sourceUser ? `←${ib.sourceUser}` : '';
      const bps = ib.bitrate != null ? Math.round(ib.bitrate/1000) : '?';
      const jMs = ib.jitter!=null?(ib.jitter*1000).toFixed(1):'?';
      const jbMs = ib.jitterBufferDelay != null ? ib.jitterBufferDelay : '?';
      L.push(`[${uid}${src}:${ib.kind}] pkts=${ib.packetsReceived} lost=${ib.packetsLost} bitrate=${bps}kbps jitter=${jMs}ms jb_delay=${jbMs}ms nack_sent=${ib.nackCount} freeze=${ib.freezeCount} dropped=${ib.framesDropped??0}${ib.framesPerSecond!=null?` fps=${ib.framesPerSecond}`:''}`);
    });
  });
  L.push('');

  L.push('--- NETWORK ---');
  latestTelemetry.forEach((tel, uid) => {
    if (tel.publish?.network) L.push(`[${uid}:pub] rtt=${tel.publish.network.rtt??'?'}ms available_bitrate=${tel.publish.network.availableBitrate??'?'}`);
    if (tel.subscribe?.network) L.push(`[${uid}:sub] rtt=${tel.subscribe.network.rtt??'?'}ms`);
  });
  L.push('');

  // --- LOSS CROSS-REFERENCE ---
  L.push('--- LOSS CROSS-REFERENCE ---');
  latestTelemetry.forEach((tel, uid) => {
    const pubByKind = {};
    (tel.publish?.outbound || []).forEach(ob => { pubByKind[ob.kind] = ob; });
    latestTelemetry.forEach((otherTel, otherUid) => {
      if (otherUid === uid) return;
      (otherTel.subscribe?.inbound || []).forEach(ib => {
        if (ib.sourceUser === uid && pubByKind[ib.kind]) {
          const pub = pubByKind[ib.kind];
          const subTotal = (ib.packetsReceived || 0) + (ib.packetsLost || 0);
          const transitLoss = Math.max(0, (pub.packetsSent || 0) - subTotal);
          L.push(`[${uid}→${otherUid}:${ib.kind}] pub_sent=${pub.packetsSent} sub_recv=${ib.packetsReceived} sub_lost=${ib.packetsLost} transit_loss≈${transitLoss}`);
        }
      });
    });
  });
  L.push('');

  // --- EVENT TIMELINE ---
  L.push('--- EVENT TIMELINE ---');
  eventHistory.forEach((events, uid) => {
    events.forEach(ev => {
      const time = new Date(ev.ts).toISOString();
      L.push(`[${uid}] ${time} ${ev.type} ${eventDescription(ev)}`);
    });
  });
  L.push('');

  L.push('--- PTT DIAGNOSTICS ---');
  latestTelemetry.forEach((tel, uid) => {
    const p = tel.ptt;
    if (!p) return;
    const pts = p.pttTrackState || {};
    L.push(`[${uid}:state] mode=${p.roomMode||'?'} floor=${p.floorState} ptt_audio=${pts.audio||'?'} ptt_video=${pts.video||'?'} video_off=${p.userVideoOff} tab=${p.tabVisible?'visible':'hidden'}`);
    (p.tracks||[]).forEach(t => {
      L.push(`[${uid}:track:${t.kind}] enabled=${t.enabled} readyState=${t.readyState} muted=${t.muted} label=${t.label||'?'}`);
    });
    (p.senders||[]).forEach(s => {
      L.push(`[${uid}:sender:${s.kind}] hasTrack=${s.hasTrack} active=${s.active} readyState=${s.readyState} maxBitrate=${s.maxBitrate??'none'}`);
    });
    if (p.pubPc) L.push(`[${uid}:pubPc] conn=${p.pubPc.connectionState} ice=${p.pubPc.iceState} dtls=${p.pubPc.dtlsState??'?'}`);
    if (p.subPc) L.push(`[${uid}:subPc] conn=${p.subPc.connectionState} ice=${p.subPc.iceState} dtls=${p.subPc.dtlsState??'?'}`);
  });
  L.push('');

  L.push('--- SFU SERVER (3s window) ---');
  if (latestServerMetrics) {
    const m = latestServerMetrics;
    const f = t => t?`avg=${(t.avg_us/1000).toFixed(2)}ms max=${(t.max_us/1000).toFixed(2)}ms count=${t.count}`:'N/A';
    L.push(`[server] decrypt: ${f(m.decrypt)}`);
    L.push(`[server] egress_encrypt: ${f(m.egress_encrypt)}`);
    L.push(`[server] lock_wait: ${f(m.lock_wait)}`);
    L.push(`[server] nack_recv=${m.nack_received} rtx_sent=${m.rtx_sent} rtx_miss=${m.rtx_cache_miss} pli_sent=${m.pli_sent} sr_relay=${m.sr_relayed} rr_relay=${m.rr_relayed} twcc_fb=${m.twcc_sent} twcc_rec=${m.twcc_recorded} remb=${m.remb_sent}`);
    L.push(`[server:rtx_diag] cache_stored=${m.rtp_cache_stored??0} pub_not_found=${m.nack_pub_not_found??0} no_rtx=${m.nack_no_rtx??0} lock_fail=${m.cache_lock_fail??0} egress_drop=${m.egress_drop??0}`);
    if (m.ptt) {
      const p = m.ptt;
      L.push(`[server:ptt] gated=${p.rtp_gated??0} rewritten=${p.rtp_rewritten??0} audio_rw=${p.audio_rewritten??0} video_rw=${p.video_rewritten??0} vid_skip=${p.video_skip??0} kf_pending_drop=${p.video_pending_drop??0} kf_arrived=${p.keyframe_arrived??0} granted=${p.floor_granted??0} released=${p.floor_released??0} revoked=${p.floor_revoked??0} switches=${p.speaker_switches??0} nack_remap=${p.nack_remapped??0}`);
    }
    if (m.env) {
      const e = m.env;
      L.push(`[server] env: v${e.version} build=${e.build_mode} bwe=${e.bwe_mode} workers=${e.worker_count} log=${e.log_level}`);
    }
    if (m.tokio_runtime) {
      const rt = m.tokio_runtime;
      L.push(`[tokio] busy=${(parseFloat(rt.busy_ratio)*100).toFixed(1)}% alive_tasks=${rt.alive_tasks} global_queue=${rt.global_queue} budget_yield=${rt.budget_yield} io_ready=${rt.io_ready} blocking=${rt.blocking_threads}`);
      if (rt.workers) {
        rt.workers.forEach((w, i) => L.push(`[tokio:W${i}] busy=${(parseFloat(w.busy_ratio)*100).toFixed(1)}% polls=${w.polls} steals=${w.steals} noops=${w.noops}`));
      }
    }
  }
  L.push('');

  L.push('--- CONTRACT CHECK ---');
  buildContractChecks().forEach(c => L.push(`[${c.warn?'WARN':c.pass?'PASS':'FAIL'}] ${c.name}: ${c.detail}`));
  return L.join('\n');
}

function copySnapshot() {
  const text = buildSnapshot();
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('btn-snapshot');
    const orig = btn.textContent;
    btn.textContent = '✅ 복사됨!';
    setTimeout(() => btn.textContent = orig, 1500);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ============================================================
//  10. 이벤트 바인딩
// ============================================================
$('btn-connect').onclick = () => toggleConnection();
$('btn-contract').onclick = () => showContractCheck();
$('btn-snapshot').onclick = () => copySnapshot();

$('srv-url').addEventListener('change', () => {
  wantConnected = false;
  disconnectAdmin();
  roomsSnapshot = [];
  latestTelemetry.clear();
  sdpTelemetry.clear();
  telemetryHistory.clear();
  eventHistory.clear();
  sfuHistory.length = 0;
  selectedRoom = null;
  selectedUser = null;
  latestServerMetrics = null;
  renderRoomList();
  renderOverview();
});

// ============================================================
//  11. 좌우 리사이즈 (col-splitter)
// ============================================================
{
  const splitter = $('col-splitter');
  const rightPanel = $('right-panel');
  let dragging = false;
  let startX = 0;
  let startW = 0;
  const MIN_W = 200;
  const MAX_W = 700;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = rightPanel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const newW = Math.max(MIN_W, Math.min(MAX_W, startW + delta));
    rightPanel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ============================================================
//  12. SDP 패널 상하 리사이즈 (sdp-splitter)
// ============================================================
{
  const splitter = $('sdp-splitter');
  const sdpPanel = $('sdp-panel');
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const MIN_H = 80;
  const MAX_H = 500;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = sdpPanel.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(MIN_H, Math.min(MAX_H, startH + delta));
    sdpPanel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ============================================================
//  13. 초기화
// ============================================================
setConnUI('offline');

(function autoSelectServer() {
  const sel = $('srv-url');
  const host = location.hostname;
  let match = '';
  if (host === '127.0.0.1' || host === 'localhost') {
    match = 'ws://127.0.0.1:1974/admin/ws';
  } else if (host === '192.168.0.29') {
    match = 'ws://192.168.0.29:1974/admin/ws';
  } else if (host.includes('oxlens.com')) {
    match = 'wss://www.oxlens.com/admin/ws';
  }
  if (match) {
    for (const opt of sel.options) {
      if (opt.value === match) { sel.value = match; break; }
    }
  }
})();
