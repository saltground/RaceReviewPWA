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
    // 初期ローカルデータおよび同梱レビューデータのロード（ログイン状態にかかわらず即時実行）
    await loadLocalData();

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

    // 文字入力中も動画を常に上部で見れるようにするVisualViewport連動制御
    setupTypingVideoLock();
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

        // 回顧データ双方向同期（マイドライブ全体から最新更新のファイルを最優先で検索）
        let jsonFile = await findDriveFile('race_reviews.json');
        if (!jsonFile && DRIVE_FOLDER_ID) {
            jsonFile = await findDriveFile('race_reviews.json', DRIVE_FOLDER_ID);
        }
        let driveReviews = { reviews: {} };
        let driveFileId = jsonFile ? jsonFile.id : null;
        if (jsonFile) {
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
                const driveResults = JSON.parse(text);
                if (isDatasetSuperior(driveResults, window.RACE_RESULTS_DATA)) {
                    window.RACE_RESULTS_DATA = driveResults;
                    await localforage.setItem('raceResultsData', window.RACE_RESULTS_DATA);
                    console.log('[Drive Sync] Applied superior raceResultsData from Drive');
                }
            } catch (e) { console.error('results json parse error', e); }
        }

        status.textContent = '✅ 同期完了！';
        renderDashboard();
        if (typeof renderPayoffStats === 'function') renderPayoffStats();
        if (typeof onBiasSelectorChange === 'function') onBiasSelectorChange();
        const todayVenueEl = document.getElementById('today-venue');
        if (todayVenueEl && todayVenueEl.value && typeof autoFillTodayTrackData === 'function') {
            autoFillTodayTrackData(todayVenueEl.value);
        }
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
    if (!fileId) {
        const existing = await findDriveFile('race_reviews.json');
        if (existing) fileId = existing.id;
    }
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

    let reviews = await localforage.getItem('reviewsData') || { reviews: {} };
    // 同梱の初期レビューデータ (INITIAL_REVIEWS_DATA) を確実にマージ
    if (window.INITIAL_REVIEWS_DATA && window.INITIAL_REVIEWS_DATA.reviews) {
        reviews = mergeReviews(reviews, window.INITIAL_REVIEWS_DATA);
        await localforage.setItem('reviewsData', reviews);
    }
    reviewsData = reviews;

    const bias = await localforage.getItem('trackBiasData');
    if (bias) window.TRACK_BIAS_DATA = bias;

    // 同梱またはローカルサーバーの最新 track_bias_data.json を自動フェッチ
    try {
        const resp = await fetch('track_bias_data.json?v=' + Date.now());
        if (resp.ok) {
            const freshBias = await resp.json();
            if (freshBias && freshBias.today_track) {
                window.TRACK_BIAS_DATA = freshBias;
                await localforage.setItem('trackBiasData', freshBias);
            }
        }
    } catch (e) {
        // オフラインまたは未配置時は既存キャッシュを維持
    }

    const resData = await localforage.getItem('raceResultsData');
    const bundledData = window.RACE_RESULTS_DATA;

    // 同梱データがキャッシュより優れている（新しい・データ品質が高い）場合は完全自動で更新
    if (isDatasetSuperior(bundledData, resData)) {
        window.RACE_RESULTS_DATA = bundledData;
        await localforage.setItem('raceResultsData', bundledData);
        console.log(`[Cache Migration] Upgraded raceResultsData to superior bundled dataset (Ver: ${bundledData.version || 'unknown'})`);
    } else if (resData) {
        window.RACE_RESULTS_DATA = resData;
    } else if (bundledData) {
        window.RACE_RESULTS_DATA = bundledData;
        await localforage.setItem('raceResultsData', bundledData);
    }
    if (typeof renderPayoffStats === 'function') renderPayoffStats();
    if (typeof onBiasSelectorChange === 'function') onBiasSelectorChange();
    const todayVenueEl = document.getElementById('today-venue');
    if (todayVenueEl && todayVenueEl.value && typeof autoFillTodayTrackData === 'function') {
        autoFillTodayTrackData(todayVenueEl.value);
    }
}

/**
 * データセット（候補 candidate と 既存 current）の鮮度・品質を普遍的に比較判定
 * candidate が current よりも新しい、または品質（RPCI補完度・レース数等）が勝っているかを客観的に評価
 * @param {Object} candidate - 採用を検討する新しいデータセット（例: 最新同梱データ、Driveデータ）
 * @param {Object} current - 現在キャッシュまたはメモリにある既存データセット
 * @returns {boolean} true: candidate の方が優れており、更新すべき
 */
function isDatasetSuperior(candidate, current) {
    if (!candidate) return false;
    if (!current) return true;

    // 1. バージョン文字列の比較（例: '20261015_01' > '20261014_02'）
    const candidateVer = String(candidate.version || '').trim();
    const currentVer = String(current.version || '').trim();
    if (candidateVer && !currentVer) return true; // 既存データにバージョンが付与されていない（旧キャッシュ）
    if (candidateVer && currentVer && candidateVer > currentVer) return true;
    if (currentVer && candidateVer && currentVer > candidateVer) return false; // 既存の方が明示的に新しい

    // 2. ビルドタイムスタンプ（ISO 8601等）の比較
    const candidateTime = candidate.build_time ? new Date(candidate.build_time).getTime() : 0;
    const currentTime = current.build_time ? new Date(current.build_time).getTime() : 0;
    if (candidateTime > 0 && currentTime > 0) {
        if (candidateTime > currentTime) return true;
        if (currentTime > candidateTime) return false;
    } else if (candidateTime > 0 && currentTime === 0) {
        return true;
    }

    // 3. データ品質・充実度の客観的指標による判定
    const candRaces = Array.isArray(candidate.races) ? candidate.races : [];
    const currRaces = Array.isArray(current.races) ? current.races : [];

    // ① RPCI算出・保有レース数の比較（データ補完度の客観的比較）
    const countValidRpci = (races) => {
        let cnt = 0;
        for (let i = 0; i < races.length; i++) {
            const r = races[i];
            if (r && r.rpci !== null && r.rpci !== undefined && !isNaN(Number(r.rpci))) {
                cnt++;
            }
        }
        return cnt;
    };
    const candRpciCount = countValidRpci(candRaces);
    const currRpciCount = countValidRpci(currRaces);

    if (candRpciCount > currRpciCount) return true;
    if (currRpciCount > candRpciCount) return false;

    // ② 総レース件数の比較
    if (candRaces.length > currRaces.length) return true;
    if (currRaces.length > candRaces.length) return false;

    // ③ コース基準（course_standards）の収録数
    const candStdCount = candidate.course_standards ? Object.keys(candidate.course_standards).length : 0;
    const currStdCount = current.course_standards ? Object.keys(current.course_standards).length : 0;
    if (candStdCount > currStdCount) return true;

    return false;
}

// ============================================================
//  ダッシュボード描画
// ============================================================
/**
 * レースのペース (H / M / S) バッジHTMLを生成する
 */
function getPaceBadgeHtml(paceIndex, f3f_l3f, diffText = '') {
    if (!paceIndex || paceIndex === 'Unknown' || paceIndex === 'NoLap') return '';
    let cls = 'pace-badge-m';
    if (paceIndex === 'H+' || paceIndex === '超H') cls = 'pace-badge-h-plus';
    else if (paceIndex === 'H') cls = 'pace-badge-h';
    else if (paceIndex === 'S') cls = 'pace-badge-s';
    else if (paceIndex === 'S+' || paceIndex === '超S') cls = 'pace-badge-s-plus';

    const label = paceIndex;
    let tooltip = '';
    if (diffText) tooltip += `基準差: ${diffText}`;
    if (f3f_l3f && f3f_l3f !== 'Unknown' && f3f_l3f !== 'NoLap') {
        tooltip += (tooltip ? ' | ' : '') + `前後半3F: ${f3f_l3f}`;
    }
    return `<span class="pace-badge ${cls}" title="${tooltip}">${label}</span>`;
}

function getPaceBadgeForRace(raceId, pastRaceStr = '') {
    if ((!raceId || raceId === '動画なし') && !pastRaceStr) return '';

    // ① 第一優先: TRACK_BIAS_DATA.race_paces から探す
    if (raceId && window.TRACK_BIAS_DATA && window.TRACK_BIAS_DATA.race_paces) {
        const pObj = window.TRACK_BIAS_DATA.race_paces[raceId];
        if (pObj && pObj.pace && pObj.pace !== 'Unknown' && pObj.pace !== 'NoLap') {
            return getPaceBadgeHtml(pObj.pace, pObj.f3f_l3f);
        }
    }

    // ② 第二優先: 過去走テキストからの推定・補完
    if (pastRaceStr) {
        const lines = pastRaceStr.split('<br>');
        const cornerText = lines[7] || ''; // 通過順
        if (cornerText.includes('1-1') || cornerText.includes('1-1-1')) {
            return getPaceBadgeHtml('S', 'スロー傾向');
        } else if (cornerText.match(/(\d+)-(\d+)-(\d+)/)) {
            const pos = cornerText.match(/(\d+)-(\d+)-(\d+)/);
            if (pos && parseInt(pos[1]) >= 8) {
                return getPaceBadgeHtml('H', 'ハイ傾向');
            }
        }
        return getPaceBadgeHtml('M', 'ミドル傾向');
    }

    return '';
}

function renderDashboard() {
    if (!currentRaceData) { document.getElementById('race-list-container').innerHTML = '<div class="placeholder-text">データを同期してください</div>'; return; }
    let html = '';
    for (const [raceId, info] of Object.entries(currentRaceData)) {
        html += `<div class="glass-panel" style="cursor:pointer;" onclick="openRace('${raceId}')">
            <div style="font-weight:800;font-size:16px;">${info.date} ${info.venue}${info.race_num}R</div>
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
    document.getElementById('race-title').textContent = `${info.venue}${info.race_num}R: ${info.race_name}`;
    let html = '';
    (info.horses || []).forEach((h, i) => {
        const revCount = countReviewsForHorse(h);
        const hasReview = revCount > 0;
        const btnClass = hasReview ? 'btn-reviewed' : '';
        const btnText = hasReview ? `📝 回顧済 (${revCount}件)` : '回顧する';
        html += `<div class="glass-panel" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;" onclick="openHorse(${i})">
            <div>
                <div style="font-size:12px;color:var(--text-muted);">馬番: ${h.horse_number}</div>
                <div style="font-weight:bold;font-size:16px;">${h.horse_name}</div>
            </div>
            <div class="${btnClass}" style="font-size:12px;background:var(--primary-color);padding:5px 10px;border-radius:12px;">${btnText}</div>
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
    // 枠番・馬番情報は初期化（タブ選択時に更新される）
    document.getElementById('horse-meta-info').innerHTML = '';

    const tabsContainer = document.getElementById('past-races-tabs');
    let tabsHtml = '';
    if (horse.past_races && horse.past_races.length > 0) {
        horse.past_races.forEach((pr_str, i) => {
            if (i >= 5) return;
            const lines = pr_str.split('<br>');
            const prId = lines[0] || '';
            const raceName = lines[4] || '';
            const safeId = prId || '動画なし';
            const paceBadge = getPaceBadgeForRace(prId, pr_str);
            const foundRev = findReviewForHorseTab(horse, i, prId);
            const revIcon = foundRev ? ' 📝' : '';
            const revClass = foundRev ? 'has-review' : '';
            tabsHtml += `<button class="tab ${i===0?'active':''} ${revClass}" id="tab-${i}" onclick="selectPastRace(${i},'${safeId}')">${i+1}走前: ${raceName.substring(0,6) || '---'}${revIcon} ${paceBadge}</button>`;
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
//  回顧データ読み書き & フォールバック検索
// ============================================================

/**
 * 対象馬・対象タブに対する回顧キー候補を優先度順に生成
 */
function getReviewKeyCandidates(horse, tabIndex, nbId) {
    const candidates = [];
    if (!horse) return candidates;
    const hName = horse.horse_name;

    // 1. 新形式: 回顧対象の過去走レースID + 馬名 (例: 202605020909_イクシード)
    if (nbId && nbId !== '動画なし') {
        candidates.push(`${nbId}_${hName}`);
    }
    if (horse.past_races && horse.past_races[tabIndex]) {
        const prId = horse.past_races[tabIndex].split('<br>')[0];
        if (prId && prId !== '動画なし' && !candidates.includes(`${prId}_${hName}`)) {
            candidates.push(`${prId}_${hName}`);
        }
    }

    // 2. 旧形式: 出走レースID + 馬名 + タブ番号 (例: 202605020909_イクシード_0)
    if (activeRaceId) {
        candidates.push(`${activeRaceId}_${hName}_${tabIndex}`);
    }

    // 3. 動画なし・汎用フォールバック
    candidates.push(`${hName}_${tabIndex}`);

    return candidates;
}

/**
 * 対象馬・対象タブに対応する回顧オブジェクトを検索
 */
function findReviewForHorseTab(horse, tabIndex, nbId) {
    if (!reviewsData || !reviewsData.reviews) return null;
    const candidates = getReviewKeyCandidates(horse, tabIndex, nbId);
    for (const key of candidates) {
        const r = reviewsData.reviews[key];
        if (r && (r.summary || r.start || r.corner || r.straight || r.plus || r.minus)) {
            return { review: r, matchedKey: key };
        }
    }
    return null;
}

/**
 * 馬全体の回顧済み件数をカウント
 */
function countReviewsForHorse(horse) {
    if (!horse || !horse.past_races) return 0;
    let count = 0;
    for (let i = 0; i < Math.min(horse.past_races.length, 5); i++) {
        const prId = horse.past_races[i].split('<br>')[0];
        if (findReviewForHorseTab(horse, i, prId)) {
            count++;
        }
    }
    return count;
}

/**
 * 現在選択中の過去走の正規レビュー保存キー
 */
function getReviewKey() {
    if (activeHorseIndex === null || !currentRaceData || !currentRaceData[activeRaceId]) return null;
    const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
    if (activeNbId && activeNbId !== '動画なし') {
        return `${activeNbId}_${horse.horse_name}`;
    }
    if (horse.past_races && horse.past_races[activePastRaceIndex]) {
        const prId = horse.past_races[activePastRaceIndex].split('<br>')[0];
        if (prId && prId !== '動画なし') return `${prId}_${horse.horse_name}`;
    }
    return `${activeRaceId}_${horse.horse_name}_${activePastRaceIndex}`;
}

function loadReviewToForm() {
    if (activeHorseIndex === null || !currentRaceData || !currentRaceData[activeRaceId]) return;
    const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
    const found = findReviewForHorseTab(horse, activePastRaceIndex, activeNbId);
    const r = found ? found.review : {};

    document.getElementById('eval-start').value    = r.start    || '';
    document.getElementById('eval-corner').value   = r.corner   || '';
    document.getElementById('eval-straight').value = r.straight || '';
    document.getElementById('eval-plus').value     = r.plus     || '';
    document.getElementById('eval-minus').value    = r.minus    || '';
    document.getElementById('eval-summary').value  = r.summary  || '';

    // 旧キーで見つかった場合は、正規キーにも自動コピーして移行
    if (found && found.matchedKey !== getReviewKey()) {
        const canonicalKey = getReviewKey();
        if (canonicalKey) {
            reviewsData.reviews[canonicalKey] = { ...r };
        }
    }
}

async function saveCurrentReview() {
    const key = getReviewKey();
    if (!key) return;
    const reviewObj = {
        start:    document.getElementById('eval-start').value,
        corner:   document.getElementById('eval-corner').value,
        straight: document.getElementById('eval-straight').value,
        plus:     document.getElementById('eval-plus').value,
        minus:    document.getElementById('eval-minus').value,
        summary:  document.getElementById('eval-summary').value,
        updatedAt: Date.now()
    };
    reviewsData.reviews[key] = reviewObj;

    // 旧形式キーにも互換性のためバックアップ保存
    if (activeRaceId && activeHorseIndex !== null) {
        const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
        const oldKey = `${activeRaceId}_${horse.horse_name}_${activePastRaceIndex}`;
        reviewsData.reviews[oldKey] = { ...reviewObj };
    }

    await localforage.setItem('reviewsData', reviewsData);
    showToast('✅ 回顧を保存しました');

    // タブの回顧アイコンを即時更新
    const curTab = document.getElementById(`tab-${activePastRaceIndex}`);
    if (curTab && !curTab.classList.contains('has-review')) {
        curTab.classList.add('has-review');
    }
}

// ============================================================
//  動画再生（IndexedDBキャッシュ優先）
// ============================================================

/**
 * 過去レースのRPCIおよびペース情報を取得
 */
function getPastRacePciData(nbId, prStr = '') {
    let raceId = (nbId && nbId !== '動画なし') ? String(nbId).trim() : '';
    if (!raceId && prStr) {
        const lines = prStr.split('<br>');
        if (lines[0] && lines[0].length >= 10 && lines[0] !== '動画なし') {
            raceId = lines[0].trim();
        }
    }

    let pciObj = null;

    // 1. RACE_RESULTS_DATA から検索
    if (raceId && window.RACE_RESULTS_DATA && window.RACE_RESULTS_DATA.races) {
        const found = window.RACE_RESULTS_DATA.races.find(r => r.id === raceId);
        if (found) {
            const hasNumRpci = found.rpci !== null && found.rpci !== undefined && !isNaN(Number(found.rpci)) && String(found.rpci) !== 'undefined';
            const hasNumStd = found.standard_rpci !== null && found.standard_rpci !== undefined && !isNaN(Number(found.standard_rpci)) && String(found.standard_rpci) !== 'undefined';
            const hasNumDiff = found.pci_diff !== null && found.pci_diff !== undefined && !isNaN(Number(found.pci_diff)) && String(found.pci_diff) !== 'undefined';

            pciObj = {
                id: found.id,
                name: found.name || '',
                rpci: hasNumRpci ? Number(found.rpci) : null,
                standard_rpci: hasNumStd ? Number(found.standard_rpci) : null,
                pci_diff: hasNumDiff ? Number(found.pci_diff) : null,
                pace_category: found.pace_category || found.pace_index || '',
                pace_label: found.pace_label || '',
                pace_f3f_l3f: found.pace_f3f_l3f || ''
            };
        }
    }

    // 2. TRACK_BIAS_DATA.race_paces から検索（フォールバック）
    if (!pciObj && raceId && window.TRACK_BIAS_DATA && window.TRACK_BIAS_DATA.race_paces) {
        const pObj = window.TRACK_BIAS_DATA.race_paces[raceId];
        if (pObj && pObj.pace && pObj.pace !== 'Unknown' && pObj.pace !== 'NoLap') {
            pciObj = {
                id: raceId,
                name: '',
                rpci: null,
                standard_rpci: null,
                pci_diff: null,
                pace_category: pObj.pace,
                pace_label: pObj.pace === 'H' ? 'ハイペース / 前傾' : (pObj.pace === 'S' ? 'スローペース / 後傾' : 'ミドルペース / 平均'),
                pace_f3f_l3f: pObj.f3f_l3f || ''
            };
        }
    }

    // 3. コース基準データ（COURSE_PCI_STANDARDS）からの補完
    if (pciObj && pciObj.standard_rpci === null && prStr) {
        // prStr から競馬場・距離を推定して基準RPCIを補完
        const std = lookupCourseStandard(prStr);
        if (std) {
            pciObj.standard_rpci = std;
            if (pciObj.rpci !== null && !isNaN(Number(pciObj.rpci))) {
                pciObj.pci_diff = Number((pciObj.rpci - std).toFixed(1));
            }
        }
    } else if (!pciObj && prStr) {
        const std = lookupCourseStandard(prStr);
        if (std) {
            pciObj = {
                id: raceId || '',
                name: '',
                rpci: null,
                standard_rpci: std,
                pci_diff: null,
                pace_category: '',
                pace_label: '',
                pace_f3f_l3f: ''
            };
        }
    }

    return pciObj;
}

/**
 * 過去走文字列からコース基準値をルックアップ
 */
function lookupCourseStandard(prStr) {
    if (!prStr || !window.COURSE_PCI_STANDARDS) return null;
    const venueMap = {
        '東京':'東京','中山':'中山','阪神':'阪神','京都':'京都','中京':'中京','新潟':'新潟','福島':'福島','小倉':'小倉','札幌':'札幌','函館':'函館',
        '東':'東京','中':'中山','阪':'阪神','京':'京都','名':'中京','新':'新潟','福':'福島','小':'小倉','札':'札幌','函':'函館'
    };
    
    let vName = '';
    // 1. 2文字の正式競馬場名
    for (const [key, name] of Object.entries(venueMap)) {
        if (key.length === 2 && prStr.includes(key)) {
            vName = name;
            break;
        }
    }
    // 2. 開催回数付き略称（例: 5東③, 1新④ など）
    if (!vName) {
        const mKaisai = prStr.match(/\d+([東中阪京名新福小札函])[\d①-⑫]/);
        if (mKaisai && venueMap[mKaisai[1]]) {
            vName = venueMap[mKaisai[1]];
        }
    }

    // 3. 芝/ダート/障害 + 距離（例: 芝1600, ダ1800）
    const mDist = prStr.match(/(芝|ダ|障害|ダート)(\d{3,4})/);
    if (vName && mDist) {
        const surf = mDist[1].startsWith('ダ') ? 'ダ' : (mDist[1] === '芝' ? '芝' : '障害');
        const dist = mDist[2];
        const cKey = `${vName}_${surf}${dist}`;
        const item = window.COURSE_PCI_STANDARDS[cKey];
        if (item && item.mean_rpci) return item.mean_rpci;
    }
    return null;
}

/**
 * 過去走RPCIバーの描画
 */
function renderPastRaceRpcibar(pciData, nbId, prStr) {
    const bar = document.getElementById('past-race-rpci-bar');
    if (!bar) return;

    if (!pciData) {
        const badge = getPaceBadgeForRace(nbId, prStr);
        if (badge) {
            bar.style.display = 'flex';
            bar.innerHTML = `<span class="pr-rpci-sub">ペース傾向:</span> <span class="pr-rpci-pace">${badge}</span>`;
        } else {
            bar.style.display = 'none';
        }
        return;
    }

    bar.style.display = 'flex';
    const hasRpci = pciData.rpci !== null && pciData.rpci !== undefined && !isNaN(Number(pciData.rpci));
    const hasStd = pciData.standard_rpci !== null && pciData.standard_rpci !== undefined && !isNaN(Number(pciData.standard_rpci));
    const hasDiff = pciData.pci_diff !== null && pciData.pci_diff !== undefined && !isNaN(Number(pciData.pci_diff));

    let mainHtml = '';
    if (hasRpci) {
        const diffNum = Number(pciData.pci_diff);
        const diffSign = hasDiff ? (diffNum > 0 ? `+${diffNum.toFixed(1)}` : `${diffNum.toFixed(1)}`) : '';
        const diffCls = diffNum > 0 ? 'rpci-diff-plus' : (diffNum < 0 ? 'rpci-diff-minus' : 'rpci-diff-neutral');
        const stdStr = hasStd ? Number(pciData.standard_rpci).toFixed(1) : '-';
        const diffPart = hasDiff ? `/ 差: <span class="${diffCls}"><strong>${diffSign}</strong></span>` : '';
        mainHtml = `
        <div class="pr-rpci-main">
            <span>RPCI: <span class="pr-rpci-val">${Number(pciData.rpci).toFixed(1)}</span></span>
            <span class="pr-rpci-sub">(基準: ${stdStr} ${diffPart})</span>
        </div>`;
    } else if (hasStd) {
        mainHtml = `
        <div class="pr-rpci-main">
            <span class="pr-rpci-sub">コース基準RPCI: <span class="pr-rpci-val">${Number(pciData.standard_rpci).toFixed(1)}</span></span>
        </div>`;
    } else {
        mainHtml = `<div class="pr-rpci-main"><span class="pr-rpci-sub">ペース判定:</span></div>`;
    }

    const badgeDiffText = hasDiff ? (Number(pciData.pci_diff) > 0 ? `+${pciData.pci_diff}` : `${pciData.pci_diff}`) : '';
    const badgeHtml = getPaceBadgeHtml(pciData.pace_category, pciData.pace_f3f_l3f, badgeDiffText);
    const labelStr = pciData.pace_label ? `<span>${pciData.pace_label}</span>` : '';
    const f3fStr = pciData.pace_f3f_l3f && pciData.pace_f3f_l3f !== 'Unknown' && pciData.pace_f3f_l3f !== 'NoLap'
        ? `<span class="pr-rpci-sub">3F: ${pciData.pace_f3f_l3f}</span>` : '';

    bar.innerHTML = `
    ${mainHtml}
    <div class="pr-rpci-pace">
        ${badgeHtml}
        ${labelStr}
        ${f3fStr}
    </div>`;
}

/**
 * 回顧フォームの入力フィールド定義
 */
const EVAL_FIELDS = [
    { id: 'eval-start', label: '🏁 スタート' },
    { id: 'eval-corner', label: '🔄 コーナリング' },
    { id: 'eval-straight', label: '⚡ 直線' },
    { id: 'eval-plus', label: '👍 プラス評価' },
    { id: 'eval-minus', label: '⚠️ マイナス評価' },
    { id: 'eval-summary', label: '📝 総評' }
];

/**
 * 回顧フォームの入力フィールド状態
 */
let currentActiveFieldId = 'eval-start';
let isNavigatingField = false;

/**
 * フォーカス中の入力欄を切り替え・ナビゲーション
 */
function setActiveReviewField(targetEl) {
    if (!targetEl) return;
    currentActiveFieldId = targetEl.id;
    const viewHorse = document.getElementById('view-horse');
    const titleEl = document.getElementById('input-focus-title');
    const fieldConfig = EVAL_FIELDS.find(f => f.id === targetEl.id);

    // 全ての input-group から is-active-field を除去
    document.querySelectorAll('#view-horse .evaluation-form .input-group').forEach(grp => {
        grp.classList.remove('is-active-field');
    });

    const parentGroup = targetEl.closest('.input-group');
    if (parentGroup) {
        parentGroup.classList.add('is-active-field');
    }

    if (titleEl && fieldConfig) {
        titleEl.textContent = fieldConfig.label;
    }
}

/**
 * 前へ / 次へ ボタンによる入力項目の切り替え
 * @param {number} delta -1: 前の項目, +1: 次の項目
 * @param {Event} [event] クリックイベント
 */
function navFocusedField(delta, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    isNavigatingField = true;

    // 現在のアクティブIDに基づいて次の項目を決定（document.activeElementの喪失に依存しない）
    let currentIndex = EVAL_FIELDS.findIndex(f => f.id === currentActiveFieldId);
    if (currentIndex === -1) currentIndex = 0;

    const nextIndex = (currentIndex + delta + EVAL_FIELDS.length) % EVAL_FIELDS.length;
    currentActiveFieldId = EVAL_FIELDS[nextIndex].id;
    const nextFieldEl = document.getElementById(currentActiveFieldId);

    if (nextFieldEl) {
        setActiveReviewField(nextFieldEl);
        // モバイルでキーボードを維持しながら確実にフォーカス
        try {
            nextFieldEl.focus({ preventScroll: true });
        } catch (_) {
            nextFieldEl.focus();
        }
    }

    setTimeout(() => {
        isNavigatingField = false;
    }, 200);
}
window.navFocusedField = navFocusedField;

/**
 * 完了ボタン：フォーカス解除して全項目一覧表示へ復帰
 */
function blurFocusedField() {
    isNavigatingField = false;
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
        document.activeElement.blur();
    }
    const viewHorse = document.getElementById('view-horse');
    if (viewHorse) {
        viewHorse.classList.remove('is-typing');
        document.querySelectorAll('#view-horse .evaluation-form .input-group').forEach(grp => {
            grp.classList.remove('is-active-field');
        });
        if (viewHorse.style.height) viewHorse.style.height = '';
    }
}
window.blurFocusedField = blurFocusedField;

/**
 * スマホ文字入力時の動画常時上部固定 & VisualViewport連動制御
 * 大画面動画（フルサイズ）を維持し、フォーカス中項目のみを表示
 */
function setupTypingVideoLock() {
    const viewHorse = document.getElementById('view-horse');
    const formScrollArea = document.querySelector('#view-horse .form-scroll-area');
    if (!viewHorse) return;

    let isKeyboardOpen = false;

    // 1. フォーカス時：即座に is-typing モードを適用 & 該当項目のみアクティブ化
    viewHorse.addEventListener('focusin', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            isKeyboardOpen = true;
            setActiveReviewField(e.target);
            viewHorse.classList.add('is-typing');

            // ブラウザの強制ウィンドウスクロールを即時リセット
            window.scrollTo(0, 0);

            setTimeout(() => {
                window.scrollTo(0, 0);
            }, 50);
        }
    });

    // 2. フォーカス解除時：通常モードへ復帰
    viewHorse.addEventListener('focusout', () => {
        setTimeout(() => {
            // 前へ/次への移動中はフォーカスアウトによるリセットを防止
            if (isNavigatingField) return;

            const activeEl = document.activeElement;
            if (!activeEl || (activeEl.tagName !== 'INPUT' && activeEl.tagName !== 'TEXTAREA')) {
                isKeyboardOpen = false;
                viewHorse.classList.remove('is-typing');
                document.querySelectorAll('#view-horse .evaluation-form .input-group').forEach(grp => {
                    grp.classList.remove('is-active-field');
                });
                if (viewHorse.style.height) viewHorse.style.height = '';
            }
        }, 150);
    });

    // 3. VisualViewport 連動（iOS Safari / Android キーボード対応）
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if (isKeyboardOpen && viewHorse.classList.contains('active')) {
                // 可視領域の高さにコンテナを完全フィットさせ、画面全体のスクロールをゼロに固定
                viewHorse.style.height = `${window.visualViewport.height}px`;
                window.scrollTo(0, 0);
            }
        });
        window.visualViewport.addEventListener('scroll', () => {
            if (isKeyboardOpen) {
                window.scrollTo(0, 0);
            }
        });
    }

    // 4. ウィンドウ自体のスクロールを常にゼロに抑え込む
    window.addEventListener('scroll', () => {
        if (isKeyboardOpen && window.scrollY > 0) {
            window.scrollTo(0, 0);
        }
    });
}

async function selectPastRace(tabIndex, nbId, updateTabs = true) {
    activePastRaceIndex = tabIndex;
    activeNbId = nbId;
    if (updateTabs) {
        document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === tabIndex));
    }
    loadReviewToForm();

    // 選択タブの過去走における馬番 & RPCI情報を抽出して表示
    const horse = currentRaceData[activeRaceId].horses[activeHorseIndex];
    const metaEl = document.getElementById('horse-meta-info');
    const prStr = (horse && horse.past_races && horse.past_races[tabIndex]) ? horse.past_races[tabIndex] : '';
    const pciData = getPastRacePciData(nbId, prStr);
    renderPastRaceRpcibar(pciData, nbId, prStr);

    const paceBadge = pciData ? getPaceBadgeHtml(pciData.pace_category, pciData.pace_f3f_l3f, pciData.pci_diff) : getPaceBadgeForRace(nbId, prStr);
    const hasValidRpci = pciData && pciData.rpci !== null && pciData.rpci !== undefined && !isNaN(Number(pciData.rpci)) && String(pciData.rpci) !== 'undefined';
    const rpciShort = hasValidRpci ? `RPCI ${Number(pciData.rpci).toFixed(1)}` : '';

    let mBanStr = '';
    if (horse && horse.past_races && horse.past_races[tabIndex]) {
        const prLines = horse.past_races[tabIndex].split('<br>');
        const horseInfoText = prLines[5] || '';
        const mBan = horseInfoText.match(/(\d+)番/);
        if (mBan) mBanStr = `${mBan[1]}番`;
    }

    const metaParts = [mBanStr, rpciShort, paceBadge].filter(Boolean);
    metaEl.innerHTML = metaParts.join(' ');

    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }

    if (!nbId || nbId === '動画なし') { showNoVideo('前走動画がありません'); return; }

    const filename = `${nbId}.mp4`;
    const slot = document.getElementById('video-slot');
    const actions = document.getElementById('video-actions');

    // --- IndexedDBキャッシュを確認 ---
    const cached = await localforage.getItem(`video_${nbId}`);
    if (cached) {
        currentBlobUrl = URL.createObjectURL(cached);
        slot.innerHTML = `<video controls playsinline webkit-playsinline preload="metadata"><source src="${currentBlobUrl}" type="video/mp4"></video>`;
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
        slot.innerHTML = `<video controls playsinline webkit-playsinline preload="metadata"><source src="${currentBlobUrl}" type="video/mp4"></video>`;
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
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`,
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
