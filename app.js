const CLIENT_ID = '494575771380-crkh7jitlj72jo9ruvp66s9c4g093j0d.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_ID = '1lrBFJbvCRPzdQqBZ-Dt1yN0W3TDhYgXM'; // 同期先ルートフォルダ

let tokenClient;
let accessToken = null;
let currentRaceData = null;
let reviewsData = { reviews: {} }; // 回顧データ

// 現在のアクティブ状態
let activeRaceId = null;
let activeHorseIndex = null;
let activePastRaceIndex = null;

// --- DOM Elements ---
const authBtn = document.getElementById('auth-btn');
const syncBtn = document.getElementById('sync-btn');
const saveBtn = document.getElementById('save-btn');
const syncStatus = document.getElementById('sync-status');
const raceListContainer = document.getElementById('race-list-container');

// --- Initialization ---
window.onload = async function () {
    console.log("App initialized");

    // GIS 初期化
    if (window.google && google.accounts) {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: (tokenResponse) => {
                if (tokenResponse && tokenResponse.access_token) {
                    accessToken = tokenResponse.access_token;
                    navigate('dashboard');
                    loadLocalData();
                }
            },
        });
    }

    authBtn.addEventListener('click', () => tokenClient.requestAccessToken());
    
    syncBtn.addEventListener('click', () => {
        if (!accessToken) { alert("先にログインしてください"); return; }
        syncDataFromDrive();
    });

    saveBtn.addEventListener('click', () => {
        saveCurrentReview();
    });
};

// ============================================================
//  Google Drive & ローカルデータの双方向同期
// ============================================================

async function syncDataFromDrive() {
    syncStatus.style.display = 'block';
    syncStatus.textContent = '同期中...';

    try {
        // --- 1. 出馬表データ (umazashira_data.js) のダウンロード ---
        const queryJs = encodeURIComponent(
            `'${DRIVE_FOLDER_ID}' in parents and name='umazashira_data.js' and trashed=false`
        );
        const searchJsRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${queryJs}&fields=files(id,name)`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        const searchJsData = await searchJsRes.json();

        if (searchJsData.files && searchJsData.files.length > 0) {
            const fileId = searchJsData.files[0].id;
            const contentRes = await fetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                { headers: { 'Authorization': `Bearer ${accessToken}` } }
            );
            let contentText = await contentRes.text();
            contentText = contentText.replace(/^.*?const\s+[A-Za-z0-9_]+\s*=\s*/, '').replace(/;$/, '');
            currentRaceData = JSON.parse(contentText);
            await localforage.setItem('raceData', currentRaceData);
        }

        // --- 2. 回顧データ (race_reviews.json) の双方向同期 ---
        const queryJson = encodeURIComponent(
            `'${DRIVE_FOLDER_ID}' in parents and name='race_reviews.json' and trashed=false`
        );
        const searchJsonRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${queryJson}&fields=files(id,name)`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        const searchJsonData = await searchJsonRes.json();

        let driveReviews = { reviews: {} };
        let driveFileId = null;

        if (searchJsonData.files && searchJsonData.files.length > 0) {
            driveFileId = searchJsonData.files[0].id;
            const contentRes = await fetch(
                `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
                { headers: { 'Authorization': `Bearer ${accessToken}` } }
            );
            if (contentRes.ok) {
                driveReviews = await contentRes.json();
            }
        }

        // マージ処理 (更新日時が新しい方を優先)
        const mergedReviews = mergeReviews(reviewsData, driveReviews);
        reviewsData = mergedReviews;
        await localforage.setItem('reviewsData', reviewsData);

        // Drive へアップロードして上書き保存
        const uploadSuccess = await uploadReviewsToDrive(driveFileId, reviewsData);

        if (uploadSuccess) {
            syncStatus.textContent = '✅ 同期完了！';
        } else {
            syncStatus.textContent = '⚠️ 同期完了（アップロード失敗）';
        }
        
        setTimeout(() => syncStatus.style.display = 'none', 3000);
        renderDashboard();

    } catch (err) {
        console.error(err);
        syncStatus.textContent = `❌ 同期エラー: ${err.message}`;
        setTimeout(() => syncStatus.style.display = 'none', 5000);
    }
}

function mergeReviews(local, remote) {
    const merged = { reviews: { ...(remote.reviews || {}) } };
    for (const [key, localItem] of Object.entries(local.reviews || {})) {
        const remoteItem = merged.reviews[key];
        if (!remoteItem || (localItem.updatedAt || 0) > (remoteItem.updatedAt || 0)) {
            merged.reviews[key] = localItem;
        }
    }
    return merged;
}

async function uploadReviewsToDrive(fileId, data) {
    const filename = 'race_reviews.json';
    const fileMetadata = {
        name: filename,
        mimeType: 'application/json'
    };

    const boundary = 'foo_bar_baz';
    const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fileMetadata)}\r\n`;
    const mediaPart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
    const body = metadataPart + mediaPart;

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    let method = 'POST';

    if (fileId) {
        url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`;
        method = 'PATCH';
    }

    try {
        const res = await fetch(url, {
            method: method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: body
        });
        return res.ok;
    } catch (e) {
        console.error("Upload error", e);
        return false;
    }
}

// --- ローカルキャッシュ読み込み ---
async function loadLocalData() {
    try {
        const data = await localforage.getItem('raceData');
        if (data) { currentRaceData = data; renderDashboard(); }

        const reviews = await localforage.getItem('reviewsData');
        if (reviews) { reviewsData = reviews; }
    } catch (err) { console.error("Local load error", err); }
}

// ============================================================
//  UI レンダリング & 操作
// ============================================================

function renderDashboard() {
    if (!currentRaceData) {
        raceListContainer.innerHTML = '<div class="placeholder-text">データを同期してください</div>';
        return;
    }
    let html = '';
    for (const [raceId, raceInfo] of Object.entries(currentRaceData)) {
        html += `
            <div class="glass-panel" style="cursor:pointer;" onclick="openRace('${raceId}')">
                <div style="font-weight:800; font-size:16px;">${raceInfo.date} ${raceInfo.venue}${raceInfo.race_num}R</div>
                <div style="color:var(--text-muted); font-size:14px;">${raceInfo.race_name}</div>
                <div style="margin-top:8px; display:inline-block; background:rgba(59,130,246,0.3); color:#60a5fa; padding:2px 8px; border-radius:10px; font-size:12px;">
                    出走 ${raceInfo.horses ? raceInfo.horses.length : 0} 頭
                </div>
            </div>`;
    }
    raceListContainer.innerHTML = html;
}

function openRace(raceId) {
    activeRaceId = raceId;
    const raceInfo = currentRaceData[raceId];
    document.getElementById('race-title').textContent = `${raceInfo.venue}${raceInfo.race_num}R: ${raceInfo.race_name}`;

    const horseListContainer = document.getElementById('horse-list-container');
    let html = '';
    if (raceInfo.horses) {
        raceInfo.horses.forEach((horse, index) => {
            html += `
                <div class="glass-panel" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center;" onclick="openHorse(${index})">
                    <div>
                        <div style="font-size:12px; color:var(--text-muted);">馬番: ${horse.horse_number}</div>
                        <div style="font-weight:bold; font-size:16px;">${horse.horse_name}</div>
                    </div>
                    <div style="font-size:12px; background:var(--primary-color); padding:4px 8px; border-radius:12px;">回顧する</div>
                </div>`;
        });
    }
    horseListContainer.innerHTML = html;
    navigate('race');
}

function openHorse(index) {
    activeHorseIndex = index;
    const horse = currentRaceData[activeRaceId].horses[index];
    document.getElementById('horse-name-title').textContent = horse.horse_name;

    const tabsContainer = document.getElementById('past-races-tabs');
    let tabsHtml = '';

    if (horse.past_races && horse.past_races.length > 0) {
        horse.past_races.forEach((pr_str, i) => {
            if (i >= 5) return;
            const lines = pr_str.split('<br>');
            const prId = lines[0];
            const raceName = lines[4] || '';
            tabsHtml += `<button class="tab ${i===0 ? 'active' : ''}" onclick="selectPastRace(${i}, '${prId}')">${i+1}走前: ${raceName.substring(0,6)}...</button>`;
        });
        const firstPrLines = horse.past_races[0].split('<br>');
        selectPastRace(0, firstPrLines[0], false);
    } else {
        tabsHtml = '<div style="color:var(--text-muted); font-size:12px;">前走データなし</div>';
        showNoVideo("前走データがありません");
    }

    tabsContainer.innerHTML = tabsHtml;
    navigate('horse');
}

// ============================================================
//  回顧データの読み書き
// ============================================================

function getReviewKey() {
    if (activeRaceId === null || activeHorseIndex === null || activePastRaceIndex === null) return null;
    const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
    return `${activeRaceId}_${horse.horse_name}_${activePastRaceIndex}`;
}

function loadReviewToForm() {
    const key = getReviewKey();
    if (!key) return;

    const review = reviewsData.reviews[key] || {};
    document.getElementById('eval-start').value = review.start || '';
    document.getElementById('eval-corner').value = review.corner || '';
    document.getElementById('eval-straight').value = review.straight || '';
    document.getElementById('eval-plus').value = review.plus || '';
    document.getElementById('eval-minus').value = review.minus || '';
    document.getElementById('eval-summary').value = review.summary || '';
}

async function saveCurrentReview() {
    const key = getReviewKey();
    if (!key) return;

    reviewsData.reviews[key] = {
        start: document.getElementById('eval-start').value,
        corner: document.getElementById('eval-corner').value,
        straight: document.getElementById('eval-straight').value,
        plus: document.getElementById('eval-plus').value,
        minus: document.getElementById('eval-minus').value,
        summary: document.getElementById('eval-summary').value,
        updatedAt: Date.now()
    };

    try {
        await localforage.setItem('reviewsData', reviewsData);
        alert("回顧をローカルに保存しました！同期ボタンを押して Drive に反映させてください。");
    } catch (e) {
        console.error("Save review error", e);
        alert("保存に失敗しました。");
    }
}

// ============================================================
//  動画再生 (Google Drive MP4 ストリーミング再生)
// ============================================================

const driveFolderCache = {};
let currentBlobUrl = null;

function showNoVideo(message) {
    document.querySelector('.video-container').innerHTML = `
        <div style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:14px;">${message}</div>`;
}

function showVideoLoading() {
    document.querySelector('.video-container').innerHTML = `
        <div style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:14px;">
            ⏳ Drive から動画を読み込み中...
        </div>`;
}

async function getDriveYearFolderId(year) {
    if (driveFolderCache[year]) return driveFolderCache[year];

    const query = encodeURIComponent(
        `name='${year}' and '${DRIVE_FOLDER_ID}' in parents and ` +
        `mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const res  = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.files && data.files.length > 0) {
        driveFolderCache[year] = data.files[0].id;
        return data.files[0].id;
    }
    return null;
}

async function getDriveFileId(filename, yearFolderId) {
    const query = encodeURIComponent(
        `name='${filename}' and '${yearFolderId}' in parents and trashed=false`
    );
    const res  = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    return (data.files && data.files.length > 0) ? data.files[0].id : null;
}

async function selectPastRace(tabIndex, nbId, updateTabs = true) {
    activePastRaceIndex = tabIndex;

    if (updateTabs) {
        document.querySelectorAll('.tab').forEach((tab, i) => {
            tab.classList.toggle('active', i === tabIndex);
        });
    }

    // フォームに保存済みの回顧データを表示
    loadReviewToForm();

    // 前の動画のblobURLを解放
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    if (!nbId || nbId === "動画なし") {
        showNoVideo("前走動画がありません");
        return;
    }
    if (!accessToken) {
        showNoVideo("動画を再生するにはログインしてください");
        return;
    }

    const filename = `${nbId}.mp4`;
    const year     = nbId.substring(0, 4);

    showVideoLoading();

    try {
        const yearFolderId = await getDriveYearFolderId(year);
        if (!yearFolderId) {
            showNoVideo(`⚠️ ${year}年フォルダがDriveに見つかりません`);
            return;
        }

        const fileId = await getDriveFileId(filename, yearFolderId);
        if (!fileId) {
            showNoVideo(`⚠️ 動画がまだアップロードされていません<br><small>${filename}</small>`);
            return;
        }

        const videoRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        if (!videoRes.ok) throw new Error(`Drive API エラー: ${videoRes.status}`);

        const blob      = await videoRes.blob();
        currentBlobUrl  = URL.createObjectURL(blob);

        document.querySelector('.video-container').innerHTML = `
            <video id="race-video" controls playsinline style="width:100%; border-radius:8px;">
                <source src="${currentBlobUrl}" type="video/mp4">
            </video>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px; text-align:right;">
                📁 ${filename}
            </div>`;

    } catch (err) {
        console.error(err);
        showNoVideo(`❌ 動画の読み込みに失敗しました<br><small>${err.message}</small>`);
    }
}

// --- Navigation ---
function navigate(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.add('active');
    window.scrollTo(0, 0);
}
