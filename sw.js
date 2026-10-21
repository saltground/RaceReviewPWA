// Service Worker for RaceReviewPWA
const CACHE_NAME = 'race-review-pwa-v20261021';

// Service Worker 内で IndexedDB (localforage) を直接利用可能にする
try {
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js');
} catch (e) {
    console.warn('[SW] Could not import localforage:', e);
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// ============================================================
// Background Fetch API（他アプリ操作中・ブラウザ非表示中もOSがDL継続）
// ============================================================
self.addEventListener('backgroundfetchsuccess', (event) => {
    const bgFetch = event.registration;
    event.waitUntil(async function() {
        try {
            const records = await bgFetch.matchAll();
            for (const record of records) {
                const response = await record.responseReady;
                const blob = await response.blob();
                
                // nbIdの抽出 (id: bgf_202605020909 または ヘッダー)
                let nbId = bgFetch.id ? bgFetch.id.replace('bgf_', '') : '';
                if (!nbId && record.request.headers.get('X-Video-Id')) {
                    nbId = record.request.headers.get('X-Video-Id');
                }

                if (nbId) {
                    // Service Worker から IndexedDB (localforage) に直接保存！
                    if (typeof localforage !== 'undefined') {
                        await localforage.setItem(`video_${nbId}`, blob);
                        console.log(`[SW] Saved video_${nbId} directly to IndexedDB via Background Fetch`);
                    }

                    // キャッシュストレージにも念のため保存
                    try {
                        const cache = await caches.open('video-blobs-v1');
                        await cache.put(`/videos/${nbId}.mp4`, new Response(blob));
                    } catch (_) {}

                    // 起動中のクライアント（PWA画面）に通知
                    const allClients = await clients.matchAll({ includeUncontrolled: true });
                    for (const client of allClients) {
                        client.postMessage({
                            type: 'BG_FETCH_VIDEO_SAVED',
                            nbId: nbId,
                            size: blob.size
                        });
                    }
                }
            }
            await event.updateUI({ title: '競馬動画のバックグラウンド保存が完了しました' });
        } catch (err) {
            console.error('[SW] backgroundfetchsuccess error:', err);
        }
    }());
});

self.addEventListener('backgroundfetchfail', (event) => {
    console.warn('[SW] backgroundfetchfail:', event.registration.id);
    event.waitUntil(async function() {
        const allClients = await clients.matchAll({ includeUncontrolled: true });
        for (const client of allClients) {
            client.postMessage({
                type: 'BG_FETCH_FAILED',
                id: event.registration.id
            });
        }
    }());
});

self.addEventListener('backgroundfetchabort', (event) => {
    console.warn('[SW] backgroundfetchabort:', event.registration.id);
});

self.addEventListener('backgroundfetchclick', (event) => {
    event.waitUntil(async function() {
        const allClients = await clients.matchAll({ type: 'window' });
        if (allClients.length > 0) {
            allClients[0].focus();
        } else {
            clients.openWindow('/');
        }
    }());
});
