// author: kodeholic (powered by Claude)
// sw.js — Service Worker (PWA 설치 조건 충족용)
// 현재는 캐시 전략 없이 최소 구현. 필요 시 확장.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));
