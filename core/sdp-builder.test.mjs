/**
 * sdp-builder.test.js — SdpBuilder 유닛테스트
 *
 * Node.js에서 직접 실행:
 *   node core/sdp-builder.test.mjs
 *
 * @author kodeholic (powered by Claude)
 */

import {
  buildPublishRemoteSdp,
  buildSubscribeRemoteSdp,
  updateSubscribeRemoteSdp,
  validateSdp,
} from "./sdp-builder.js";

// ============================================================================
// Test fixture: server_config (서버 ROOM_JOIN 응답과 동일 구조)
// ============================================================================

const serverConfig = {
  ice: {
    publish_ufrag: "svr_pub_a3x9",
    publish_pwd: "svr_pub_pwd_longenough22ch",
    subscribe_ufrag: "svr_sub_kq7m",
    subscribe_pwd: "svr_sub_pwd_longenough22ch",
    ip: "192.168.1.100",
    port: 19740,
  },
  dtls: {
    fingerprint:
      "sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    setup: "passive",
  },
  codecs: [
    {
      kind: "audio",
      name: "opus",
      pt: 111,
      clockrate: 48000,
      channels: 2,
      rtcp_fb: ["nack"],
      fmtp: "minptime=10;useinbandfec=1",
    },
    {
      kind: "video",
      name: "VP8",
      pt: 96,
      clockrate: 90000,
      rtx_pt: 97,
      rtcp_fb: ["nack", "nack pli", "ccm fir", "goog-remb"],
    },
  ],
  extmap: [
    { id: 1, uri: "urn:ietf:params:rtp-hdrext:sdes:mid" },
    { id: 4, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" },
    {
      id: 5,
      uri: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
    },
    {
      id: 6,
      uri: "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    },
  ],
};

// ============================================================================
// Test runner
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertContains(sdp, text, msg) {
  assert(sdp.includes(text), `${msg} — expected to contain "${text}"`);
}

function assertNotContains(sdp, text, msg) {
  assert(!sdp.includes(text), `${msg} — expected NOT to contain "${text}"`);
}

function assertCount(sdp, pattern, expected, msg) {
  const regex = new RegExp(pattern, "gm");
  const matches = sdp.match(regex) || [];
  assert(
    matches.length === expected,
    `${msg} — expected ${expected} matches of "${pattern}", got ${matches.length}`,
  );
}

// ============================================================================
// Tests: buildPublishRemoteSdp
// ============================================================================

console.log("\n=== buildPublishRemoteSdp ===");

{
  const sdp = buildPublishRemoteSdp(serverConfig);

  // 기본 구조
  assertContains(sdp, "v=0\r\n", "has version");
  assertContains(sdp, "a=group:BUNDLE 0 1", "has BUNDLE with 2 mids");
  assertContains(sdp, "a=ice-lite", "has ice-lite");

  // m-line 개수
  assertCount(sdp, "^m=audio", 1, "one audio m-line");
  assertCount(sdp, "^m=video", 1, "one video m-line");

  // direction: 서버가 recvonly (내 미디어를 받아감)
  assertCount(sdp, "a=recvonly", 2, "both sections recvonly");
  assertNotContains(sdp, "a=sendonly", "no sendonly");
  assertNotContains(sdp, "a=sendrecv", "no sendrecv");

  // ICE: publish ufrag 사용
  assertContains(
    sdp,
    `a=ice-ufrag:${serverConfig.ice.publish_ufrag}`,
    "publish ufrag",
  );
  assertContains(
    sdp,
    `a=ice-pwd:${serverConfig.ice.publish_pwd}`,
    "publish pwd",
  );
  assertNotContains(
    sdp,
    serverConfig.ice.subscribe_ufrag,
    "no subscribe ufrag",
  );

  // DTLS
  assertContains(
    sdp,
    `a=fingerprint:${serverConfig.dtls.fingerprint}`,
    "fingerprint",
  );
  assertContains(sdp, "a=setup:passive", "setup passive");

  // codecs
  assertContains(sdp, "a=rtpmap:111 opus/48000/2", "opus codec");
  assertContains(sdp, "a=rtpmap:96 VP8/90000", "VP8 codec");
  assertContains(sdp, "a=rtpmap:97 rtx/90000", "RTX codec");
  assertContains(sdp, "a=fmtp:97 apt=96", "RTX apt");
  assertContains(sdp, "a=fmtp:111 minptime=10;useinbandfec=1", "opus fmtp");

  // rtcp-fb
  assertContains(sdp, "a=rtcp-fb:111 nack", "audio nack");
  assertContains(sdp, "a=rtcp-fb:96 nack pli", "video nack pli");
  assertContains(sdp, "a=rtcp-fb:96 goog-remb", "video remb");

  // extmap
  assertContains(
    sdp,
    "a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid",
    "extmap mid",
  );
  assertContains(
    sdp,
    "a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
    "extmap audio-level",
  );

  // rtcp-mux
  assertCount(sdp, "a=rtcp-mux", 2, "rtcp-mux in both sections");

  // rtcp-rsize: video만
  assertCount(sdp, "a=rtcp-rsize", 1, "rtcp-rsize only in video");

  // SSRC: recvonly이므로 없어야 함
  assertNotContains(sdp, "a=ssrc:", "no SSRC in recvonly");

  // candidate
  assertContains(
    sdp,
    `a=candidate:1 1 udp 2113937151 ${serverConfig.ice.ip} ${serverConfig.ice.port} typ host`,
    "host candidate",
  );
  assertContains(sdp, "a=end-of-candidates", "end-of-candidates");

  // port
  assertContains(sdp, `m=audio ${serverConfig.ice.port}`, "audio port");
  assertContains(sdp, `m=video ${serverConfig.ice.port}`, "video port");

  // validate
  const v = validateSdp(sdp);
  assert(v.valid, `validateSdp passes: ${v.errors.join(", ")}`);

  console.log(`  publish SDP: ${sdp.split("\r\n").length - 1} lines`);
}

// ============================================================================
// Tests: buildSubscribeRemoteSdp
// ============================================================================

console.log("\n=== buildSubscribeRemoteSdp ===");

// 트랙 없을 때 — 최소 SDP
{
  const sdp = buildSubscribeRemoteSdp(serverConfig, []);

  assertContains(sdp, "a=group:BUNDLE 0", "single mid");
  assertCount(sdp, "^m=audio", 1, "one inactive audio");
  assertContains(sdp, "a=inactive", "inactive direction");
  assertNotContains(sdp, "a=ssrc:", "no SSRC");

  const v = validateSdp(sdp);
  assert(v.valid, `empty tracks validate: ${v.errors.join(", ")}`);
}

// 트랙 2개 (audio + video from one user)
{
  const tracks = [
    { user_id: "userA", kind: "audio", ssrc: 12345, track_id: "userA_0" },
    { user_id: "userA", kind: "video", ssrc: 23456, track_id: "userA_1" },
  ];
  const sdp = buildSubscribeRemoteSdp(serverConfig, tracks);

  assertContains(sdp, "a=group:BUNDLE 0 1", "two mids");
  assertCount(sdp, "^m=audio", 1, "one audio");
  assertCount(sdp, "^m=video", 1, "one video");
  assertCount(sdp, "a=sendonly", 2, "both sendonly");

  // subscribe ufrag 사용
  assertContains(
    sdp,
    `a=ice-ufrag:${serverConfig.ice.subscribe_ufrag}`,
    "subscribe ufrag",
  );
  assertNotContains(sdp, serverConfig.ice.publish_ufrag, "no publish ufrag");

  // SSRC
  assertContains(sdp, "a=ssrc:12345 cname:light-sfu", "audio ssrc");
  assertContains(sdp, "a=ssrc:23456 cname:light-sfu", "video ssrc");

  // msid
  assertContains(sdp, "a=ssrc:12345 msid:light-userA userA_0", "audio msid");
  assertContains(sdp, "a=ssrc:23456 msid:light-userA userA_1", "video msid");

  const v = validateSdp(sdp);
  assert(v.valid, `2 tracks validate: ${v.errors.join(", ")}`);

  console.log(`  subscribe 2-track SDP: ${sdp.split("\r\n").length - 1} lines`);
}

// 트랙 4개 (2 users × audio + video)
{
  const tracks = [
    { user_id: "userA", kind: "audio", ssrc: 11111, track_id: "userA_0" },
    { user_id: "userA", kind: "video", ssrc: 22222, track_id: "userA_1" },
    { user_id: "userB", kind: "audio", ssrc: 33333, track_id: "userB_0" },
    { user_id: "userB", kind: "video", ssrc: 44444, track_id: "userB_1" },
  ];
  const sdp = buildSubscribeRemoteSdp(serverConfig, tracks);

  assertContains(sdp, "a=group:BUNDLE 0 1 2 3", "four mids");
  assertCount(sdp, "^m=audio", 2, "two audio m-lines");
  assertCount(sdp, "^m=video", 2, "two video m-lines");
  assertCount(sdp, "a=sendonly", 4, "all sendonly");
  assertContains(sdp, "a=ssrc:11111", "userA audio ssrc");
  assertContains(sdp, "a=ssrc:44444", "userB video ssrc");

  const v = validateSdp(sdp);
  assert(v.valid, `4 tracks validate: ${v.errors.join(", ")}`);

  console.log(`  subscribe 4-track SDP: ${sdp.split("\r\n").length - 1} lines`);
}

// ============================================================================
// Tests: updateSubscribeRemoteSdp (inactive 처리)
// ============================================================================

console.log("\n=== updateSubscribeRemoteSdp ===");

// 참가자 퇴장 → inactive
{
  const allTracks = [
    {
      user_id: "userA",
      kind: "audio",
      ssrc: 11111,
      track_id: "userA_0",
      active: true,
    },
    {
      user_id: "userA",
      kind: "video",
      ssrc: 22222,
      track_id: "userA_1",
      active: true,
    },
    {
      user_id: "userB",
      kind: "audio",
      ssrc: 33333,
      track_id: "userB_0",
      active: false,
    },
    {
      user_id: "userB",
      kind: "video",
      ssrc: 44444,
      track_id: "userB_1",
      active: false,
    },
  ];
  const sdp = updateSubscribeRemoteSdp(serverConfig, allTracks);

  assertCount(sdp, "a=sendonly", 2, "two active sendonly");
  assertCount(sdp, "a=inactive", 2, "two inactive");
  assertContains(sdp, "a=group:BUNDLE 0 1 2 3", "all 4 mids in BUNDLE");

  // inactive의 port=0
  const lines = sdp.split("\r\n");
  const mLines = lines.filter((l) => l.startsWith("m="));
  assert(mLines.length === 4, "4 m-lines total");

  // inactive sections에는 SSRC 없음
  const sections = sdp.split(/(?=^m=)/m).filter((s) => s.startsWith("m="));
  let inactiveWithSsrc = 0;
  for (const sec of sections) {
    if (sec.includes("a=inactive") && sec.includes("a=ssrc:")) {
      inactiveWithSsrc++;
    }
  }
  assert(inactiveWithSsrc === 0, "no SSRC in inactive sections");

  const v = validateSdp(sdp);
  assert(v.valid, `inactive update validate: ${v.errors.join(", ")}`);
}

// inactive mid 재활용 — C가 들어와서 B의 슬롯 재사용
{
  const allTracks = [
    {
      user_id: "userA",
      kind: "audio",
      ssrc: 11111,
      track_id: "userA_0",
      active: true,
    },
    {
      user_id: "userA",
      kind: "video",
      ssrc: 22222,
      track_id: "userA_1",
      active: true,
    },
    {
      user_id: "userC",
      kind: "audio",
      ssrc: 55555,
      track_id: "userC_0",
      active: true,
    },
    {
      user_id: "userC",
      kind: "video",
      ssrc: 66666,
      track_id: "userC_1",
      active: true,
    },
  ];
  const sdp = updateSubscribeRemoteSdp(serverConfig, allTracks);

  assertCount(sdp, "a=sendonly", 4, "all 4 active");
  assertCount(sdp, "a=inactive", 0, "no inactive");
  assertContains(sdp, "a=ssrc:55555", "userC audio ssrc");
  assertContains(sdp, "a=ssrc:66666", "userC video ssrc");

  const v = validateSdp(sdp);
  assert(v.valid, `reuse slot validate: ${v.errors.join(", ")}`);
}

// ============================================================================
// Tests: validateSdp
// ============================================================================

console.log("\n=== validateSdp ===");

{
  const bad = "garbage data";
  const v = validateSdp(bad);
  assert(!v.valid, "garbage SDP is invalid");
  assert(v.errors.length > 0, "has error messages");
}

{
  // BUNDLE mids 불일치
  const bad =
    "v=0\r\na=group:BUNDLE 0 1\r\na=ice-lite\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=ice-ufrag:x\r\na=ice-pwd:y\r\na=fingerprint:sha-256 AA\r\na=recvonly\r\n";
  const v = validateSdp(bad);
  assert(!v.valid, "BUNDLE mismatch detected");
}

// ============================================================================
// Tests: Edge cases
// ============================================================================

console.log("\n=== Edge cases ===");

// audio-only 서버 정책
{
  const audioOnlyConfig = {
    ...serverConfig,
    codecs: serverConfig.codecs.filter((c) => c.kind === "audio"),
  };
  const sdp = buildPublishRemoteSdp(audioOnlyConfig);

  assertCount(sdp, "^m=audio", 1, "audio only: one audio");
  assertCount(sdp, "^m=video", 0, "audio only: no video");
  assertContains(sdp, "a=group:BUNDLE 0", "single mid");

  const v = validateSdp(sdp);
  assert(v.valid, `audio-only validate: ${v.errors.join(", ")}`);
}

// null tracks
{
  const sdp = buildSubscribeRemoteSdp(serverConfig, null);
  assertContains(sdp, "a=inactive", "null tracks → inactive");

  const v = validateSdp(sdp);
  assert(v.valid, `null tracks validate: ${v.errors.join(", ")}`);
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${"=".repeat(50)}`);
console.log(
  `Total: ${passed + failed} tests — ${passed} passed, ${failed} failed`,
);
if (failed > 0) {
  console.log("⚠️  SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("✅ ALL TESTS PASSED");
}
