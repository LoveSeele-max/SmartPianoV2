/**
 * service-worker.js - Service Worker 离线缓存
 * 利用 Cache Storage API 将 Soundfont 音色文件永久缓存在浏览器中
 * 实现"二次秒开"，甚至在断网环境下也能正常使用
 */

const CACHE_NAME = 'smart-piano-v2-cache-v6';

// 需要预缓存的资源
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/app.js',
    '/audioEngine.js',
    '/midiController.js',
    '/parser.js',
    '/noteMap.js',
    '/sheetLibrary.js',
    '/manifest.json',
    '/icon.svg',
    'https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/soundfont-player@0.12.0/dist/soundfont-player.min.js'
];

// 需要缓存的音色文件域名
const SOUNDFONT_ORIGINS = [
    'https://gleitz.github.io',
    'https://cdn.jsdelivr.net',
    'https://unpkg.com'
];

/** 判断请求是否为音色文件 */
function isSoundfontRequest(url) {
    return SOUNDFONT_ORIGINS.some(origin => url.startsWith(origin)) &&
           (url.includes('soundfont') || url.includes('piano') || url.includes('.mp3') || url.includes('.ogg'));
}

// 安装阶段：预缓存核心资源
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[ServiceWorker] 预缓存核心资源');
                return cache.addAll(PRECACHE_URLS);
            })
            .then(() => self.skipWaiting())
    );
});

// 激活阶段：清理旧版本缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((cacheName) => cacheName !== CACHE_NAME)
                    .map((cacheName) => caches.delete(cacheName))
            );
        }).then(() => self.clients.claim())
    );
});

// 拦截请求：优先从缓存读取，缓存未命中则网络获取并缓存
self.addEventListener('fetch', (event) => {
    const requestUrl = event.request.url;

    // 仅处理 GET 请求
    if (event.request.method !== 'GET') return;

    // 对于音色文件：缓存优先，网络获取后缓存（缓存策略：Cache First）
    if (isSoundfontRequest(requestUrl)) {
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) {
                    console.log('[ServiceWorker] 音色缓存命中:', requestUrl);
                    return cachedResponse;
                }

                console.log('[ServiceWorker] 下载并缓存音色:', requestUrl);
                return fetch(event.request).then((networkResponse) => {
                    // 只缓存成功的响应
                    if (networkResponse && networkResponse.status === 200) {
                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return networkResponse;
                });
            })
        );
        return;
    }

    // 对于其他资源（JS、CSS、图片等）：网络优先策略
    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // 缓存成功的响应
                if (networkResponse && networkResponse.status === 200) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // 网络不可用时，尝试从缓存读取
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // 对于导航请求，返回离线页面
                    if (event.request.mode === 'navigate') {
                        return caches.match('/index.html');
                    }
                    return new Response('', { status: 408, statusText: 'Offline' });
                });
            })
    );
});
