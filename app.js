const CLIENT_ID = '257777008-bmie829mev13mncesvmn3ovf4khcp5q5.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_ID = '1lrBFJbvCRPzdQqBZ-Dt1yN0W3TDhYgXM';

// ============================================================
//  状態管理
// ============================================================
let tokenClient, accessToken = null;
let currentRaceData = null, reviewsData = { reviews: {} };
let activeRaceId = null, activeHorseIndex = null, activePastRaceIndex = null;
let activeNbId = null; // 現在再生中の過去走ID
let bulkDownloadStopped = false; // 一括DL停止フラグ

// Drive フォルダIDキャッシュ
const driveFolderCache = {};
let currentBlobUrl = null;

// ============================================================
//  初期化
// ============================================================
window.onload = async function () {
    if (window.google && google.accounts) {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: (resp) => {
                if (resp && resp.access_token) {
                    accessToken = resp.access_token;
                    navigate('dashboard');
                    loadLocalData();
                }
            },
        });
    }
    document.getElementById('auth-btn').addEventListener('click', () => tokenClient.requestAccessToken());
    document.getElementById('sync-btn').addEventListener('click', () => {
        if (!accessToken) { alert('先にログインしてください'); return; }
        syncDataFromDrive();
    });
    document.getElementById('save-btn').addEventListener('click', saveCurrentReview);
};

// ============================================================
//  トースト通知
// ============================================================
function showToast(msg, duration = 3000) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), duration);
}

// ============================================================
//  ナビゲーション
// ============================================================
function navigate(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.add('active');
    window.scrollTo(0, 0);
    if (viewId === 'cache') renderCacheManager();
}

// ============================================================
//  Drive同期（出馬表 & 回顧データ双方向）
// ============================================================
async function syncDataFromDrive() {
    const status = document.getElementById('sync-status');
    status.style.display = 'block';
    status.textContent = '同期中...';
    try {
        // 出馬表データ取得
        const jsFile = await findDriveFile('umazashira_data.js', DRIVE_FOLDER_ID);
        if (jsFile) {
            const text = await fetchDriveFileContent(jsFile.id);
            const json = JSON.parse(text.replace(/^.*?const\s+\w+\s*=\s*/, '').replace(/;$/, ''));
            currentRaceData = json;
            await localforage.setItem('raceData', json);
        }

        // 回顧データ双方向同期
        const jsonFile = await findDriveFile('race_reviews.json', DRIVE_FOLDER_ID);
        let driveReviews = { reviews: {} };
        let driveFileId = null;
        if (jsonFile) {
            driveFileId = jsonFile.id;
            const text = await fetchDriveFileContent(driveFileId);
            try { driveReviews = JSON.parse(text); } catch (e) {}
        }
        reviewsData = mergeReviews(reviewsData, driveReviews);
        await localforage.setItem('reviewsData', reviewsData);
        await uploadReviewsToDrive(driveFileId, reviewsData);

        // トラックバイアスデータ同期
        const biasFile = await findDriveFile('track_bias_data.json');
        if (biasFile) {
            const text = await fetchDriveFileContent(biasFile.id);
            try {
                window.TRACK_BIAS_DATA = JSON.parse(text);
                await localforage.setItem('trackBiasData', window.TRACK_BIAS_DATA);
            } catch (e) { console.error('bias json parse error', e); }
        }

        // レース結果・払戻金データ同期
        const resultsFile = await findDriveFile('race_results_data.json');
        if (resultsFile) {
            const text = await fetchDriveFileContent(resultsFile.id);
            try {
                window.RACE_RESULTS_DATA = JSON.parse(text);
                await localforage.setItem('raceResultsData', window.RACE_RESULTS_DATA);
            } catch (e) { console.error('results json parse error', e); }
        }

        status.textContent = '✅ 同期完了！';
        renderDashboard();
        if (typeof renderPayoffStats === 'function') renderPayoffStats();
    } catch (err) {
        status.textContent = `❌ エラー: ${err.message}`;
    }
    setTimeout(() => status.style.display = 'none', 3000);
}

function mergeReviews(local, remote) {
    const merged = { reviews: { ...(remote.reviews || {}) } };
    for (const [k, v] of Object.entries(local.reviews || {})) {
        const r = merged.reviews[k];
        if (!r || (v.updatedAt || 0) > (r.updatedAt || 0)) merged.reviews[k] = v;
    }
    return merged;
}

async function uploadReviewsToDrive(fileId, data) {
    const boundary = 'rr_boundary';
    const meta = { name: 'race_reviews.json', mimeType: 'application/json' };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
    const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    await fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
    });
}

// ============================================================
//  ローカルデータ読み込み
// ============================================================
async function loadLocalData() {
    const data = await localforage.getItem('raceData');
    if (data) { currentRaceData = data; renderDashboard(); }
    const reviews = await localforage.getItem('reviewsData');
    if (reviews) reviewsData = reviews;
    const bias = await localforage.getItem('trackBiasData');
    if (bias) window.TRACK_BIAS_DATA = bias;
    const resData = await localforage.getItem('raceResultsData');
    if (resData) window.RACE_RESULTS_DATA = resData;
    if (typeof renderPayoffStats === 'function') renderPayoffStats();
}

// ============================================================
//  ダッシュボード描画
// ============================================================
function getPaceBadgeForRace(raceId, info) {
    let paceIndex = info ? info.pace_index : null;
    let f3f_l3f = info ? info.pace_f3f_l3f : null;
    if ((!paceIndex || paceIndex === 'Unknown') && window.TRACK_BIAS_DATA && window.TRACK_BIAS_DATA.race_paces) {
        const pObj = window.TRACK_BIAS_DATA.race_paces[raceId];
        if (pObj) {
            paceIndex = pObj.pace;
            f3f_l3f = pObj.f3f_l3f;
        }
    }
    if (typeof getPaceBadgeHtml === 'function') {
        return getPaceBadgeHtml(paceIndex, f3f_l3f);
    }
    return '';
}

function renderDashboard() {
    if (!currentRaceData) { document.getElementById('race-list-container').innerHTML = '<div class="placeholder-text">データを同期してください</div>'; return; }
    let html = '';
    for (const [raceId, info] of Object.entries(currentRaceData)) {
        const paceBadge = getPaceBadgeForRace(raceId, info);
        html += `<div class="glass-panel" style="cursor:pointer;" onclick="openRace('${raceId}')">
            <div style="font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:space-between;">
                <span>${info.date} ${info.venue}${info.race_num}R</span>
                ${paceBadge}
            </div>
            <div style="color:var(--text-muted);font-size:14px;">${info.race_name}</div>
            <div style="margin-top:8px;display:inline-block;background:rgba(59,130,246,0.3);color:#60a5fa;padding:2px 8px;border-radius:10px;font-size:12px;">出走 ${info.horses ? info.horses.length : 0} 頭</div>
        </div>`;
    }
    document.getElementById('race-list-container').innerHTML = html;
}

// ============================================================
//  レース詳細（馬一覧）
// ============================================================
function openRace(raceId) {
    activeRaceId = raceId;
    const info = currentRaceData[raceId];
    const paceBadge = getPaceBadgeForRace(raceId, info);
    document.getElementById('race-title').innerHTML = `${info.venue}${info.race_num}R: ${info.race_name} ${paceBadge}`;
    let html = '';
    (info.horses || []).forEach((h, i) => {
        html += `<div class="glass-panel" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;" onclick="openHorse(${i})">
            <div>
                <div style="font-size:12px;color:var(--text-muted);">馬番: ${h.horse_number}</div>
                <div style="font-weight:bold;font-size:16px;">${h.horse_name}</div>
            </div>
            <div style="font-size:12px;background:var(--primary-color);padding:4px 8px;border-radius:12px;">回顧する</div>
        </div>`;
    });
    document.getElementById('horse-list-container').innerHTML = html;
    navigate('race');
}

// ============================================================
//  馬詳細（過去走タブ）
// ============================================================
function openHorse(index) {
    activeHorseIndex = index;
    const horse = currentRaceData[activeRaceId].horses[index];
    document.getElementById('horse-name-title').textContent = horse.horse_name;
    // 枠番情報は初期化（タブ選択時に更新される）
    document.getElementById('horse-meta-info').textContent = '';

    const tabsContainer = document.getElementById('past-races-tabs');
    let tabsHtml = '';
    if (horse.past_races && horse.past_races.length > 0) {
        horse.past_races.forEach((pr_str, i) => {
            if (i >= 5) return;
            const lines = pr_str.split('<br>');
            const prId = lines[0] || '';
            const raceName = lines[4] || '';
            const safeId = prId || '動画なし';
            tabsHtml += `<button class="tab ${i===0?'active':''}" id="tab-${i}" onclick="selectPastRace(${i},'${safeId}')">${i+1}走前: ${raceName.substring(0,6) || '---'}...</button>`;
        });
        // タブHTMLをDOMに反映してから最初のタブを選択する
        tabsContainer.innerHTML = tabsHtml;
        updateTabCacheDots(horse);
        const first = horse.past_races[0].split('<br>');
        const firstId = first[0] || '動画なし';
        selectPastRace(0, firstId, false);
    } else {
        tabsHtml = '<div style="color:var(--text-muted);font-size:12px;">前走データなし</div>';
        tabsContainer.innerHTML = tabsHtml;
        showNoVideo('前走データがありません');
    }
    navigate('horse');
}

async function updateTabCacheDots(horse) {
    if (!horse.past_races) return;
    for (let i = 0; i < Math.min(horse.past_races.length, 5); i++) {
        const prId = horse.past_races[i].split('<br>')[0];
        const cached = await localforage.getItem(`video_${prId}`);
        const tab = document.getElementById(`tab-${i}`);
        if (tab && cached) {
            if (!tab.querySelector('.cached-dot')) {
                const dot = document.createElement('span');
                dot.className = 'cached-dot';
                tab.appendChild(dot);
            }
        }
    }
}

// ============================================================
//  回顧データ読み書き
// ============================================================
function getReviewKey() {
    if (activeHorseIndex === null || !activeNbId || activeNbId === '動画なし') return null;
    const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
    // キー = 「回顧対象の過去走レースID」+「馬名」
    // → 週をまたいでも同じ過去走を参照すれば同じキーになり、回顧が引き継がれる
    return `${activeNbId}_${horse.horse_name}`;
}

function loadReviewToForm() {
    const key = getReviewKey();
    if (!key) return;
    const r = reviewsData.reviews[key] || {};
    document.getElementById('eval-start').value    = r.start    || '';
    document.getElementById('eval-corner').value   = r.corner   || '';
    document.getElementById('eval-straight').value = r.straight || '';
    document.getElementById('eval-plus').value     = r.plus     || '';
    document.getElementById('eval-minus').value    = r.minus    || '';
    document.getElementById('eval-summary').value  = r.summary  || '';
}

async function saveCurrentReview() {
    const key = getReviewKey();
    if (!key) return;
    reviewsData.reviews[key] = {
        start:    document.getElementById('eval-start').value,
        corner:   document.getElementById('eval-corner').value,
        straight: document.getElementById('eval-straight').value,
        plus:     document.getElementById('eval-plus').value,
        minus:    document.getElementById('eval-minus').value,
        summary:  document.getElementById('eval-summary').value,
        updatedAt: Date.now()
    };
    await localforage.setItem('reviewsData', reviewsData);
    showToast('✅ 回顧を保存しました');
}

// ============================================================
//  動画再生（IndexedDBキャッシュ優先）
// ============================================================
async function selectPastRace(tabIndex, nbId, updateTabs = true) {
    activePastRaceIndex = tabIndex;
    activeNbId = nbId;
    if (updateTabs) {
        document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === tabIndex));
    }
    loadReviewToForm();

    // 選択タブの過去走における馬番を lines[5](Data03) から抽出して表示
    // Data03 実フォーマット: "N頭 M番 人 騎手名 斤量" ← 枠番なし、馬番のみ
    const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
    const metaEl = document.getElementById('horse-meta-info');
    if (horse && horse.past_races && horse.past_races[tabIndex]) {
        const prLines = horse.past_races[tabIndex].split('<br>');
        const horseInfoText = prLines[5] || '';
        // U+756A = 「番」→ 「N番」のNを馬番として取得
        const mBan = horseInfoText.match(/(\d+)番/);
        if (mBan) {
            metaEl.textContent = `${mBan[1]}番`;
        } else {
            metaEl.textContent = '';
        }
    } else {
        metaEl.textContent = '';
    }

    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }

    if (!nbId || nbId === '動画なし') { showNoVideo('前走動画がありません'); return; }

    const filename = `${nbId}.mp4`;
    const slot = document.getElementById('video-slot');
    const actions = document.getElementById('video-actions');

    // --- IndexedDBキャッシュを確認 ---
    const cached = await localforage.getItem(`video_${nbId}`);
    if (cached) {
        currentBlobUrl = URL.createObjectURL(cached);
        slot.innerHTML = `<video controls playsinline><source src="${currentBlobUrl}" type="video/mp4"></video>`;
        actions.style.display = 'flex';
        updateVideoBadge(true, cached.size);
        document.getElementById('btn-dl-video').style.display = 'none';
        document.getElementById('btn-del-video').style.display = '';
        return;
    }

    // --- Driveからストリーミング ---
    if (!accessToken) { showNoVideo('動画を再生するにはログインしてください'); return; }
    slot.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-size:14px;">⏳ Drive から読み込み中...</div>`;
    actions.style.display = 'none';

    try {
        const year = nbId.substring(0, 4);
        const yearFolderId = await getDriveYearFolderId(year);
        if (!yearFolderId) { showNoVideo(`⚠️ ${year}年フォルダが見つかりません`); return; }
        const fileId = await getDriveFileId(filename, yearFolderId);
        if (!fileId) { showNoVideo(`⚠️ 動画が未アップロード<br><small>${filename}</small>`); return; }

        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (!res.ok) throw new Error(`Drive API エラー: ${res.status}`);

        const blob = await res.blob();
        currentBlobUrl = URL.createObjectURL(blob);
        slot.innerHTML = `<video controls playsinline><source src="${currentBlobUrl}" type="video/mp4"></video>`;
        actions.style.display = 'flex';
        updateVideoBadge(false, blob.size);
        document.getElementById('btn-dl-video').style.display = '';
        document.getElementById('btn-del-video').style.display = 'none';

        // 自動キャッシュ保存（オプション：コメントアウトで無効化可能）
        // await localforage.setItem(`video_${nbId}`, blob);
    } catch (err) {
        showNoVideo(`❌ 読み込み失敗: ${err.message}`);
    }
}

function showNoVideo(msg) {
    document.getElementById('video-slot').innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-size:14px;">${msg}</div>`;
    document.getElementById('video-actions').style.display = 'none';
}

function updateVideoBadge(isCached, size) {
    const badge = document.getElementById('video-cache-badge');
    const mb = (size / 1024 / 1024).toFixed(1);
    if (isCached) {
        badge.textContent = `✅ キャッシュ済み（${mb}MB）`;
        badge.className = 'cache-badge cached';
    } else {
        badge.textContent = `☁️ Drive再生（${mb}MB）`;
        badge.className = 'cache-badge not-cached';
    }
}

// ============================================================
//  動画個別操作（保存 / 削除 / 再取得）
// ============================================================
async function downloadCurrentVideo() {
    if (!activeNbId || !currentBlobUrl) return;
    document.getElementById('btn-dl-video').textContent = '保存中...';
    try {
        const res = await fetch(currentBlobUrl);
        const blob = await res.blob();
        await localforage.setItem(`video_${activeNbId}`, blob);
        showToast('✅ 動画をローカルに保存しました');
        updateVideoBadge(true, blob.size);
        document.getElementById('btn-dl-video').style.display = 'none';
        document.getElementById('btn-del-video').style.display = '';
        // タブのドットを更新
        const tab = document.getElementById(`tab-${activePastRaceIndex}`);
        if (tab && !tab.querySelector('.cached-dot')) {
            const dot = document.createElement('span'); dot.className = 'cached-dot'; tab.appendChild(dot);
        }
    } catch (e) {
        showToast('❌ 保存に失敗しました');
    }
    document.getElementById('btn-dl-video').textContent = '📥 保存';
}

async function deleteCurrentVideo() {
    if (!activeNbId) return;
    await localforage.removeItem(`video_${activeNbId}`);
    showToast('🗑️ キャッシュを削除しました');
    updateVideoBadge(false, 0);
    document.getElementById('btn-dl-video').style.display = '';
    document.getElementById('btn-del-video').style.display = 'none';
    const tab = document.getElementById(`tab-${activePastRaceIndex}`);
    if (tab) { const dot = tab.querySelector('.cached-dot'); if (dot) dot.remove(); }
}

async function reloadCurrentVideo() {
    await localforage.removeItem(`video_${activeNbId}`);
    selectPastRace(activePastRaceIndex, activeNbId, false);
}

// ============================================================
//  一括ダウンロード
// ============================================================
async function startBulkDownload() {
    if (!accessToken) { alert('先にログインしてください'); return; }
    if (!currentRaceData || !activeRaceId) return;

    const horses = currentRaceData[activeRaceId].horses || [];
    // 全過去走IDを収集
    const targets = [];
    for (const h of horses) {
        if (!h.past_races) continue;
        for (let i = 0; i < Math.min(h.past_races.length, 5); i++) {
            const nbId = h.past_races[i].split('<br>')[0];
            if (nbId && nbId !== '動画なし') targets.push(nbId);
        }
    }
    if (targets.length === 0) { showToast('ダウンロード対象がありません'); return; }

    // 既存キャッシュを除外してカウント
    const toDownload = [];
    for (const nbId of targets) {
        const cached = await localforage.getItem(`video_${nbId}`);
        if (!cached) toDownload.push(nbId);
    }

    const totalSize = toDownload.length * 40; // 概算40MB/本
    const confirmed = confirm(
        `Wi-Fi環境であることを確認してください。\n\nこのレースの動画を一括ダウンロードします。\n対象: ${toDownload.length} 本（既キャッシュ ${targets.length - toDownload.length} 本をスキップ）\n推定: 約${totalSize}MB\n\n開始しますか？`
    );
    if (!confirmed) return;

    bulkDownloadStopped = false;
    let done = 0, skipped = 0, failed = 0;
    const bar = document.getElementById('dl-progress-bar');
    const fill = document.getElementById('dl-progress-fill');
    const text = document.getElementById('dl-progress-text');
    bar.style.display = 'block';

    for (const nbId of toDownload) {
        if (bulkDownloadStopped) break;
        text.textContent = `ダウンロード中... ${done + skipped}/${toDownload.length}本`;
        fill.style.width = `${Math.round(((done + skipped) / toDownload.length) * 100)}%`;

        const filename = `${nbId}.mp4`;
        const year = nbId.substring(0, 4);
        try {
            const yearFolderId = await getDriveYearFolderId(year);
            if (!yearFolderId) { skipped++; continue; }
            const fileId = await getDriveFileId(filename, yearFolderId);
            if (!fileId) { skipped++; continue; }
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                { headers: { 'Authorization': `Bearer ${accessToken}` } });
            if (!res.ok) throw new Error();
            const blob = await res.blob();
            await localforage.setItem(`video_${nbId}`, blob);
            done++;
        } catch {
            failed++;
        }
    }

    bar.style.display = 'none';
    fill.style.width = '0%';
    const stopMsg = bulkDownloadStopped ? '（停止）' : '';
    showToast(`${stopMsg}完了: ${done}本保存 / ${skipped}本スキップ / ${failed}本失敗`, 4000);
    // タブのドット更新
    const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
    if (horse) updateTabCacheDots(horse);
}

function stopBulkDownload() {
    bulkDownloadStopped = true;
}

// ============================================================
//  キャッシュ管理画面
// ============================================================
async function renderCacheManager() {
    const list = document.getElementById('cache-list');
    const summary = document.getElementById('cache-summary');
    list.innerHTML = '<div class="placeholder-text" style="margin-top:20px;">読み込み中...</div>';

    const keys = await localforage.keys();
    const videoKeys = keys.filter(k => k.startsWith('video_'));
    let totalBytes = 0;
    let html = '';

    for (const key of videoKeys.sort()) {
        const blob = await localforage.getItem(key);
        if (!blob) continue;
        const mb = (blob.size / 1024 / 1024).toFixed(1);
        totalBytes += blob.size;
        const nbId = key.replace('video_', '');
        html += `<div class="cache-item">
            <span class="cache-item-name">${nbId}.mp4</span>
            <span class="cache-item-size">${mb}MB</span>
            <button class="vact-btn danger" onclick="deleteCacheItem('${key}', this)">削除</button>
        </div>`;
    }

    const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
    summary.innerHTML = `保存動画数: <b>${videoKeys.length} 本</b><br>使用容量: <b>${totalMb} MB</b>`;

    if (html) {
        list.innerHTML = `<div class="glass-panel">${html}</div>`;
    } else {
        list.innerHTML = '<div class="placeholder-text" style="margin-top:20px;">保存済み動画がありません</div>';
    }
}

async function deleteCacheItem(key, btn) {
    await localforage.removeItem(key);
    btn.closest('.cache-item').remove();
    showToast('🗑️ 削除しました');
    renderCacheManager();
}

async function clearAllCache() {
    if (!confirm('保存済み動画を全て削除しますか？')) return;
    const keys = await localforage.keys();
    for (const k of keys.filter(k => k.startsWith('video_'))) {
        await localforage.removeItem(k);
    }
    showToast('🗑️ 全キャッシュを削除しました');
    renderCacheManager();
}

// ============================================================
//  Drive APIヘルパー
// ============================================================
async function findDriveFile(name, folderId) {
    let qStr = `name='${name}' and trashed=false`;
    if (folderId) qStr += ` and '${folderId}' in parents`;
    const q = encodeURIComponent(qStr);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } });
    const data = await res.json();
    return (data.files && data.files.length > 0) ? data.files[0] : null;
}

async function fetchDriveFileContent(fileId) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } });
    return await res.text();
}

async function getDriveYearFolderId(year) {
    if (driveFolderCache[year]) return driveFolderCache[year];
    const f = await findDriveFile(year, DRIVE_FOLDER_ID);
    // フォルダかどうかはmimeTypeで厳密にはチェックしないが実用上問題なし
    if (f) { driveFolderCache[year] = f.id; return f.id; }
    return null;
}

async function getDriveFileId(filename, yearFolderId) {
    const f = await findDriveFile(filename, yearFolderId);
    return f ? f.id : null;
}
