// Service Worker for RaceReviewPWA
const CACHE_NAME = 'race-review-pwa-v20261020';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// Background Fetch API サポート（Android Chrome / 対応環境向け）
self.addEventListener('backgroundfetchsuccess', (event) => {
    const bgFetch = event.registration;
    event.waitUntil(async function() {
        try {
            const records = await bgFetch.matchAll();
            for (const record of records) {
                const response = await record.responseReady;
                const blob = await response.blob();
                const nbId = record.request.headers.get('X-Video-Id') || bgFetch.id.replace('bgf_', '');
                if (nbId) {
                    // クライアント側に完了を通知
                    const allClients = await clients.matchAll({ includeUncontrolled: true });
                    for (const client of allClients) {
                        client.postMessage({
                            type: 'BG_FETCH_VIDEO_SAVED',
                            nbId: nbId
                        });
                    }
                }
            }
            await event.updateUI({ title: '競馬動画の保存が完了しました' });
        } catch (err) {
            console.error('[SW] backgroundfetchsuccess error:', err);
        }
    }());
});

self.addEventListener('backgroundfetchfail', (event) => {
    console.warn('[SW] backgroundfetchfail:', event.registration.id);
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
