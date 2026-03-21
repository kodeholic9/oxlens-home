// author: kodeholic (powered by Claude)
// livechat-client/app.js — Light LiveChat 클라이언트 UI
// SDK 이벤트 구독으로만 동작 — 비즈니스 로직 Zero

import { OxLensClient, CONN, FLOOR, SDK_VERSION, DEVICE_KIND } from "../../core/client.js";

// ============================================================
//  DOM
// ============================================================
const $ = (id) => document.getElementById(id);

// ============================================================
//  State (UI only)
// ============================================================
let sdk = null;
let isSpeakerOn  = true;
let _pttSpeakerTimer = null;
const PTT_SPEAKER_OFF_DELAY = 500;
let isMicMuted   = false;
let isConnected  = false;
let isInRoom     = false;
let isControlLocked = false;
let isConnecting = false;
// 방 입장 상태: null | "joining" | "connecting" | "connected"
let joinPhase = null;
let currentRoomMode = "conference";
let localStream  = null;
// userId → MediaStream (subscribe PC ontrack에서 stream.id='light-{userId}' 기준 매핑)
const remoteStreams = new Map();

const remoteAudio = $("remote-audio");

// Simulcast + 전체 화면
const _manualLayerOverride = new Set();
let _longPressTimer = null;
let _fullscreenUid = null;

// ============================================================
//  Util
// ============================================================
function log(type, msg) {
  const t = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const prefix = type === "err" ? "[ERR]" : type === "ok" ? "[OK] " : "[SYS]";
  const out = `[${t}] ${prefix} ${msg}`;
  if (type === "err") console.error(out);
  else console.log(out);
}

let gestureUnlocked = false;
function unlockAudio(reason) {
  gestureUnlocked = true;
  remoteAudio.play().catch(() => {});
}
function forcePlay(reason) {
  remoteAudio.play()
    .then(() => log("ok", `[audio] play() 성공 (${reason})`))
    .catch((err) => log("err", `[audio] play() 실패 (${reason}): ${err.name}`));
}

// ============================================================
//  UI Updates
// ============================================================
function updateWsBadge(state) {
  const el = $("ws-badge");
  const map = {
    [CONN.DISCONNECTED]: ["ph-wifi-slash",   "OFF",   "bg-brand-surface text-gray-500 border border-white/10", ""],
    [CONN.CONNECTING]:   ["ph-wifi-medium",  "",      "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30", "animate-pulse"],
    [CONN.CONNECTED]:    ["ph-wifi-high",    "",      "bg-blue-500/20 text-blue-400 border border-blue-500/30", ""],
    [CONN.IDENTIFIED]:   ["ph-check-circle", "READY", "bg-green-500/20 text-green-400 border border-green-500/30", ""],
  };
  const [icon, label, cls, anim] = map[state] || ["ph-question", "?", "bg-brand-surface text-gray-500 border border-white/10", ""];
  el.innerHTML = `<i class="ph ${icon} text-sm ${anim}"></i>${label ? `<span>${label}</span>` : ""}`;
  el.className = `px-2 py-0.5 rounded text-xs font-medium font-mono flex items-center gap-1 ${cls}`;
}

function updateConnectBtn() {
  const btn = $("btn-connect");
  if (isConnected) {
    btn.className = "w-10 h-10 rounded-full flex items-center justify-center transition-colors bg-green-500/20 border border-green-400 text-green-400 shadow-[0_0_8px_rgba(74,222,128,0.3)]";
    btn.title = "해제";
  } else {
    btn.className = "w-10 h-10 rounded-full flex items-center justify-center transition-colors bg-brand-surface border border-white/10 text-gray-400 hover:bg-white/5 hover:text-brand-cyan";
    btn.title = "연결";
  }
}

function updateRoomBtn() {
  const btn = $("btn-room");
  const busy = joinPhase && joinPhase !== "connected";
  if (busy) {
    // 입장 진행 중 (모든 단계) — 노란 펌스 + disabled
    btn.className = "w-10 h-10 rounded-full flex items-center justify-center transition-colors bg-yellow-500/20 border border-yellow-400 text-yellow-400 animate-pulse disabled:opacity-50";
    btn.title = "입장 중…";
    btn.disabled = true;
    $("icon-room-enter").classList.remove("hidden");
    $("icon-room-exit").classList.add("hidden");
  } else if (isInRoom) {
    btn.className = "w-10 h-10 rounded-full flex items-center justify-center transition-colors bg-green-500/20 border border-green-400 text-green-400 shadow-[0_0_8px_rgba(74,222,128,0.3)] disabled:opacity-50";
    btn.title = "퇴장";
    btn.disabled = false;
    $("icon-room-enter").classList.add("hidden");
    $("icon-room-exit").classList.remove("hidden");
  } else {
    btn.className = "w-10 h-10 rounded-full flex items-center justify-center transition-colors bg-brand-surface border border-white/10 text-gray-400 hover:bg-white/5 hover:text-brand-cyan disabled:opacity-50";
    btn.title = "입장";
    btn.disabled = false;
    $("icon-room-enter").classList.remove("hidden");
    $("icon-room-exit").classList.add("hidden");
  }
}

function populateRoomSelect(rooms) {
  const sel = $("room-select");
  const prev = sel.value;
  sel.innerHTML = '<option value="">방 선택</option>';
  (rooms || []).forEach(r => {
    const modeTag = r.mode === "ptt" ? " [PTT]" : "";
    const label = `${r.name}${modeTag} (${r.participants}/${r.capacity})`;
    sel.insertAdjacentHTML("beforeend",
      `<option value="${r.room_id}">${label}</option>`);
  });
  // 이전 선택 유지
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  else if (rooms && rooms.length > 0) sel.value = rooms[0].room_id;
  log("sys", `방 목록 갱신 (${(rooms || []).length}개)`);
}

function updateGridLayout(count) {
  const grid = $("conf-grid");
  let cols;
  if (count <= 1) cols = 1;
  else if (count <= 4) cols = 2;
  else if (count <= 9) cols = 3;
  else cols = 4;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

function renderConfGrid(members) {
  const grid = $("conf-grid");
  const myId = sdk?.userId;
  updateGridLayout((members || []).length);
  grid.innerHTML = (members || []).map((uid) => {
    const initials = (uid || "?").slice(0, 2).toUpperCase();
    const isMe = uid === myId;
    return `<div class="conf-tile${isMe ? " is-me" : ""}" data-uid="${uid}">
      <video class="conf-video" autoplay playsinline ${isMe ? "muted" : ""}
        style="display:none; width:100%; height:100%; object-fit:cover; position:absolute; inset:0; border-radius:0.65rem;"></video>
      <div class="avatar">${initials}</div>
      <div class="name">${uid}${isMe ? " (나)" : ""}</div>
    </div>`;
  }).join("");

  if (localStream && myId) attachVideoToTile(myId, localStream);
}

function attachVideoToTile(userId, stream) {
  const tile = $("conf-grid")?.querySelector(`[data-uid="${userId}"]`);
  if (!tile) return;
  const video = tile.querySelector(".conf-video");
  if (!video) return;
  video.srcObject = stream;
  video.style.display = "block";
  tile.querySelector(".avatar").style.display = "none";
  tile.querySelector(".name").style.cssText =
    "position:absolute; bottom:6px; left:6px; background:rgba(0,0,0,0.6); padding:2px 8px; border-radius:4px; z-index:1;";
}

/**
 * remoteStreams Map의 모든 stream을 해당 userId 타일에 연결.
 * ontrack / room:joined / room:event 어느 쪽이 먼저 오더라도 동작.
 */
function tryAttachRemoteVideo(targetUserId) {
  if (targetUserId) {
    // 특정 user만 연결
    const stream = remoteStreams.get(targetUserId);
    if (stream) {
      const tile = $("conf-grid")?.querySelector(`[data-uid="${targetUserId}"]`);
      if (tile) {
        const video = tile.querySelector(".conf-video");
        if (video && video.srcObject !== stream) {
          attachVideoToTile(targetUserId, stream);
          log("ok", `리모트 비디오 연결 → ${targetUserId}`);
        }
      }
    }
  } else {
    // 전체 순회
    for (const [userId, stream] of remoteStreams) {
      const tile = $("conf-grid")?.querySelector(`[data-uid="${userId}"]`);
      if (!tile) continue;
      const video = tile.querySelector(".conf-video");
      if (!video || video.srcObject === stream) continue;
      attachVideoToTile(userId, stream);
      log("ok", `리모트 비디오 연결 → ${userId}`);
    }
  }
}

/** 미디어 컨트롤 전체 활성/비활성 (방 입장 시 활성, 퇴장 시 비활성) */
function setControlsEnabled(enabled) {
  const el = $("conf-controls");
  if (!el) return;
  if (enabled) {
    el.classList.remove("opacity-30", "pointer-events-none");
  } else {
    el.classList.add("opacity-30", "pointer-events-none");
  }
}

function updateMicIcon(muted) {
  $("icon-mic-on").classList.toggle("hidden", muted);
  $("icon-mic-off").classList.toggle("hidden", !muted);
}

function updateSpeakerIcon(on) {
  $("icon-speaker-on").classList.toggle("hidden", !on);
  $("icon-speaker-off").classList.toggle("hidden", on);
}

function resetUI() {
  isConnected = false;
  isInRoom = false;
  joinPhase = null;
  currentRoomMode = "conference";
  updateConnectBtn();
  updateRoomBtn();
  $("btn-room").disabled = true;
  localStream = null;
  remoteStreams.clear();
  remoteAudio.srcObject = null;
  _fullscreenUid = null;
  // GainNode 정리
  // GainNode는 SDK 내부 관리 (teardownMedia에서 정리)
  $("conf-grid").innerHTML = "";
  $("room-select").innerHTML = '<option value="">방 선택</option>';
  switchControlMode("conference");
  setControlsEnabled(false);
  updatePttView("idle", null);
  _stopTalkTimer();
  updateInputLocks();
  // 컨트롤 잠금 리셋
  if (isControlLocked) toggleControlLock();
}

/**
 * 상태별 입력 필드 잠금.
 *   연결 전:  서버 주소 + 사용자 ID + 방 선택 편집 가능
 *   연결 후:  서버 주소 + 사용자 ID 비활성 / 방 선택 가능
 *   방 입장: 서버 주소 + 사용자 ID + 방 선택 전부 비활성
 */
function updateInputLocks() {
  $("srv-url").disabled = isConnected;
  $("user-id").disabled = isConnected;
  $("room-select").disabled = isInRoom;
}

// ============================================================
//  SDK Event Binding
// ============================================================
function bindSdkEvents(s) {
  // 출력 대상 element 등록 (remoteAudio는 항상 존재)
  s.addOutputElement(remoteAudio);

  // 장치 목록 변경 이벤트 (핵플러그 등)
  s.on("device:list", ({ devices }) => updateDeviceSelects(devices));
  s.on("device:changed", ({ kind, deviceId }) => {
    log("sys", `장치 전환: ${kind} → ${deviceId?.slice(0, 12) || "default"}`);
  });
  s.on("device:disconnected", ({ kind, deviceId }) => {
    log("err", `장치 분리됨: ${kind} (${deviceId?.slice(0, 12)}) → 기본으로 복귀`);
  });
  s.on("device:error", ({ kind, msg }) => {
    log("err", `장치 오류: ${kind} — ${msg}`);
  });

  s.on("conn:state", ({ state }) => {
    updateWsBadge(state);
    if (state === CONN.IDENTIFIED) {
      isConnected = true;
      updateConnectBtn();
      updateInputLocks();
      $("btn-room").disabled = false;
      // 인증 완료 → 즉시 방 목록 조회
      s.listRooms();
      log("ok", `인증 완료: ${s.userId}`);
    }
    if (state === CONN.DISCONNECTED) {
      // Full Cold Start: 시그널링 단절 → 모든 캐시 파기 (타협 없음)
      // PeerConnection, MediaStream, DTLS/SRTP context, telemetry 전부 정리
      if (sdk && isInRoom) {
        sdk.teardownMedia();
        log("sys", "시그널링 단절 → Full Cold Start (미디어/텔레메트리/PTT 정리 완료)");
      }
      resetUI();
    }
  });

  s.on("ws:error", ({ reason }) => {
    log("err", `WS 연결 실패: ${reason}`);
  });

  s.on("ws:disconnected", ({ code, reason }) => {
    // 연결 시도 중 실패 → 모달 표시
    if (isConnecting) {
      isConnecting = false;
      const url = $("srv-url").value.trim();
      showFailModal(
        "연결 실패",
        `${url} 연결 실패${reason ? " \u2014 " + reason : ""} (code: ${code || "?"})`,
        () => { if (sdk) { sdk.disconnect(); sdk = null; } resetUI(); _doConnect(); }
      );
    }
  });

  s.on("ws:connected", () => {
    isConnecting = false;
  });

  s.on("room:list", (d) => {
    populateRoomSelect(d.rooms);
  });

  // 입장 단계별 상태 전환 (SDK join:phase 이벤트)
  s.on("join:phase", ({ phase }) => {
    if (phase === "media") {
      joinPhase = "media";
      showToast("media", "카메라/마이크 준비 중…");
    } else if (phase === "signaling") {
      joinPhase = "signaling";
      showToast("signal", "서버 입장 요청 중…");
    }
    updateRoomBtn();
  });

  s.on("room:joined", (d) => {
    // media:ice 가 room:joined 보다 먼저 fire되어 이미 connected 상태면 덮어쓰지 않음
    if (joinPhase !== "connected") {
      joinPhase = "connecting";
      showToast("ice", "미디어 연결 중…");
    }
    isInRoom = true;
    currentRoomMode = sdk?.roomMode || "conference";
    updateRoomBtn();
    updateInputLocks();
    setControlsEnabled(true); // 방 입장 즉시 활성
    switchControlMode(currentRoomMode);
    if (currentRoomMode === "ptt") {
      updatePttView("idle", null);
      // PTT 모드: ptt-controller.attach()가 초기 상태 자동 적용 (floor=IDLE → power-down 시작)
    } else {
      renderConfGrid(d.participants || []);
      // 타일 생성 후 저장된 remote stream 연결 시도
      tryAttachRemoteVideo();
      // Simulcast: 초기 레이어 분배
      redistributeTiles();
    }
    // 장치 목록 갱신 (getUserMedia 후라 label 노출됨)
    updateDeviceSelects(sdk.getDevices());
    log("ok", `방 입장: ${d.room_id} (${(d.participants || []).length}명, mode=${currentRoomMode})`);
  });

  s.on("room:left", () => {
    isInRoom = false;
    joinPhase = null;
    currentRoomMode = "conference";
    updateRoomBtn();
    updateInputLocks();
    setControlsEnabled(false);
    $("btn-room").disabled = false;
    localStream = null;
    remoteStreams.clear();
    // mute UI 리셋
    isMicMuted = false;
    updateMicIcon(false);
    $("icon-video-on").classList.remove("hidden");
    $("icon-video-off").classList.add("hidden");
    // floor/PTT UI 리셋
    switchControlMode("conference");
    updatePttView("idle", null);
    _stopTalkTimer();
    // 동적 audio element 전체 정리
    document.querySelectorAll('audio[data-uid]').forEach(el => {
      if (sdk) sdk.removeOutputElement(el);
      el.srcObject = null; el.remove();
    });
    remoteAudio.srcObject = null;
    $("conf-grid").innerHTML = "";
    // 퇴장 후 목록 갱신
    if (sdk) sdk.listRooms();
    log("sys", "방 퇴장");
  });

  s.on("room:event", (d) => {
    const type = d.type || d.event_type;
    const uid = d.user_id;
    if (type === "participant_joined") {
      log("sys", `${uid} 입장`);
      const grid = $("conf-grid");
      const existing = grid.querySelector(`[data-uid="${uid}"]`);
      if (!existing) {
        const initials = (uid || "?").slice(0, 2).toUpperCase();
        grid.insertAdjacentHTML("beforeend",
          `<div class="conf-tile" data-uid="${uid}">
            <video class="conf-video" autoplay playsinline
              style="display:none; width:100%; height:100%; object-fit:cover; position:absolute; inset:0; border-radius:0.65rem;"></video>
            <div class="avatar">${initials}</div>
            <div class="name">${uid}</div>
          </div>`);
        updateGridLayout(grid.children.length);
      }
      // 새 타일 추가 후 저장된 remote stream 연결 시도
      tryAttachRemoteVideo();
      redistributeTiles();
    }
    if (type === "participant_left") {
      log("sys", `${uid} 퇴장`);
      remoteStreams.delete(uid);
      _manualLayerOverride.delete(uid);
      // 전체 화면 대상이 퇴장하면 해제
      if (_fullscreenUid === uid) exitFullscreen();
      // audio element 정리
      const audioEl = document.querySelector(`audio[data-uid="${uid}"]`);
      if (audioEl) {
        if (sdk) sdk.removeOutputElement(audioEl);
        audioEl.srcObject = null; audioEl.remove();
      }
      const tile = $("conf-grid")?.querySelector(`[data-uid="${uid}"]`);
      if (tile) {
        tile.remove();
        updateGridLayout($("conf-grid").children.length);
      }
    }
  });

  // ── Video Suspended / Resumed (상대방 카메라 hard mute/unmute) ──
  s.on("video:suspended", ({ user_id }) => {
    const tile = $("conf-grid")?.querySelector(`[data-uid="${user_id}"]`);
    if (tile) {
      const video = tile.querySelector(".conf-video");
      if (video) video.style.display = "none";
      const avatar = tile.querySelector(".avatar");
      if (avatar) avatar.style.display = "";
    }
    log("sys", `${user_id} 비디오 중단 (avatar 전환)`);
  });

  s.on("video:resumed", ({ user_id }) => {
    tryAttachRemoteVideo(user_id);
    log("sys", `${user_id} 비디오 재개`);
  });

  // ── Media ──
  // 카메라 권한 실패 → 오디오만으로 fallback 알림
  s.on("media:fallback", ({ dropped, reason }) => {
    log("sys", `[FALLBACK] ${dropped} 사용 불가 → 오디오만 입장 (${reason})`);
    showToast("warn", `카메라 사용 불가 — 음성만 입장합니다`, 5000);
    // 비디오 버튼 비활성 표시
    $("icon-video-on").classList.add("hidden");
    $("icon-video-off").classList.remove("hidden");
  });

  // 카메라 fallback 알림 (audio-only로 진입)
  s.on("media:fallback", ({ kind, reason }) => {
    showToast("warn", `카메라 사용 불가 — 음성만으로 진입합니다`, 4000);
    log("sys", `[MEDIA] ${kind} fallback: ${reason}`);
    // 비디오 버튼 off 상태로 전환
    if (kind === "video") {
      $("icon-video-on").classList.add("hidden");
      $("icon-video-off").classList.remove("hidden");
    }
  });

  s.on("media:local", (stream) => {
    localStream = stream;
    const tracks = stream.getTracks().map(t => `${t.kind}(${t.label})`).join(", ");
    log("ok", `로컬 스트림: ${tracks}`);
    if (currentRoomMode === "ptt") {
      // PTT 모드: 내가 발화 중이면 ptt-video에 연결
      const pttVideo = $("ptt-video");
      if (pttVideo && sdk?.floorState === FLOOR.TALKING) {
        pttVideo.srcObject = stream;
        pttVideo.muted = true;
        pttVideo.classList.remove("hidden");
        $("ptt-idle-screen")?.classList.add("hidden");
      }
    } else {
      if (sdk?.userId) attachVideoToTile(sdk.userId, stream);
    }
  });

  s.on("media:track", ({ kind, stream, track }) => {
    // stream.id = 'light-U562' → userId = 'U562'
    // PTT 모드: stream.id = 'light-ptt' → 가상 스트림
    const isPttStream = stream.id === "light-ptt";
    const userId = isPttStream ? "__ptt__" : (stream.id?.startsWith("light-") ? stream.id.slice(6) : null);
    log("sys", `리모트 트랙: ${kind} readyState=${track?.readyState} stream.id='${stream.id}' user=${userId} ptt=${isPttStream} floor=${sdk?.floorState}`);
    if (kind === "audio") {
      // PTT 모드: 가상 오디오 스트림도 재생
      const audioKey = isPttStream ? "__ptt__" : userId;
      if (!audioKey) return;
      let audioEl = document.querySelector(`audio[data-uid="${audioKey}"]`);
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.dataset.uid = audioKey;
        audioEl.style.display = "none";
        audioEl.volume = parseInt($("set-output-vol").value) / 100;
        document.body.appendChild(audioEl);
        // DeviceManager에 출력 대상 등록 (setSinkId 적용)
        sdk.addOutputElement(audioEl);
      }
      audioEl.srcObject = stream;
      audioEl.play().then(() => log("ok", `[audio] play() 성공 user=${audioKey}`))
        .catch(e => log("err", `[audio] play() 실패 user=${audioKey}: ${e.name}`));
    } else if (kind === "video") {
      if (isPttStream) {
        // PTT: 가상 비디오 스트림을 "__ptt__" 키로 저장
        remoteStreams.set("__ptt__", stream);
        log("sys", `PTT 가상 비디오 스트림 저장 (stream.id=${stream.id})`);
        // track unmute 감지 — Chrome이 패킷 수신 재개 시 video 연결
        track.onunmute = () => {
          log("ok", `PTT video track unmuted (floor=${sdk?.floorState})`);
          if (sdk?.floorState === FLOOR.LISTENING) {
            const pttVideo = $("ptt-video");
            if (pttVideo) {
              if (pttVideo.srcObject !== stream) pttVideo.srcObject = stream;
              pttVideo.muted = false;
              pttVideo.classList.remove("hidden");
              $("ptt-idle-screen")?.classList.add("hidden");
              pttVideo.play().catch(() => {});
            }
          }
        };
        track.onmute = () => {
          log("sys", `PTT video track muted (floor=${sdk?.floorState})`);
        };
        // 현재 listening 상태면 즉시 연결
        if (sdk?.floorState === FLOOR.LISTENING) {
          const pttVideo = $("ptt-video");
          if (pttVideo) {
            pttVideo.srcObject = stream;
            pttVideo.muted = false;
            pttVideo.classList.remove("hidden");
            $("ptt-idle-screen")?.classList.add("hidden");
            log("ok", "PTT 가상 비디오 → ptt-video 연결");
          }
        }
      } else if (userId) {
        remoteStreams.set(userId, stream);
        log("sys", `리모트 비디오 스트림 저장 user=${userId} (stream.id=${stream.id})`);
        tryAttachRemoteVideo(userId);
      }
    }
  });

  s.on("media:ice", ({ pc, state }) => {
    log((state === "connected" || state === "completed") ? "ok" : "sys", `[ICE] ${pc} ${state}`);
    // PTT 모드: ICE connected/completed 시 마이크 버튼 숨김 적용
    if ((state === "connected" || state === "completed") && currentRoomMode === "ptt") {
      $("conf-btn-mic").classList.add("hidden");
    }
    // ICE connected/completed → 미디어 경로 확립 (컨트롤 버튼 녹색 전환)
    // publish/subscribe 구분 없이, 어느 쪽이든 먼저 맞는 PC가 트리거
    // joinPhase: setup() 중 ICE가 먼저 fire되면 "signaling" 단계일 수 있음
    if ((state === "connected" || state === "completed") && joinPhase && joinPhase !== "connected") {
      joinPhase = "connected";
      updateRoomBtn();
      showToast("ok", "미디어 연결 완료");
      log("ok", "미디어 연결 완료");
      // 마이크 GainNode 연결 + 오디오 constraints 적용
      sdk.setInputGain(parseInt($("set-input-gain").value) / 100);
      sdk.setAudioProcessing({
        noiseSuppression: $("set-ns").dataset.on === "true",
        echoCancellation: $("set-aec").dataset.on === "true",
        autoGainControl: $("set-agc").dataset.on === "true",
      });
    }
    // ICE failed → 모달
    if (pc === "publish" && state === "failed" && isInRoom) {
      joinPhase = null;
      updateRoomBtn();
      showFailModal(
        "미디어 연결 실패",
        "ICE 연결에 실패했습니다. 네트워크를 확인해주세요.",
        null
      );
    }
  });

  // connectionState 보조 로깅 (참고용)
  s.on("media:conn", ({ pc, state }) => {
    log(state === "connected" ? "ok" : "sys", `[CONN] ${pc} ${state}`);
  });

  // ── Track State (mute/unmute 브로드캐스트) ──
  s.on("track:state", (d) => {
    log("sys", `[MUTE] ${d.user_id} ${d.kind} ${d.muted ? "MUTED" : "UNMUTED"} (ssrc=${d.ssrc})`);
    // UI: 타일에 mute 표시
    const tile = $("conf-grid")?.querySelector(`[data-uid="${d.user_id}"]`);
    if (tile) {
      // video muted → 비디오 숨기고 아바타 복원
      if (d.kind === "video") {
        const video = tile.querySelector(".conf-video");
        const avatar = tile.querySelector(".avatar");
        if (d.muted) {
          if (video) video.style.display = "none";
          if (avatar) avatar.style.display = "flex";
        } else {
          if (video && video.srcObject) {
            video.style.display = "block";
            if (avatar) avatar.style.display = "none";
          }
        }
      }
      // audio muted → 이름 옆에 표시
      const nameEl = tile.querySelector(".name");
      if (nameEl && d.kind === "audio") {
        const base = d.user_id;
        nameEl.textContent = d.muted ? `${base} 🔇` : base;
      }
    }
  });

  // ── Floor Control (PTT) ──

  // floor:state — 4-state FSM 전이 이벤트 (ptt/floor-fsm.js에서 emit)
  // UI 전환의 단일 진입점
  s.on("floor:state", ({ state, prev, speaker }) => {
    log("sys", `[FLOOR] ${prev} → ${state} speaker=${speaker || "none"}`);

    // 긴급발언 동기화: TALKING/REQUESTING/QUEUED 아닌 상태로 전이 시 자동 해제
    if (pttLocked && state !== "talking" && state !== "requesting" && state !== "queued") {
      pttLocked = false;
      resetPttLockBtn();
      log("sys", "[PTT] 긴급발언 자동 해제 (floor 상태 변경)");
    }

    // PTT 묵시적 스피커 제어
    if (currentRoomMode === "ptt") {
      applyPttSpeaker(state);
    }

    updatePttView(state, speaker);
  });

  // floor:granted — 내가 발화권 획득 (서버 FLOOR_REQUEST OK 응답)
  // ※ floor:taken은 broadcast_to_others라 요청자 본인에게 안 옴!
  // ※ 미디어 on/off는 ptt/power-fsm.js가 자동 처리. app.js는 UI만.
  s.on("floor:granted", (d) => {
    log("sys", `[FLOOR] GRANTED speaker=${d.speaker}`);
    // ptt/power-fsm.js가 floor:granted → audio/video 자동 활성화
    // UI만 갱신 (media:local 이벤트로 비디오도 갱신됨)
    // localStream은 media:local 이벤트에서 이미 갱신됨 — SDK 내부 직접 접근 불필요
    const pttVideo = $("ptt-video");
    if (pttVideo && localStream) {
      pttVideo.srcObject = localStream;
      pttVideo.muted = true;
      pttVideo.classList.remove("hidden");
    }
  });

  // floor:taken — 타인이 발화 시작 (서버 브로드캐스트, 나에게만 안 옴)
  s.on("floor:taken", (d) => {
    log("sys", `[FLOOR] TAKEN speaker=${d.speaker}`);
  });

  // floor:idle — 발화 종료, 채널 비어있음
  s.on("floor:idle", () => {
    // ptt/power-fsm.js가 자동 처리
    log("sys", "[FLOOR] IDLE");
  });

  // floor:revoke — 서버 강제 회수
  s.on("floor:revoke", (d) => {
    // ptt/power-fsm.js가 자동 처리
    // pttLocked 해제는 floor:state 핸들러에서 일괄 처리
    showRevokeToast(d.cause);
    log("sys", `[FLOOR] REVOKE cause=${d.cause}`);
  });

  // floor:queued — 큐 대기
  s.on("floor:queued", (d) => {
    showToast("info", `큐 대기 #${d.position} (priority=${d.priority})`, 3000);
    log("sys", `[FLOOR] QUEUED pos=${d.position} pri=${d.priority} qsize=${d.queue_size}`);
  });

  // floor:denied — 발화권 거부
  s.on("floor:denied", (d) => {
    log("sys", `[FLOOR] DENIED code=${d.code}`);
  });

  // floor:released — 내가 PTT 뗌
  s.on("floor:released", () => {
    // ptt/power-fsm.js가 자동 처리
    log("sys", "[FLOOR] 발화권 해제");
  });

  // ── PTT Power State 변화 토스트 ──
  s.on("ptt:power", ({ state, prev }) => {
    const labels = { hot: "HOT", hot_standby: "HOT-STANDBY", warm: "WARM", cold: "COLD" };
    const icons = { hot: "ok", hot_standby: "info", warm: "warn", cold: "err" };
    showToast(icons[state] || "info", `Power: ${labels[prev] || prev} \u2192 ${labels[state] || state}`, 2000);
  });

  // ── Mute 상태 변화 토스트 (PTT COLD lock 포함) ──
  s.on("mute:changed", ({ kind, muted }) => {
    if (currentRoomMode === "ptt" && kind === "all") {
      showToast(muted ? "warn" : "ok", muted ? "PTT Mute \u2014 COLD 고정" : "PTT Unmute \u2014 HOT 복귀", 2500);
    }
  });

  s.on("message", (d) => log("sys", `메시지 [${d.user_id}]: ${d.content}`));

  s.on("error", (d) => {
    log("err", `에러 ${d.code}: ${d.msg}`);

    // 방 입장 실패 (4001=server_config 누락, 4002=2PC 실패, 4003=subscribe 실패)
    // 또는 서버 응답 에러 (op=ROOM_JOIN)
    // code 0 + "미디어 획득 실패" = getUserMedia 거부
    const isMediaError = d.code === 0 && d.msg?.includes("미디어 획득 실패");
    const isJoinError = d.code === 4001 || d.code === 4002 || d.op === 11 || isMediaError;
    if (isJoinError && (joinPhase || !isInRoom)) {
      joinPhase = null;
      updateRoomBtn();
      const roomId = $("room-select").value;
      showFailModal(
        "입장 실패",
        `방 입장에 실패했습니다: ${d.msg || "알 수 없는 오류"} (code: ${d.code || "?"})`,
        roomId ? () => { unlockAudio("retry"); joinPhase = "joining"; updateRoomBtn(); sdk.joinRoom(roomId, true); } : null
      );
    }
  });
}

// ============================================================
//  Button Events
// ============================================================

// 연결 / 해제
$("btn-connect").onclick = () => {
  if (isConnected) {
    if (sdk && isInRoom) sdk.leaveRoom();
    if (sdk) sdk.disconnect();
    sdk = null;
    log("sys", "연결 해제");
  } else {
    _doConnect();
  }
};

// Join / Leave
$("btn-room").onclick = () => {
  if (!sdk) return;
  if (isInRoom) {
    sdk.leaveRoom();
  } else {
    const roomId = $("room-select").value;
    if (!roomId) { log("err", "방을 선택하세요"); return; }
    unlockAudio("join");
    sdk.joinRoom(roomId, true);
  }
};

// 마이크 뮤트 (soft → 5초 후 hard escalation)
$("conf-btn-mic").onclick = async () => {
  if (!sdk || isControlLocked) return;
  await sdk.toggleMute("audio");
  isMicMuted = sdk.isMuted("audio");
  updateMicIcon(isMicMuted);
  log("sys", `마이크 ${isMicMuted ? "뮤트" : "활성"}`);
};

// 스피커
$("conf-btn-speaker").onclick = () => {
  if (isControlLocked) return;
  isSpeakerOn = !isSpeakerOn;
  if (currentRoomMode === "ptt") {
    // PTT: 사용자 의도 기록 후 묵시적 룰 적용
    applyPttSpeaker(sdk?.floorState || "idle");
  } else {
    // Conference: 직접 적용
    _setAllAudioMuted(!isSpeakerOn);
  }
  updateSpeakerIcon(isSpeakerOn);
  log("sys", `스피커 ${isSpeakerOn ? "ON" : "OFF"}`);
};

/** 모든 audio element 음소거 제어 */
function _setAllAudioMuted(muted) {
  remoteAudio.muted = muted;
  document.querySelectorAll('audio[data-uid]').forEach(el => { el.muted = muted; });
}

/**
 * PTT 묵시적 스피커 제어.
 * LISTENING + 사용자 ON → 즉시 on
 * IDLE/TALKING + 사용자 ON → 500ms 후 off (꼬리 보호)
 * 사용자 OFF → 즉시 off
 */
function applyPttSpeaker(state) {
  clearTimeout(_pttSpeakerTimer);
  _pttSpeakerTimer = null;

  const shouldPlay = isSpeakerOn && state === "listening";

  if (shouldPlay) {
    _setAllAudioMuted(false);
  } else if (!isSpeakerOn) {
    _setAllAudioMuted(true);
  } else {
    _pttSpeakerTimer = setTimeout(() => {
      _setAllAudioMuted(true);
      log("sys", `[PTT:SPEAKER] delayed off (${PTT_SPEAKER_OFF_DELAY}ms)`);
    }, PTT_SPEAKER_OFF_DELAY);
  }
}

// 비디오 뮤트 (soft → 5초 후 hard escalation)
$("conf-btn-video").onclick = async () => {
  if (!sdk || isControlLocked) return;
  await sdk.toggleMute("video");
  const muted = sdk.isMuted("video");
  $("icon-video-on").classList.toggle("hidden", muted);
  $("icon-video-off").classList.toggle("hidden", !muted);
  // 로컬 타일에도 반영
  if (sdk?.userId) {
    const tile = $("conf-grid")?.querySelector(`[data-uid="${sdk.userId}"]`);
    if (tile) {
      const video = tile.querySelector(".conf-video");
      const avatar = tile.querySelector(".avatar");
      if (muted) {
        if (video) video.style.display = "none";
        if (avatar) avatar.style.display = "flex";
      } else {
        if (video && video.srcObject) {
          video.style.display = "block";
          if (avatar) avatar.style.display = "none";
        }
      }
    }
  }
  log("sys", `비디오 ${muted ? "차단" : "활성"}`);
};

// 카메라 전환
$("conf-btn-camera").onclick = () => { if (sdk && !isControlLocked) sdk.switchCamera(); };

// ============================================================
//  Floor Control UI (PTT 모드) — 4-state (IDLE/REQUESTING/TALKING/LISTENING)
// ============================================================

let _talkTimerInterval = null;
let _talkStartTime = null;

/** Conference/PTT 모드에 따라 영역 전환 (하단 컨트롤은 공용) */
function switchControlMode(mode) {
  const confGrid = $("conf-grid");
  const pttView = $("ptt-view");
  const pttLockBtn = $("btn-ptt-lock");
  if (mode === "ptt") {
    confGrid.classList.add("hidden");
    pttView.classList.remove("hidden");
    // PTT 모드: 마이크만 숨김 (floor가 자동 제어), 카메라+비디오+스피커는 활성
    $("conf-btn-mic").classList.add("hidden");
    $("conf-btn-video").classList.remove("hidden");
    // 긴급발언 토글 버튼 표시
    pttLockBtn.classList.remove("hidden");
    pttLockBtn.classList.add("flex");
  } else {
    confGrid.classList.remove("hidden");
    pttView.classList.add("hidden");
    $("conf-btn-mic").classList.remove("hidden");
    $("conf-btn-video").classList.remove("hidden");
    // 긴급발언 버튼 숨김 + 상태 리셋
    pttLockBtn.classList.add("hidden");
    pttLockBtn.classList.remove("flex");
    pttLocked = false;
    resetPttLockBtn();
  }
}


/** PTT 화면 상태 전환 (4-state) */
function updatePttView(state, speaker) {
  const video = $("ptt-video");
  const idleScreen = $("ptt-idle-screen");
  const reqScreen = $("ptt-requesting-screen");
  const talkOverlay = $("ptt-talk-overlay");
  const talkBadge = $("ptt-talk-badge");

  // 공통: 모든 요소 숨김 후 해당 상태만 표시
  video.classList.add("hidden");
  idleScreen.classList.add("hidden");
  reqScreen.classList.add("hidden");
  talkOverlay.classList.add("hidden");
  _stopTalkTimer();

  switch (state) {
    case "idle":
      // PTT 모드: srcObject 유지 (idle↔listening 전환 시 Chrome 스트림 끊김 방지)
      // Conference 모드: srcObject null로 초기화
      // video element는 상단 공통 코드에서 이미 hidden 처리됨
      if (currentRoomMode !== "ptt") {
        video.srcObject = null;
      }
      idleScreen.classList.remove("hidden");
      break;

    case "requesting":
      reqScreen.classList.remove("hidden");
      // queued에서 재활용한 label 리셋
      const reqLabelReset = reqScreen.querySelector(".ptt-req-label");
      if (reqLabelReset) reqLabelReset.textContent = "REQUESTING";
      break;

    case "queued": {
      // 큐 대기 UI — requesting 화면 재활용 + position 표시
      const pos = sdk?.queuePosition || "?";
      reqScreen.classList.remove("hidden");
      const reqLabel = reqScreen.querySelector(".ptt-req-label");
      if (reqLabel) reqLabel.textContent = `대기 중... #${pos}`;
      talkBadge.textContent = `QUEUED #${pos}`;
      talkBadge.className = "px-3 py-1 rounded-full text-xs font-mono font-bold bg-yellow-600/90 text-white shadow-lg";
      talkOverlay.classList.remove("hidden");
      break;
    }

    case "talking":
      idleScreen.classList.add("hidden");
      if (localStream) {
        video.srcObject = localStream;
        video.muted = true;
        video.classList.remove("hidden");
      }
      talkBadge.textContent = "SPEAKING";
      talkBadge.className = "px-3 py-1 rounded-full text-xs font-mono font-bold bg-red-600 text-white animate-pulse shadow-lg";
      talkOverlay.classList.remove("hidden");
      _startTalkTimer();
      break;

    case "listening": {
      // PTT 모드: 가상 스트림("__ptt__") 사용, Conference: speaker별 스트림
      const remoteStream = currentRoomMode === "ptt"
        ? remoteStreams.get("__ptt__")
        : (speaker ? remoteStreams.get(speaker) : null);
      const vt = remoteStream?.getVideoTracks()?.[0];
      log("sys", `[PTT:VIEW] listening speaker=${speaker} stream=${!!remoteStream} keys=[${[...remoteStreams.keys()]}] videoTracks=${remoteStream?.getVideoTracks()?.length} active=${remoteStream?.active} trackMuted=${vt?.muted} trackEnabled=${vt?.enabled} trackState=${vt?.readyState}`);
      if (remoteStream) {
        // srcObject가 다를 때만 재할당 (Chrome 내부 상태 리셋 방지)
        if (video.srcObject !== remoteStream) {
          video.srcObject = remoteStream;
        }
        video.muted = false;
        // 잔상 방지: video track이 muted(=패킷 미수신)이면 숨김 유지
        // track.onunmute 핸들러가 새 화자 패킷 도착 시 비디오 표시
        if (vt && !vt.muted) {
          video.classList.remove("hidden");
          $("ptt-idle-screen")?.classList.add("hidden");
          video.play().catch(() => {});
        } else {
          // 새 화자 키프레임 대기 — idle 화면 유지 (이전 화자 잔상 방지)
          $("ptt-idle-screen")?.classList.remove("hidden");
          log("sys", `[PTT:VIEW] video hidden until track unmute (speaker=${speaker})`);
        }
      } else {
        // 스트림 없으면 idle 화면 유지
        $("ptt-idle-screen")?.classList.remove("hidden");
      }
      talkBadge.textContent = `Listening · ${speaker || "?"}`;
      talkBadge.className = "px-3 py-1 rounded-full text-xs font-mono font-bold bg-yellow-600/90 text-white shadow-lg";
      talkOverlay.classList.remove("hidden");
      break;
    }
  }
}

/** 발화 타이머 (서버 T2=30초 만료 예고) */
function _startTalkTimer() {
  _stopTalkTimer();
  _talkStartTime = Date.now();
  const el = $("ptt-talk-timer");
  el.classList.remove("hidden");
  _talkTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - _talkStartTime) / 1000);
    const remain = Math.max(0, 30 - elapsed);
    el.textContent = `${elapsed}s / 30s`;
    // 10초 남으면 경고색
    if (remain <= 10) {
      el.className = "text-red-400 text-xs font-mono tabular-nums font-bold";
    } else {
      el.className = "text-white/60 text-xs font-mono tabular-nums";
    }
  }, 500);
}

function _stopTalkTimer() {
  if (_talkTimerInterval) {
    clearInterval(_talkTimerInterval);
    _talkTimerInterval = null;
  }
  _talkStartTime = null;
  const el = $("ptt-talk-timer");
  if (el) { el.classList.add("hidden"); el.textContent = ""; }
}

/** Revoke 토스트 (2.5초 후 자동 숨김) */
function showRevokeToast(cause) {
  const el = $("ptt-revoke-toast");
  const text = el.querySelector("span");
  if (cause === "max burst exceeded") {
    text.textContent = "시간 초과 — 발화권이 회수되었습니다";
  } else if (cause === "preempted") {
    text.textContent = "높은 우선순위에 의해 선점되었습니다";
  } else {
    text.textContent = `발화권 회수: ${cause}`;
  }
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2500);
}


// PTT 터치 영역 (ptt-view 전체)
const pttView = $("ptt-view");
function pttDown(e) {
  e.preventDefault();
  if (!sdk || currentRoomMode !== "ptt") return;
  if (pttLocked || isControlLocked) return;
  sdk.floorRequest();
}
function pttUp(e) {
  e.preventDefault();
  if (!sdk || currentRoomMode !== "ptt") return;
  if (pttLocked || isControlLocked) return;
  sdk.floorRelease();
}
pttView.addEventListener("mousedown", pttDown);
pttView.addEventListener("mouseup", pttUp);
pttView.addEventListener("mouseleave", pttUp);
pttView.addEventListener("touchstart", pttDown, { passive: false });
pttView.addEventListener("touchend", pttUp, { passive: false });
pttView.addEventListener("touchcancel", pttUp, { passive: false });

// 긴급발언 토글 (PTT Lock — 누르지 않아도 발화 유지)
let pttLocked = false;

/** 긴급발언 버튼 UI를 비활성(OFF) 상태로 리셋 */
function resetPttLockBtn() {
  const btn = $("btn-ptt-lock");
  btn.classList.remove("bg-red-600", "border-red-600", "text-white", "animate-pulse");
  btn.classList.add("border-red-500/50", "text-red-400");
  btn.title = "긴급발언 (토글)";
}
$("btn-ptt-lock").onclick = () => {
  if (!sdk || currentRoomMode !== "ptt" || isControlLocked) return;
  const btn = $("btn-ptt-lock");
  if (!pttLocked) {
    // 잠금 ON → Floor Request
    pttLocked = true;
    sdk.floorRequest(10);  // 긴급발언: 높은 priority → preemption 가능
    btn.classList.remove("border-red-500/50", "text-red-400");
    btn.classList.add("bg-red-600", "border-red-600", "text-white", "animate-pulse");
    btn.title = "긴급발언 해제";
    log("sys", "[PTT] 긴급발언 ON (토글 잠금)");
  } else {
    // 잠금 OFF → Floor Release
    pttLocked = false;
    sdk.floorRelease();
    resetPttLockBtn();
    log("sys", "[PTT] 긴급발언 OFF");
  }
};

// ============================================================
//  Control Lock (포켓 오작동 방지 — 3초 롱프레스)
// ============================================================
const CTRL_LOCK_HOLD_MS = 1500;
let _ctrlLockTimer = null;
let _ctrlLockProgress = null;

function toggleControlLock() {
  isControlLocked = !isControlLocked;
  const btn = $("btn-ctrl-lock");
  $("icon-lock-off").classList.toggle("hidden", isControlLocked);
  $("icon-lock-on").classList.toggle("hidden", !isControlLocked);

  if (isControlLocked) {
    btn.className = "w-11 h-11 rounded-full flex items-center justify-center transition-colors bg-yellow-500/20 border border-yellow-400 text-yellow-400 relative overflow-hidden";
    btn.title = "3초 길게 눌러 잠금 해제";
  } else {
    btn.className = "w-11 h-11 rounded-full flex items-center justify-center transition-colors bg-brand-surface border border-white/10 text-gray-400 hover:bg-white/5 relative overflow-hidden";
    btn.title = "3초 길게 눌러 잠금";
  }

  // 잠금 시 다른 버튼들 시각적 비활성
  const btns = [$("conf-btn-camera"), $("conf-btn-video"), $("conf-btn-mic"), $("conf-btn-speaker"), $("btn-ptt-lock")];
  btns.forEach(b => {
    if (!b) return;
    if (isControlLocked) {
      b.style.opacity = "0.3";
      b.style.pointerEvents = "none";
    } else {
      b.style.opacity = "";
      b.style.pointerEvents = "";
    }
  });

  log("sys", `컨트롤 ${isControlLocked ? "잠금 활성" : "잠금 해제"}`);
}

function _startLockHold() {
  _cancelLockHold();
  // 프로그레스 링 표시
  const btn = $("btn-ctrl-lock");
  _ctrlLockProgress = document.createElement("div");
  _ctrlLockProgress.className = "absolute inset-0 rounded-full";
  _ctrlLockProgress.style.cssText = `
    background: conic-gradient(rgba(250,204,21,0.4) 0deg, transparent 0deg);
    transition: none; pointer-events: none;
  `;
  btn.appendChild(_ctrlLockProgress);

  // 3초 동안 프로그레스 애니메이션
  const start = Date.now();
  const frame = () => {
    const elapsed = Date.now() - start;
    const pct = Math.min(elapsed / CTRL_LOCK_HOLD_MS, 1);
    const deg = Math.round(pct * 360);
    if (_ctrlLockProgress) {
      _ctrlLockProgress.style.background = `conic-gradient(rgba(250,204,21,0.4) ${deg}deg, transparent ${deg}deg)`;
    }
    if (pct < 1 && _ctrlLockTimer !== null) {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);

  _ctrlLockTimer = setTimeout(() => {
    _cancelLockHold();
    toggleControlLock();
  }, CTRL_LOCK_HOLD_MS);
}

function _cancelLockHold() {
  if (_ctrlLockTimer !== null) {
    clearTimeout(_ctrlLockTimer);
    _ctrlLockTimer = null;
  }
  if (_ctrlLockProgress) {
    _ctrlLockProgress.remove();
    _ctrlLockProgress = null;
  }
}

const lockBtn = $("btn-ctrl-lock");
lockBtn.addEventListener("mousedown", _startLockHold);
lockBtn.addEventListener("mouseup", _cancelLockHold);
lockBtn.addEventListener("mouseleave", _cancelLockHold);
lockBtn.addEventListener("touchstart", (e) => { e.preventDefault(); _startLockHold(); }, { passive: false });
lockBtn.addEventListener("touchend", (e) => { e.preventDefault(); _cancelLockHold(); }, { passive: false });
lockBtn.addEventListener("touchcancel", _cancelLockHold);

// ============================================================
//  Connection helpers
// ============================================================
function _doConnect() {
  const url = $("srv-url").value.trim();
  const userId = $("user-id").value.trim() || undefined;
  const mediaCfg = getMediaSettings();
  sdk = new OxLensClient({ url, userId, token: "kodeholic", ...mediaCfg });
  sdk.pttPowerConfig = _readPttPowerSelects();
  bindSdkEvents(sdk);
  isConnecting = true;
  sdk.connect();
  log("sys", `서버 연결: ${url}`);
}

// ============================================================
//  Toast (우측 상단 스택 토스트)
// ============================================================
const TOAST_ICONS = {
  info:    "ph-info",
  ok:      "ph-check-circle",
  warn:    "ph-warning",
  err:     "ph-warning-circle",
  media:   "ph-microphone",
  signal:  "ph-wifi-high",
  ice:     "ph-arrows-left-right",
};
const TOAST_COLORS = {
  info:    "border-white/10 text-gray-300",
  ok:      "border-white/10 text-gray-300",
  warn:    "border-white/10 text-gray-300",
  err:     "border-white/10 text-gray-300",
  media:   "border-white/10 text-gray-300",
  signal:  "border-white/10 text-gray-300",
  ice:     "border-white/10 text-gray-300",
};

/**
 * 토스트 표시. 우측 상단에 스택되며 durationMs 후 자동 제거.
 * @param {string} type - info|ok|warn|err|media|signal|ice
 * @param {string} msg
 * @param {number} durationMs - 0이면 수동 제거
 */
function showToast(type, msg, durationMs = 3000) {
  const container = $("toast-container");
  const el = document.createElement("div");
  const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
  const color = TOAST_COLORS[type] || TOAST_COLORS.info;
  el.className = `flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-surface/95 backdrop-blur border text-xs font-mono shadow-lg toast-enter ${color}`;
  el.innerHTML = `<i class="ph ${icon} text-sm shrink-0"></i><span>${msg}</span>`;
  container.prepend(el);

  if (durationMs > 0) {
    setTimeout(() => {
      el.classList.remove("toast-enter");
      el.classList.add("toast-exit");
      el.addEventListener("animationend", () => el.remove());
    }, durationMs);
  }
  return el;
}

// ============================================================
//  Fail Modal (범용 실패 모달)
// ============================================================
let _failRetryFn = null;

function showFailModal(title, msg, retryFn) {
  $("modal-fail-title").textContent = title;
  $("modal-fail-msg").textContent = msg;
  _failRetryFn = retryFn || null;
  // 재시도 버튼: retryFn이 없으면 숨김
  $("modal-fail-retry").classList.toggle("hidden", !retryFn);
  $("modal-fail").classList.remove("hidden");
}

function hideFailModal() {
  $("modal-fail").classList.add("hidden");
  _failRetryFn = null;
}

$("modal-fail-cancel").onclick = () => {
  hideFailModal();
};

$("modal-fail-retry").onclick = () => {
  const fn = _failRetryFn;
  hideFailModal();
  if (fn) fn();
};

// ============================================================
//  Settings panel toggle
// ============================================================
$("btn-settings").onclick = () => {
  $("settings-panel").classList.toggle("hidden");
};

const MEDIA_PRESETS = {
  eco:    { width: 640,  height: 480,  frameRate: 15, maxBitrate:   300_000 },
  normal: { width: 640,  height: 480,  frameRate: 24, maxBitrate:   500_000 },
  hd:     { width: 1280, height: 720,  frameRate: 24, maxBitrate: 1_500_000 },
  "hd+":  { width: 1280, height: 720,  frameRate: 30, maxBitrate: 2_000_000 },
  fhd:    { width: 1920, height: 1080, frameRate: 30, maxBitrate: 2_500_000 },
};

function getMediaSettings() {
  const key = $("set-preset").value;
  return { ...MEDIA_PRESETS[key] || MEDIA_PRESETS.hd };
}

// ============================================================
//  Device Selection (장치 선택 UI)
// ============================================================

/** 설정 패널 드롭다운 3개를 장치 목록으로 갱신 */
function updateDeviceSelects(devices) {
  if (!devices || devices.length === 0) return;
  _fillDeviceSelect($("set-mic"), devices.filter(d => d.kind === "audioinput"));
  _fillDeviceSelect($("set-speaker"), devices.filter(d => d.kind === "audiooutput"));
  _fillDeviceSelect($("set-camera"), devices.filter(d => d.kind === "videoinput"));
}

function _fillDeviceSelect(selectEl, list) {
  if (!selectEl) return;
  const prev = selectEl.value;
  selectEl.innerHTML = '<option value="">기본 장치</option>';
  for (const d of list) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label;
    selectEl.appendChild(opt);
  }
  // 이전 선택값 복원 (장치가 아직 있으면)
  if (prev && [...selectEl.options].some(o => o.value === prev)) {
    selectEl.value = prev;
  }
}

// 장치 드롭다운 변경 핸들러
$("set-mic").onchange = async () => {
  if (!sdk) return;
  const id = $("set-mic").value;
  if (id) {
    await sdk.setAudioInput(id);
    log("sys", `마이크 전환: ${$("set-mic").selectedOptions[0]?.textContent}`);
  }
};

$("set-speaker").onchange = async () => {
  if (!sdk) return;
  const id = $("set-speaker").value;
  if (id) {
    await sdk.setAudioOutput(id);
    log("sys", `스피커 전환: ${$("set-speaker").selectedOptions[0]?.textContent}`);
  }
};

$("set-camera").onchange = async () => {
  if (!sdk) return;
  const id = $("set-camera").value;
  if (id) {
    await sdk.setVideoInput(id);
    log("sys", `카메라 전환: ${$("set-camera").selectedOptions[0]?.textContent}`);
  }
};

// ============================================================
//  오디오 설정 핸들러 (localStorage 영속화)
// ============================================================

const AUDIO_PREF_KEY = "oxlens_audio_pref";

function _loadAudioPref() {
  try {
    return JSON.parse(localStorage.getItem(AUDIO_PREF_KEY)) || {};
  } catch { return {}; }
}

function _saveAudioPref(patch) {
  const cur = _loadAudioPref();
  Object.assign(cur, patch);
  localStorage.setItem(AUDIO_PREF_KEY, JSON.stringify(cur));
}

/** 저장된 설정을 UI에 복원 */
function _restoreAudioPref() {
  const p = _loadAudioPref();
  // 수신 볼륨 (기본 100 = 시스템 통화 볼륨 패스스루)
  const outVol = p.outputVol ?? 100;
  $("set-output-vol").value = outVol;
  $("set-output-vol-label").textContent = `${outVol}%`;
  remoteAudio.volume = outVol / 100;
  // 마이크 게인 (기본 100)
  const inGain = p.inputGain ?? 100;
  $("set-input-gain").value = inGain;
  $("set-input-gain-label").textContent = `${inGain}%`;
  // 토글 (기본 전부 ON)
  _setToggleBtn("set-ns", p.ns ?? true);
  _setToggleBtn("set-aec", p.aec ?? true);
  _setToggleBtn("set-agc", p.agc ?? true);
}

// 수신 볼륨 슬라이더
$("set-output-vol").oninput = () => {
  const val = parseInt($("set-output-vol").value);
  $("set-output-vol-label").textContent = `${val}%`;
  const vol = val / 100;
  remoteAudio.volume = vol;
  document.querySelectorAll('audio[data-uid]').forEach(el => { el.volume = vol; });
  _saveAudioPref({ outputVol: val });
};

// 마이크 게인 슬라이더 (SDK 위임)
$("set-input-gain").oninput = () => {
  const val = parseInt($("set-input-gain").value);
  $("set-input-gain-label").textContent = `${val}%`;
  if (sdk) sdk.setInputGain(val / 100);
  _saveAudioPref({ inputGain: val });
};

// NS / AEC / AGC 토글 버튼
function _setToggleBtn(id, on) {
  const btn = $(id);
  btn.dataset.on = String(on);
  btn.textContent = on ? "ON" : "OFF";
  btn.className = on
    ? "px-2 py-0.5 rounded text-xs font-mono font-medium border transition-colors bg-green-500/20 text-green-400 border-green-500/30"
    : "px-2 py-0.5 rounded text-xs font-mono font-medium border transition-colors bg-brand-surface text-gray-500 border-white/10";
}

function _initToggleBtn(id, prefKey) {
  $(id).onclick = async () => {
    const next = $(id).dataset.on !== "true";
    _setToggleBtn(id, next);
    _saveAudioPref({ [prefKey]: next });
    if (sdk) sdk.setAudioProcessing({
      noiseSuppression: $("set-ns").dataset.on === "true",
      echoCancellation: $("set-aec").dataset.on === "true",
      autoGainControl: $("set-agc").dataset.on === "true",
    });
  };
}

_initToggleBtn("set-ns", "ns");
_initToggleBtn("set-aec", "aec");
_initToggleBtn("set-agc", "agc");
_restoreAudioPref();

// ============================================================
//  PTT Power State 설정 (HOT-STANDBY / WARM / COLD 진입 타이머)
// ============================================================

/** 셈렉트 값을 읽어 SDK config 객체로 변환 (localStorage 사용 안 함 — 테스트용 설정) */
function _readPttPowerSelects() {
  return {
    hotStandbyMs: (parseInt($("set-ptt-hot-standby").value) || 10) * 1000,
    warmMs: (parseInt($("set-ptt-warm").value) || 60) * 1000,
    coldMs: (parseInt($("set-ptt-cold").value) || 0) * 1000,
  };
}

$("set-ptt-hot-standby").onchange = () => {
  const cfg = _readPttPowerSelects();
  if (sdk) sdk.pttPowerConfig = cfg;
  log("sys", `PTT HOT-STANDBY: ${cfg.hotStandbyMs}ms`);
};

$("set-ptt-warm").onchange = () => {
  const cfg = _readPttPowerSelects();
  if (sdk) sdk.pttPowerConfig = cfg;
  log("sys", `PTT WARM: ${cfg.warmMs}ms`);
};

$("set-ptt-cold").onchange = () => {
  const cfg = _readPttPowerSelects();
  if (sdk) sdk.pttPowerConfig = cfg;
  log("sys", `PTT COLD: ${cfg.coldMs === 0 ? "OFF" : cfg.coldMs + "ms"}`);
};

// PTT Wake 트리거: power-fsm.js가 자체 등록 (visibilitychange / online / connection change)

// ============================================================
//  Init
// ============================================================
$("app-version").textContent = `SDK v${SDK_VERSION}`;
updateSpeakerIcon(true);
updateMicIcon(false);
updateConnectBtn();
updateRoomBtn();
$("btn-room").disabled = true;
// ID 입력란 기본값: U + 3자리 랜덤
$("user-id").value = `U${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
// location.origin 기반 WS 주소 자동 선택
(function autoSelectServer() {
  const sel = $("srv-url");
  const host = location.hostname;
  let match = "";
  if (host === "127.0.0.1" || host === "localhost") {
    match = "ws://127.0.0.1:1974/ws";
  } else if (host === "192.168.0.25") {
    match = "ws://192.168.0.25:1974/ws";
  } else if (host === "192.168.0.29") {
    match = "ws://192.168.0.29:1974/ws";
  }else if (host.includes("oxlens.com")) {
    match = "wss://www.oxlens.com/ws";
  }
  if (match) {
    for (const opt of sel.options) {
      if (opt.value === match) { sel.value = match; break; }
    }
  }
})();
log("sys", `Light LiveChat 클라이언트 준비 완료 (SDK v${SDK_VERSION})`);

// ============================================================
//  Long-press 팝업: 전체 화면 + Simulcast 레이어 선택
// ============================================================

/** 타일 레이아웃에 따른 레이어 재분배 (Phase 3 기본형) */
function redistributeTiles() {
  if (!sdk || !sdk.simulcastEnabled) return;
  const grid = $("conf-grid");
  if (!grid) return;
  const tiles = grid.querySelectorAll(".conf-tile:not(.is-me)");
  if (tiles.length === 0) return;

  const targets = [];
  tiles.forEach(tile => {
    const uid = tile.dataset.uid;
    if (!uid || _manualLayerOverride.has(uid)) return;
    targets.push({ user_id: uid, rid: "h" }); // 기본: 모든 타일 h
  });
  if (targets.length > 0) {
    sdk.subscribeLayer(targets);
  }
}

/** 전체 화면 진입 */
function enterFullscreen(uid) {
  _fullscreenUid = uid;
  const grid = $("conf-grid");
  if (!grid) return;
  grid.querySelectorAll(".conf-tile").forEach(tile => {
    if (tile.dataset.uid === uid) {
      tile.classList.remove("hidden");
    } else {
      tile.classList.add("hidden");
    }
  });
  grid.style.gridTemplateColumns = "1fr";
  log("sys", `[UI] 전체 화면: ${uid}`);
}

/** 전체 화면 해제 */
function exitFullscreen() {
  _fullscreenUid = null;
  const grid = $("conf-grid");
  if (!grid) return;
  grid.querySelectorAll(".conf-tile").forEach(tile => tile.classList.remove("hidden"));
  updateGridLayout(grid.querySelectorAll(".conf-tile").length);
  log("sys", "[UI] 전체 화면 해제");
}

/** Long-press 팝업 생성 (전체 화면 + simulcast 레이어) */
function _addPopupBtn(popup, label, cls, onClick) {
  const btn = document.createElement("button");
  btn.className = `px-4 py-2 rounded text-sm font-mono font-bold transition-colors ${cls}`;
  btn.textContent = label;
  btn.onclick = (e) => { e.stopPropagation(); onClick(); popup.remove(); };
  popup.appendChild(btn);
}

function showTilePopup(tile) {
  const uid = tile.dataset.uid;
  if (!uid) return;
  document.querySelector(".tile-popup")?.remove();

  const popup = document.createElement("div");
  popup.className = "tile-popup absolute z-50 bg-brand-surface border border-white/20 rounded-lg p-2 shadow-xl flex flex-col gap-2";
  popup.style.cssText = "top:50%;left:50%;transform:translate(-50%,-50%) scale(0);opacity:0;transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1),opacity 0.2s ease;";
  requestAnimationFrame(() => { popup.style.transform = "translate(-50%,-50%) scale(1)"; popup.style.opacity = "1"; });

  // 전체 화면 / 해제
  if (_fullscreenUid === uid) {
    _addPopupBtn(popup, "해제", "bg-gray-500/20 text-gray-300 hover:bg-gray-500/30 border border-gray-500/30", () => {
      exitFullscreen();
      log("sys", `[UI] 전체 화면 해제: ${uid}`);
    });
  } else {
    _addPopupBtn(popup, "전체 화면", "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30", () => {
      enterFullscreen(uid);
    });
  }

  // Simulcast 레이어 선택 (활성 시만)
  if (sdk?.simulcastEnabled) {
    ["h", "l", "pause"].forEach(rid => {
      const cls = rid === "h" ? "bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30"
        : rid === "l" ? "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30"
        : "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30";
      _addPopupBtn(popup, rid === "pause" ? "PAUSE" : rid.toUpperCase(), cls, () => {
        sdk.subscribeLayer([{ user_id: uid, rid }]);
        _manualLayerOverride.add(uid);
        log("sys", `[SIM] layer=${rid} for ${uid} (manual)`);
      });
    });
  }

  tile.style.position = "relative";
  tile.appendChild(popup);
  // 4초 후 서서히 사라지며 제거
  setTimeout(() => {
    popup.style.transform = "translate(-50%,-50%) scale(0)";
    popup.style.opacity = "0";
    popup.addEventListener("transitionend", () => popup.remove(), { once: true });
    // transitionend 미발화 방어
    setTimeout(() => popup.remove(), 300);
  }, 4000);
}

// conf-grid long-press 이벤트 위임
// pointerdown → 브라우저 드래그 시작 방지 (video element의 draggable 기본값 때문에 pointercancel 발생)
$("conf-grid").addEventListener("pointerdown", (e) => {
  const tile = e.target.closest(".conf-tile");
  if (!tile || tile.classList.contains("is-me")) return;
  if (!sdk) return;
  e.preventDefault();
  clearTimeout(_longPressTimer);
  _longPressTimer = setTimeout(() => showTilePopup(tile), 800);
});
$("conf-grid").addEventListener("pointerup", () => clearTimeout(_longPressTimer));
$("conf-grid").addEventListener("pointercancel", () => clearTimeout(_longPressTimer));
$("conf-grid").addEventListener("pointermove", () => clearTimeout(_longPressTimer));
$("conf-grid").addEventListener("contextmenu", (e) => {
  if (sdk) e.preventDefault();
});

// ============================================================
//  PWA Service Worker 등록
// ============================================================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
