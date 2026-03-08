/**
 * sdp-builder.js — light-livechat SDP Builder
 *
 * 서버 정책 JSON → fake remote SDP 조립.
 * 서버는 SDP를 모른다. 클라이언트가 이 모듈로 SDP를 만들어
 * setRemoteDescription → createAnswer → setLocalDescription 한다.
 *
 * @author kodeholic (powered by Claude)
 *
 * 사용법:
 *   import { buildPublishRemoteSdp, buildSubscribeRemoteSdp } from './sdp-builder.js';
 *
 *   // publish PC: 서버가 recvonly (내 미디어를 받아감)
 *   const pubSdp = buildPublishRemoteSdp(serverConfig);
 *   await pubPc.setRemoteDescription({ type: 'offer', sdp: pubSdp });
 *   const pubAnswer = await pubPc.createAnswer();
 *   await pubPc.setLocalDescription(pubAnswer);
 *
 *   // subscribe PC: 서버가 sendonly × N (다른 참가자 미디어를 보내줌)
 *   const subSdp = buildSubscribeRemoteSdp(serverConfig, tracks);
 *   await subPc.setRemoteDescription({ type: 'offer', sdp: subSdp });
 *   const subAnswer = await subPc.createAnswer();
 *   await subPc.setLocalDescription(subAnswer);
 */

// ============================================================================
// Public API
// ============================================================================

/**
 * publish PC용 remote SDP 생성 (서버 = recvonly offer)
 *
 * 브라우저는 이 offer에 대해 sendonly answer를 만든다.
 * m-line: audio 1개 + video 1개 (고정)
 *
 * @param {Object} serverConfig - ROOM_JOIN 응답의 server_config
 * @returns {string} SDP offer 문자열
 */
export function buildPublishRemoteSdp(serverConfig) {
  const { ice, dtls, codecs, extmap } = serverConfig;

  const audioCodecs = codecs.filter((c) => c.kind === "audio");
  const videoCodecs = codecs.filter((c) => c.kind === "video");

  const sections = [];
  let midCounter = 0;

  // audio m-line
  if (audioCodecs.length > 0) {
    sections.push(
      buildMediaSection({
        mid: String(midCounter++),
        kind: "audio",
        codecs: audioCodecs,
        extmap,
        direction: "recvonly",
        ice: { ufrag: ice.publish_ufrag, pwd: ice.publish_pwd },
        dtls,
        ip: ice.ip,
        port: ice.port,
        ssrc: null, // recvonly — 서버가 SSRC 없음
      }),
    );
  }

  // video m-line
  if (videoCodecs.length > 0) {
    sections.push(
      buildMediaSection({
        mid: String(midCounter++),
        kind: "video",
        codecs: videoCodecs,
        extmap,
        direction: "recvonly",
        ice: { ufrag: ice.publish_ufrag, pwd: ice.publish_pwd },
        dtls,
        ip: ice.ip,
        port: ice.port,
        ssrc: null,
      }),
    );
  }

  // BUNDLE 그룹에는 active(sendonly) m-line만 포함
  // inactive(port=0) m-line은 BUNDLE에서 제외해야 Chrome re-nego 통과
  const bundleMids = sections
    .filter((s) => s.active !== false)
    .map((s) => s.mid);
  // BUNDLE이 비어있으면 첫 번째 mid라도 넣어야 SDP 유효
  const finalBundleMids = bundleMids.length > 0 ? bundleMids : [sections[0]?.mid || "0"];
  return buildSessionHeader(finalBundleMids) + sections.map((s) => s.sdp).join("");
}

/**
 * subscribe PC용 remote SDP 생성 (서버 = sendonly offer × N)
 *
 * 브라우저는 이 offer에 대해 recvonly answer를 만든다.
 * 트랙이 없으면 빈 SDP (audio 1개 inactive).
 *
 * @param {Object} serverConfig - ROOM_JOIN 응답의 server_config
 * @param {Array} tracks - 수신할 트랙 목록
 *   [{ user_id, kind, ssrc, track_id, active? }]
 * @param {Object} [options] - 추가 옵션
 * @param {string} [options.mode] - 방 모드 ('conference' | 'ptt')
 * @param {Object} [options.pttVirtualSsrc] - PTT 가상 SSRC { audio, video }
 * @returns {string} SDP offer 문자열
 */
export function buildSubscribeRemoteSdp(serverConfig, tracks, options) {
  const { ice, dtls, codecs, extmap } = serverConfig;

  // Phase E-5: PTT 모드 — 가상 SSRC로 단일 스트림 subscribe SDP 조립
  // PTT는 트랙 유무와 무관하게 항상 가상 SSRC를 선언해야 한다.
  // (Floor 활성 전에도 subscribe PC가 준비되어 있어야 re-nego 없이 수신 가능)
  const mode = options?.mode || 'conference';
  if (mode === 'ptt' && options?.pttVirtualSsrc) {
    return buildPttSubscribeSdp(serverConfig, options.pttVirtualSsrc, tracks);
  }

  // Conference 모드: 트랙이 없으면 최소 SDP (BUNDLE 필수이므로 inactive audio 1개)
  if (!tracks || tracks.length === 0) {
    const audioCodecs = codecs.filter((c) => c.kind === "audio");
    const section = buildMediaSection({
      mid: "0",
      kind: "audio",
      codecs: audioCodecs,
      extmap,
      direction: "inactive",
      ice: { ufrag: ice.subscribe_ufrag, pwd: ice.subscribe_pwd },
      dtls,
      ip: ice.ip,
      port: ice.port,
      ssrc: null,
    });
    return buildSessionHeader(["0"]) + section.sdp;
  }

  const sections = [];

  for (const track of tracks) {
    const active = track.active !== false; // default true
    const kind = track.kind || "audio";
    const trackCodecs = codecs.filter((c) => c.kind === kind);

    if (trackCodecs.length === 0) continue;

    // mid: 트랙에 고정 할당된 mid 사용 (re-nego 시 불변 보장)
    const mid = track.mid != null ? String(track.mid) : String(sections.length);

    // subscribe SDP에서는 sdes:mid extmap 제거
    // → 서버가 RTP mid 헤더 확장을 rewrite 안 하므로,
    //   BUNDLE demux를 SSRC 기반으로 fallback시킴
    const subExtmap = (extmap || []).filter(
      (e) => e.uri !== "urn:ietf:params:rtp-hdrext:sdes:mid"
    );

    sections.push(
      buildMediaSection({
        mid,
        kind,
        codecs: trackCodecs,
        extmap: subExtmap,
        direction: active ? "sendonly" : "inactive",
        ice: { ufrag: ice.subscribe_ufrag, pwd: ice.subscribe_pwd },
        dtls,
        ip: ice.ip,
        port: ice.port,
        ssrc: active ? track.ssrc : null,
        rtx_ssrc: (active && kind === "video") ? (track.rtx_ssrc || null) : null,
        msid: active ? `light-${track.user_id} ${track.track_id}` : null,
      }),
    );
  }

  // BUNDLE 그룹에는 active m-line만 포함
  // inactive(port=0)는 BUNDLE에서 제외해야 Chrome re-nego 통과
  const bundleMids = sections
    .filter((s) => s.active !== false)
    .map((s) => s.mid);
  const finalBundleMids = bundleMids.length > 0 ? bundleMids : [sections[0]?.mid || "0"];
  return buildSessionHeader(finalBundleMids) + sections.map((s) => s.sdp).join("");
}

// ============================================================================
// PTT Subscribe SDP Builder
// ============================================================================

/**
 * PTT 모드 subscribe SDP 생성 — 가상 SSRC 1쌍(audio+video)으로 2개 m-line
 *
 * Conference 모드와 구조적으로 다르다:
 * - Conference: publisher N명 × 2 m-line (audio + video each)
 * - PTT: 가상 audio 1개 + 가상 video 1개 = 2 m-line only
 *
 * 서버가 화자 교대 시 SSRC/seq/ts를 리라이팅하므로,
 * Chrome은 하나의 연속 스트림으로 인식한다.
 *
 * @param {Object} serverConfig - server_config
 * @param {Object} pttVirtualSsrc - { audio: number, video: number }
 * @param {Array} tracks - 현재 존재하는 트랙 목록 (활성 여부 판단용)
 * @returns {string} SDP offer 문자열
 */
function buildPttSubscribeSdp(serverConfig, pttVirtualSsrc, tracks) {
  const { ice, dtls, codecs, extmap } = serverConfig;

  const audioCodecs = codecs.filter((c) => c.kind === 'audio');
  const videoCodecs = codecs.filter((c) => c.kind === 'video');

  // subscribe SDP에서는 sdes:mid extmap 제거 (SSRC 기반 demux)
  const subExtmap = (extmap || []).filter(
    (e) => e.uri !== 'urn:ietf:params:rtp-hdrext:sdes:mid'
  );

  // PTT는 트랙 유무와 무관하게 항상 가상 SSRC를 선언한다.
  // 누군가 Floor를 잡으면 re-nego 없이 바로 가상 SSRC로 패킷이 오기 때문.
  const sections = [];

  // PTT audio m-line (mid=0): 가상 audio SSRC
  if (audioCodecs.length > 0) {
    sections.push(
      buildMediaSection({
        mid: '0',
        kind: 'audio',
        codecs: audioCodecs,
        extmap: subExtmap,
        direction: 'sendonly',
        ice: { ufrag: ice.subscribe_ufrag, pwd: ice.subscribe_pwd },
        dtls,
        ip: ice.ip,
        port: ice.port,
        ssrc: pttVirtualSsrc.audio,
        msid: 'light-ptt ptt-audio',
      }),
    );
  }

  // PTT video m-line (mid=1): 가상 video SSRC
  if (videoCodecs.length > 0) {
    sections.push(
      buildMediaSection({
        mid: '1',
        kind: 'video',
        codecs: videoCodecs,
        extmap: subExtmap,
        direction: 'sendonly',
        ice: { ufrag: ice.subscribe_ufrag, pwd: ice.subscribe_pwd },
        dtls,
        ip: ice.ip,
        port: ice.port,
        ssrc: pttVirtualSsrc.video,
        // PTT에서 RTX는 원본 publisher의 rtx_ssrc를 사용 (서버가 원본 SSRC로 RTX 전송)
        // 가상 RTX SSRC는 현재 미지원 — 필요 시 확장
        rtx_ssrc: null,
        msid: 'light-ptt ptt-video',
      }),
    );
  }

  const bundleMids = sections
    .filter((s) => s.active !== false)
    .map((s) => s.mid);
  const finalBundleMids = bundleMids.length > 0 ? bundleMids : [sections[0]?.mid || '0'];
  return buildSessionHeader(finalBundleMids) + sections.map((s) => s.sdp).join('');
}

/**
 * subscribe PC re-negotiation용 SDP 재조립
 *
 * 전체 트랙 목록을 받아 SDP를 처음부터 조립한다.
 * 제거된 트랙은 active: false로 넘기면 inactive m-line이 된다.
 *
 * SDP에서 m-line은 삭제 불가 → inactive로 변경만 가능.
 * 새 참가자가 들어오면 inactive mid를 재활용한다.
 *
 * @param {Object} serverConfig
 * @param {Array} allTracks - 전체 트랙 (active/inactive 포함)
 * @returns {string} SDP offer 문자열
 */
export function updateSubscribeRemoteSdp(serverConfig, allTracks, options) {
  // 재조립 = buildSubscribeRemoteSdp와 동일
  // allTracks에 active: false인 항목이 있으면 inactive m-line
  return buildSubscribeRemoteSdp(serverConfig, allTracks, options);
}

// ============================================================================
// Internal: Session Header
// ============================================================================

function buildSessionHeader(mids) {
  const sessionId = Date.now();
  return (
    "v=0\r\n" +
    `o=light-sfu ${sessionId} ${sessionId} IN IP4 0.0.0.0\r\n` +
    "s=-\r\n" +
    "t=0 0\r\n" +
    `a=group:BUNDLE ${mids.join(" ")}\r\n` +
    "a=ice-lite\r\n"
  );
}

// ============================================================================
// Internal: Media Section Builder
// ============================================================================

/**
 * 단일 m= 섹션 생성
 *
 * @param {Object} opts
 * @param {string} opts.mid
 * @param {string} opts.kind - 'audio' | 'video'
 * @param {Array}  opts.codecs - 이 kind에 해당하는 코덱 목록
 * @param {Array}  opts.extmap - extmap 목록
 * @param {string} opts.direction - 'sendonly' | 'recvonly' | 'inactive'
 * @param {Object} opts.ice - { ufrag, pwd }
 * @param {Object} opts.dtls - { fingerprint, setup }
 * @param {string} opts.ip
 * @param {number} opts.port
 * @param {number|null} opts.ssrc
 * @param {string|null} opts.msid
 * @returns {{ mid: string, sdp: string }}
 */
function buildMediaSection(opts) {
  const {
    mid,
    kind,
    codecs,
    extmap,
    direction,
    ice,
    dtls,
    ip,
    port,
    ssrc,
    msid,
  } = opts;

  // PT 목록 수집 (rtx_pt 포함)
  const pts = [];
  for (const c of codecs) {
    pts.push(c.pt);
    if (c.rtx_pt != null) {
      pts.push(c.rtx_pt);
    }
  }

  // inactive면 port=0
  const mPort = direction === "inactive" ? 0 : port;

  let sdp = "";

  // m= line
  sdp += `m=${kind} ${mPort} UDP/TLS/RTP/SAVPF ${pts.join(" ")}\r\n`;

  // connection
  sdp += `c=IN IP4 ${ip}\r\n`;

  // ICE
  sdp += `a=ice-ufrag:${ice.ufrag}\r\n`;
  sdp += `a=ice-pwd:${ice.pwd}\r\n`;

  // DTLS
  sdp += `a=fingerprint:${dtls.fingerprint}\r\n`;
  sdp += `a=setup:${dtls.setup}\r\n`;

  // mid
  sdp += `a=mid:${mid}\r\n`;

  // rtcp-mux (BUNDLE 필수)
  sdp += "a=rtcp-mux\r\n";

  // rtcp-rsize (video에만)
  if (kind === "video") {
    sdp += "a=rtcp-rsize\r\n";
  }

  // direction
  sdp += `a=${direction}\r\n`;

  // codecs: rtpmap + fmtp + rtcp-fb
  for (const c of codecs) {
    // rtpmap
    if (kind === "audio" && c.channels && c.channels > 1) {
      sdp += `a=rtpmap:${c.pt} ${c.name}/${c.clockrate}/${c.channels}\r\n`;
    } else {
      sdp += `a=rtpmap:${c.pt} ${c.name}/${c.clockrate}\r\n`;
    }

    // fmtp
    if (c.fmtp) {
      sdp += `a=fmtp:${c.pt} ${c.fmtp}\r\n`;
    }

    // rtcp-fb
    if (c.rtcp_fb) {
      for (const fb of c.rtcp_fb) {
        sdp += `a=rtcp-fb:${c.pt} ${fb}\r\n`;
      }
    }

    // RTX codec
    if (c.rtx_pt != null) {
      sdp += `a=rtpmap:${c.rtx_pt} rtx/${c.clockrate}\r\n`;
      sdp += `a=fmtp:${c.rtx_pt} apt=${c.pt}\r\n`;
    }
  }

  // extmap
  if (extmap) {
    for (const ext of extmap) {
      sdp += `a=extmap:${ext.id} ${ext.uri}\r\n`;
    }
  }

  // SSRC + msid (sendonly일 때만)
  if (ssrc != null) {
    if (msid) {
      sdp += `a=ssrc:${ssrc} cname:light-sfu\r\n`;
      sdp += `a=ssrc:${ssrc} msid:${msid}\r\n`;
    } else {
      sdp += `a=ssrc:${ssrc} cname:light-sfu\r\n`;
    }

    // RTX SSRC (video only, RFC 4588)
    if (opts.rtx_ssrc != null && kind === "video") {
      sdp += `a=ssrc:${opts.rtx_ssrc} cname:light-sfu\r\n`;
      if (msid) {
        sdp += `a=ssrc:${opts.rtx_ssrc} msid:${msid}\r\n`;
      }
      sdp += `a=ssrc-group:FID ${ssrc} ${opts.rtx_ssrc}\r\n`;
    }
  }

  // ICE candidate (inactive가 아닐 때만)
  if (direction !== "inactive") {
    sdp += `a=candidate:1 1 udp 2113937151 ${ip} ${port} typ host generation 0\r\n`;
    sdp += "a=end-of-candidates\r\n";
  }

  return { mid, sdp, active: direction !== "inactive" };
}

// ============================================================================
// Utility: SDP 검증 (디버깅용)
// ============================================================================

/**
 * 생성된 SDP의 기본 구조를 검증한다.
 * 프로덕션이 아닌 디버깅/테스트용.
 *
 * @param {string} sdp
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSdp(sdp) {
  const errors = [];

  if (!sdp.startsWith("v=0\r\n")) {
    errors.push("missing v=0 header");
  }

  if (!sdp.includes("a=group:BUNDLE")) {
    errors.push("missing BUNDLE group");
  }

  if (!sdp.includes("a=ice-lite")) {
    errors.push("missing ice-lite");
  }

  // m= 라인 개수 확인
  const mLines = sdp.match(/^m=/gm);
  if (!mLines || mLines.length === 0) {
    errors.push("no m= lines");
  }

  // BUNDLE mids와 a=mid 일치 확인
  const bundleMatch = sdp.match(/a=group:BUNDLE (.+)/);
  if (bundleMatch) {
    const bundleMids = bundleMatch[1].trim().split(/\s+/);
    const midMatches = sdp.match(/a=mid:(\S+)/g) || [];
    const actualMids = midMatches.map((m) => m.replace("a=mid:", ""));

    // BUNDLE에는 active mid만 포함, inactive(port=0)는 제외 → 수 불일치 정상
    // BUNDLE에 있는 mid가 실제 m-line에 존재하는지만 검증
    // (bundleMids.length < actualMids.length는 정상)

    for (const mid of bundleMids) {
      if (!actualMids.includes(mid)) {
        errors.push(`BUNDLE references mid=${mid} but not found in sections`);
      }
    }
  }

  // 각 m= 섹션에 ice-ufrag 존재 확인
  const sections = sdp.split(/(?=^m=)/m).filter((s) => s.startsWith("m="));
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (!sec.includes("a=ice-ufrag:")) {
      errors.push(`section ${i}: missing ice-ufrag`);
    }
    if (!sec.includes("a=ice-pwd:")) {
      errors.push(`section ${i}: missing ice-pwd`);
    }
    if (!sec.includes("a=fingerprint:")) {
      errors.push(`section ${i}: missing fingerprint`);
    }
    if (!sec.includes("a=mid:")) {
      errors.push(`section ${i}: missing mid`);
    }

    // direction 확인
    const hasDirection = [
      "a=sendonly",
      "a=recvonly",
      "a=sendrecv",
      "a=inactive",
    ].some((d) => sec.includes(d));
    if (!hasDirection) {
      errors.push(`section ${i}: missing direction`);
    }
  }

  return { valid: errors.length === 0, errors };
}
