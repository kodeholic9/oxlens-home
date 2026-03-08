// author: kodeholic (powered by Claude)
// livechat-client/app.js — Light LiveChat 클라이언트 UI
// SDK 이벤트 구독으로만 동작 — 비즈니스 로직 Zero

import { LiveChatSDK, CONN, FLOOR, SDK_VERSION } from "../common/livechat-sdk.js";

// ============================================================
//  DOM
// ============================================================
const $ = (id) => document.getElementById(id);

// ============================================================
//  State (UI only)
// ============================================================
let sdk = null;
let isSpeakerOn  = true;
let isMicMuted   = false;
let isConnected  = false;
let isInRoom     = false;
let currentRoomMode = "conference";
let localStream  = null;
// userId → MediaStream (subscribe PC ontrack에서 stream.id='light-{userId}' 기준 매핑)
const remoteStreams = new Map();

const remoteAudio = $("remote-audio");

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
    [CONN.DISCONNECTED]: ["DISCONNECTED", "bg-titanium-700 text-titanium-400 border border-titanium-600"],
    [CONN.CONNECTING]:   ["CONNECTING",   "bg-yellow-600 text-white"],
    [CONN.CONNECTED]:    ["CONNECTED",    "bg-blue-600 text-white"],
    [CONN.IDENTIFIED]:   ["READY",        "bg-green-500 text-white"],
  };
  const [text, cls] = map[state] || ["UNKNOWN", "bg-titanium-700 text-titanium-400"];
  el.textContent = text;
  el.className = `px-2 py-0.5 rounded text-xs font-medium ${cls}`;
}

function updateConnectBtn() {
  const btn = $("btn-connect");
  if (isConnected) {
    btn.classList.remove("text-titanium-400", "bg-titanium-700");
    btn.classList.add("text-green-400", "bg-titanium-700");
    btn.title = "해제";
  } else {
    btn.classList.remove("text-green-400");
    btn.classList.add("text-titanium-400", "bg-titanium-700");
    btn.title = "연결";
  }
}

function updateRoomBtn() {
  const btn = $("btn-room");
  if (isInRoom) {
    btn.classList.remove("text-titanium-400");
    btn.classList.add("text-green-400");
    btn.title = "퇴장";
    $("icon-room-enter").classList.add("hidden");
    $("icon-room-exit").classList.remove("hidden");
  } else {
    btn.classList.remove("text-green-400");
    btn.classList.add("text-titanium-400");
    btn.title = "입장";
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
  currentRoomMode = "conference";
  updateConnectBtn();
  updateRoomBtn();
  $("btn-room").disabled = true;
  localStream = null;
  remoteStreams.clear();
  remoteAudio.srcObject = null;
  $("conf-grid").innerHTML = "";
  $("room-select").innerHTML = '<option value="">방 선택</option>';
  switchControlMode("conference");
  setControlsEnabled(false);
  updatePttView("idle", null);
  _stopTalkTimer();
}

// ============================================================
//  SDK Event Binding
// ============================================================
function bindSdkEvents(s) {
  s.on("conn:state", ({ state }) => {
    updateWsBadge(state);
    if (state === CONN.IDENTIFIED) {
      isConnected = true;
      updateConnectBtn();
      $("btn-room").disabled = false;
      // 인증 완료 → 즉시 방 목록 조회
      s.listRooms();
      log("ok", `인증 완료: ${s.userId}`);
    }
    if (state === CONN.DISCONNECTED) resetUI();
  });

  s.on("ws:error", ({ reason }) => log("err", `WS 연결 실패: ${reason}`));

  s.on("room:list", (d) => {
    populateRoomSelect(d.rooms);
  });

  s.on("room:joined", (d) => {
    isInRoom = true;
    currentRoomMode = sdk?.roomMode || "conference";
    $("btn-room").disabled = false;
    updateRoomBtn();
    setControlsEnabled(true); // 방 입장 즉시 활성
    switchControlMode(currentRoomMode);
    if (currentRoomMode === "ptt") {
      updatePttView("idle", null);
      // PTT 모드: SDK가 _applyPttMediaState()로 초기 상태 자동 적용 (floor=IDLE → 전부 off)
    } else {
      renderConfGrid(d.participants || []);
      // 타일 생성 후 저장된 remote stream 연결 시도
      tryAttachRemoteVideo();
    }
    log("ok", `방 입장: ${d.room_id} (${(d.participants || []).length}명, mode=${currentRoomMode})`);
  });

  s.on("room:left", () => {
    isInRoom = false;
    currentRoomMode = "conference";
    updateRoomBtn();
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
    document.querySelectorAll('audio[data-uid]').forEach(el => { el.srcObject = null; el.remove(); });
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
    }
    if (type === "participant_left") {
      log("sys", `${uid} 퇴장`);
      remoteStreams.delete(uid);
      // audio element 정리
      const audioEl = document.querySelector(`audio[data-uid="${uid}"]`);
      if (audioEl) { audioEl.srcObject = null; audioEl.remove(); }
      const tile = $("conf-grid")?.querySelector(`[data-uid="${uid}"]`);
      if (tile) {
        tile.remove();
        updateGridLayout($("conf-grid").children.length);
      }
    }
  });

  // ── Media ──
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
        document.body.appendChild(audioEl);
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
    log(state === "connected" ? "ok" : "sys", `[ICE] ${pc} ${state}`);
    // PTT 모드: publish connected 시 마이크 버튼 숨김 적용
    if (pc === "publish" && state === "connected" && currentRoomMode === "ptt") {
      $("conf-btn-mic").classList.add("hidden");
    }
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

  // floor:state — 4-state FSM 전이 이벤트 (signaling.js에서 emit)
  // UI 전환의 단일 진입점
  s.on("floor:state", ({ state, prev, speaker }) => {
    log("sys", `[FLOOR] ${prev} → ${state} speaker=${speaker || "none"}`);

    // 긴급발언 동기화: TALKING/REQUESTING 아닌 상태로 전이 시 자동 해제
    if (pttLocked && state !== "talking" && state !== "requesting") {
      pttLocked = false;
      resetPttLockBtn();
      log("sys", "[PTT] 긴급발언 자동 해제 (floor 상태 변경)");
    }

    updatePttView(state, speaker);
  });

  // floor:granted — 내가 발화권 획득 (서버 FLOOR_REQUEST OK 응답)
  // ※ floor:taken은 broadcast_to_others라 요청자 본인에게 안 옴!
  // ※ 미디어 on/off는 SDK _applyPttMediaState()가 자동 처리. app.js는 UI만.
  s.on("floor:granted", (d) => {
    log("sys", `[FLOOR] GRANTED speaker=${d.speaker}`);
    // SDK가 _applyPttMediaState()로 audio/video 자동 활성화
    // UI만 갱신 (media:local 이벤트로 비디오도 갱신됨)
    localStream = sdk?.media?.stream;
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
    // SDK가 _applyPttMediaState()로 자동 처리
    log("sys", "[FLOOR] IDLE");
  });

  // floor:revoke — 서버 강제 회수
  s.on("floor:revoke", (d) => {
    // SDK가 _applyPttMediaState()로 자동 처리
    // pttLocked 해제는 floor:state 핸들러에서 일괄 처리
    showRevokeToast(d.cause);
    log("sys", `[FLOOR] REVOKE cause=${d.cause}`);
  });

  // floor:denied — 발화권 거부
  s.on("floor:denied", (d) => {
    log("sys", `[FLOOR] DENIED code=${d.code}`);
  });

  // floor:released — 내가 PTT 뗌
  s.on("floor:released", () => {
    // SDK가 _applyPttMediaState()로 자동 처리
    log("sys", "[FLOOR] 발화권 해제");
  });

  s.on("message", (d) => log("sys", `메시지 [${d.user_id}]: ${d.content}`));
  s.on("error", (d) => log("err", `에러 ${d.code}: ${d.msg}`));
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
    const url = $("srv-url").value.trim();
    const userId = $("user-id").value.trim() || undefined;
    const mediaCfg = getMediaSettings();
    sdk = new LiveChatSDK({ url, userId, token: "kodeholic", ...mediaCfg });
    bindSdkEvents(sdk);
    sdk.connect();
    log("sys", `서버 연결: ${url}`);
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
    $("btn-room").disabled = true;
    sdk.joinRoom(roomId, true);
  }
};

// 마이크 뮤트 (soft → 5초 후 hard escalation)
$("conf-btn-mic").onclick = async () => {
  if (!sdk) return;
  await sdk.toggleMute("audio");
  isMicMuted = sdk.isMuted("audio");
  updateMicIcon(isMicMuted);
  log("sys", `마이크 ${isMicMuted ? "뮤트" : "활성"}`);
};

// 스피커
$("conf-btn-speaker").onclick = () => {
  isSpeakerOn = !isSpeakerOn;
  remoteAudio.muted = !isSpeakerOn;
  // 개별 audio element도 반영
  document.querySelectorAll('audio[data-uid]').forEach(el => { el.muted = !isSpeakerOn; });
  updateSpeakerIcon(isSpeakerOn);
  log("sys", `스피커 ${isSpeakerOn ? "ON" : "OFF"}`);
};

// 비디오 뮤트 (soft → 5초 후 hard escalation)
$("conf-btn-video").onclick = async () => {
  if (!sdk) return;
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
$("conf-btn-camera").onclick = () => { if (sdk) sdk.switchCamera(); };

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
      // PTT 모드: srcObject를 null로 밀지 않음 (idle↔listening 전환 시 Chrome 스트림 끊김 방지)
      // Conference 모드: srcObject null로 초기화
      if (currentRoomMode !== "ptt") {
        video.srcObject = null;
      }
      idleScreen.classList.remove("hidden");
      break;

    case "requesting":
      reqScreen.classList.remove("hidden");
      break;

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
        video.classList.remove("hidden");
        $("ptt-idle-screen")?.classList.add("hidden");
        // Chrome이 hidden 상태에서 일시정지한 경우 강제 재생
        video.play().catch(() => {});
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
  if (pttLocked) return; // 긴급발언 중이면 터치 무시
  sdk.floorRequest();
}
function pttUp(e) {
  e.preventDefault();
  if (!sdk || currentRoomMode !== "ptt") return;
  if (pttLocked) return; // 긴급발언 중이면 터치 무시
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
  if (!sdk || currentRoomMode !== "ptt") return;
  const btn = $("btn-ptt-lock");
  if (!pttLocked) {
    // 잠금 ON → Floor Request
    pttLocked = true;
    sdk.floorRequest();
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
//  Settings panel toggle
// ============================================================
$("btn-settings").onclick = () => {
  $("settings-panel").classList.toggle("hidden");
};

function getMediaSettings() {
  const [w, h] = $("set-resolution").value.split("x").map(Number);
  return {
    width: w,
    height: h,
    frameRate: Number($("set-fps").value),
    maxBitrate: Number($("set-bitrate").value),
  };
}

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
  } else if (host === "192.168.0.29") {
    match = "ws://192.168.0.29:1974/ws";
  } else if (host.includes("oxlens.com")) {
    match = "wss://www.oxlens.com/ws";
  }
  if (match) {
    for (const opt of sel.options) {
      if (opt.value === match) { sel.value = match; break; }
    }
  }
})();
log("sys", `Light LiveChat 클라이언트 준비 완료 (SDK v${SDK_VERSION})`);
