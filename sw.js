/* 오프라인 지원 — 앱 껍데기와 라이브러리를 기기에 캐시합니다.
   파일을 고칠 때는 index.html의 ?v= 값과 아래 CACHE 버전을 함께 올려 주세요. */
const CACHE = 'pdf-image-tool-v3';

const CORE = [
  './',
  './index.html',
  './styles.css?v=2',
  './app.js?v=2',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/pdf-lib.min.js',
  './vendor/jszip.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // 화면(HTML)은 항상 네트워크 우선, 실패하면 캐시 — 업데이트가 바로 반영됩니다.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const copy = fresh.clone();
        caches.open(CACHE).then(cache => cache.put('./index.html', copy)).catch(() => {});
        return fresh;
      } catch (e) {
        return (await caches.match('./index.html')) ||
               (await caches.match('./')) ||
               Response.error();
      }
    })());
    return;
  }

  // 나머지는 캐시 우선 + 뒤에서 조용히 갱신 (오프라인에서도 즉시 뜨도록)
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(response => {
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(network.then(() => {}).catch(() => {}));
      return cached;
    }
    const response = await network;
    return response || Response.error();
  })());
});
