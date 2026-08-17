// ============================================================
//  pwa_app/results_logic.js
//  レース結果・払戻金ダッシュボード ロジック
// ============================================================

let currentResultsTab = 'stats'; // 'stats' | 'races'

// 全券種リスト
const TICKET_TYPES = ["単勝", "複勝", "枠連", "馬連", "ワイド", "馬単", "三連複", "三連単"];

const TICKET_ICONS = {
    "単勝": "🎯", "複勝": "🥉", "枠連": "🔢", "馬連": "🐎",
    "ワイド": "↔️", "馬単": "🎯", "三連複": "☘️", "三連単": "👑"
};

/**
 * レース結果内部サブタブの切替
 */
function switchResultsTab(tabId) {
    currentResultsTab = tabId;
    document.querySelectorAll('.results-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.results-subview').forEach(s => s.classList.remove('active'));

    const tabEl = document.getElementById('rtab-' + tabId);
    if (tabEl) tabEl.classList.add('active');

    const subviewEl = document.getElementById('results-subview-' + tabId);
    if (subviewEl) subviewEl.classList.add('active');

    if (tabId === 'stats') {
        renderPayoffStats();
    } else if (tabId === 'races') {
        renderRecentRaces();
    }
}

/**
 * 券種別 平均・最高払戻金の集計・描画
 */
function renderPayoffStats() {
    const container = document.getElementById('payoff-stats-cards');
    if (!container) return;

    if (!window.RACE_RESULTS_DATA || !window.RACE_RESULTS_DATA.payoff_stats) {
        container.innerHTML = '<div class="placeholder-text">払戻金データを読み込み中...</div>';
        return;
    }

    const venue = document.getElementById('res-filter-venue').value;
    const surface = document.getElementById('res-filter-surface').value;
    const condition = document.getElementById('res-filter-condition').value;
    const cls = document.getElementById('res-filter-class').value;
    const distCat = document.getElementById('res-filter-distance').value;

    const data = window.RACE_RESULTS_DATA;
    const isDefaultFilter = !venue && !surface && !condition && !cls && !distCat;

    let stats = {};

    if (isDefaultFilter) {
        // 全体プリセット
        stats = data.payoff_stats.all || {};
    } else {
        // 対象レースを動的にフィルタリングしてリアルタイム集計
        let filteredRaces = data.races || [];

        if (venue) filteredRaces = filteredRaces.filter(r => r.venue === venue);
        if (surface) filteredRaces = filteredRaces.filter(r => r.surface === surface);
        if (condition) filteredRaces = filteredRaces.filter(r => r.condition === condition);
        if (cls) filteredRaces = filteredRaces.filter(r => r.class === cls);
        if (distCat) {
            filteredRaces = filteredRaces.filter(r => {
                const d = parseFloat(r.distance);
                if (isNaN(d)) return false;
                if (distCat === '短距離') return d <= 1400;
                if (distCat === 'マイル') return d > 1400 && d <= 1600;
                if (distCat === '中距離') return d > 1600 && d <= 2200;
                if (distCat === '長距離') return d > 2200;
                return true;
            });
        }

        // 動的集計
        const payoffsList = [];
        filteredRaces.forEach(r => {
            (r.payoffs || []).forEach(p => {
                payoffsList.push({
                    type: p.type,
                    pay: p.pay,
                    combo: p.combo,
                    pop: p.pop,
                    race: `${r.date} ${r.venue} ${r.race_num}R ${r.name}`
                });
            });
        });

        TICKET_TYPES.forEach(tName => {
            const sub = payoffsList.filter(p => p.type === tName);
            if (sub.length > 0) {
                const pays = sub.map(p => p.pay);
                const meanVal = Math.round(pays.reduce((a, b) => a + b, 0) / pays.length);
                let maxItem = sub[0];
                sub.forEach(p => { if (p.pay > maxItem.pay) maxItem = p; });

                stats[tName] = {
                    mean: meanVal,
                    max: maxItem.pay,
                    max_combo: maxItem.combo,
                    max_pop: maxItem.pop,
                    max_race: maxItem.race,
                    count: sub.length
                };
            }
        });
    }

    // カード描画
    let html = '';
    TICKET_TYPES.forEach(tName => {
        const item = stats[tName];
        const icon = TICKET_ICONS[tName] || '🎫';

        if (!item) {
            html += `
            <div class="glass-panel payoff-card disabled">
                <div class="payoff-card-header">
                    <span class="payoff-ticket-name">${icon} ${tName}</span>
                    <span class="payoff-count">該当データなし</span>
                </div>
            </div>`;
            return;
        }

        const meanFormatted = item.mean.toLocaleString();
        const maxFormatted = item.max.toLocaleString();
        const popBadge = item.max_pop ? `<span class="badge-pop">${item.max_pop}人気</span>` : '';

        html += `
        <div class="glass-panel payoff-card">
            <div class="payoff-card-header">
                <span class="payoff-ticket-name">${icon} ${tName}</span>
                <span class="payoff-count">${item.count.toLocaleString()} 件</span>
            </div>
            <div class="payoff-values-grid">
                <div class="payoff-val-box">
                    <span class="payoff-label">平均払戻額 (100円あたり)</span>
                    <span class="payoff-amount mean">${meanFormatted} <small>円</small></span>
                </div>
                <div class="payoff-val-box">
                    <span class="payoff-label">最高払戻額 (100円あたり)</span>
                    <span class="payoff-amount max">${maxFormatted} <small>円</small></span>
                </div>
            </div>
            <div class="payoff-max-info">
                <div class="payoff-max-combo">最高馬券: <strong>${item.max_combo}</strong> ${popBadge}</div>
                <div class="payoff-max-race">📍 ${item.max_race}</div>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

/**
 * 個別レース一覧の検索・描画
 */
function renderRecentRaces() {
    const container = document.getElementById('recent-races-list');
    if (!container) return;

    if (!window.RACE_RESULTS_DATA || !window.RACE_RESULTS_DATA.races) {
        container.innerHTML = '<div class="placeholder-text">レースデータを読み込み中...</div>';
        return;
    }

    const yearFilter = document.getElementById('res-race-year').value;
    const venueFilter = document.getElementById('res-race-venue').value;
    const keyword = document.getElementById('res-race-search').value.trim().toLowerCase();

    let races = window.RACE_RESULTS_DATA.races || [];

    if (yearFilter) races = races.filter(r => (r.date || r.id).startsWith(yearFilter));
    if (venueFilter) races = races.filter(r => r.venue === venueFilter);
    if (keyword) {
        races = races.filter(r =>
            r.name.toLowerCase().includes(keyword) ||
            r.winner.toLowerCase().includes(keyword) ||
            (r.results && r.results.some(h => h.name.toLowerCase().includes(keyword)))
        );
    }

    const displayRaces = races.slice(0, 100); // 性能確保のため上限100件表示

    if (displayRaces.length === 0) {
        container.innerHTML = '<div class="placeholder-text">該当するレースが見つかりません</div>';
        return;
    }

    let html = '';
    displayRaces.forEach(r => {
        // 単勝と三連単の払戻金を検索
        const tanshoPay = (r.payoffs || []).find(p => p.type === '単勝');
        const sanrenPay = (r.payoffs || []).find(p => p.type === '三連単');

        const tanStr = tanshoPay ? `${tanshoPay.pay.toLocaleString()}円` : '-';
        const sanStr = sanrenPay ? `${sanrenPay.pay.toLocaleString()}円` : '-';

        html += `
        <div class="glass-panel race-result-card" onclick="openRaceDetailModal('${r.id}')">
            <div class="rr-card-header">
                <span class="rr-date">${r.date || '日付不明'}</span>
                <span class="rr-venue-badge">${r.venue} ${r.race_num}R</span>
                <span class="rr-class-badge">${r.class}</span>
            </div>
            <div class="rr-title">${r.name}</div>
            <div class="rr-meta">
                <span>🚩 ${r.surface}${r.distance}m (${r.condition})</span>
                <span>⏱ 勝ちタイム: <strong>${r.win_time || '-'}</strong></span>
            </div>
            <div class="rr-winner-row">
                <span>🥇 1着: <strong>${r.winner}</strong></span>
                <span class="rr-horses-count">${r.horses_count}頭</span>
            </div>
            <div class="rr-payoffs-summary">
                <span>単勝: <strong class="text-gold">${tanStr}</strong></span>
                <span>三連単: <strong class="text-purple">${sanStr}</strong></span>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

/**
 * 個別レース詳細モーダルの表示
 */
function openRaceDetailModal(raceId) {
    if (!window.RACE_RESULTS_DATA || !window.RACE_RESULTS_DATA.races) return;

    const race = window.RACE_RESULTS_DATA.races.find(r => r.id === raceId);
    if (!race) return;

    // ヘッダー情報
    document.getElementById('m-race-title').textContent = `${race.venue}${race.race_num}R ${race.name}`;
    document.getElementById('m-race-date-meta').textContent = `${race.date || ''} | ${race.surface}${race.distance}m | 天候:${race.weather} | 馬場:${race.condition} | ${race.horses_count}頭`;

    // 着順テーブルの生成
    const resultsContainer = document.getElementById('m-race-results-table');
    if (race.results && race.results.length > 0) {
        let rowsHtml = '';
        race.results.forEach(h => {
            const rankCls = h.rank === '1' ? 'rank-1' : (h.rank === '2' ? 'rank-2' : (h.rank === '3' ? 'rank-3' : ''));
            rowsHtml += `
            <tr class="${rankCls}">
                <td class="cell-rank">${h.rank}</td>
                <td class="cell-post">${h.post}</td>
                <td class="cell-num">${h.num}</td>
                <td class="cell-name"><strong>${h.name}</strong><br><small class="text-muted">${h.sex_age} ${h.weight}kg</small></td>
                <td class="cell-jockey">${h.jockey}</td>
                <td class="cell-time">${h.time}<br><small class="text-muted">${h.margin}</small></td>
                <td class="cell-odds">${h.odds}<br><small class="text-muted">(${h.pop}人気)</small></td>
            </tr>`;
        });

        resultsContainer.innerHTML = `
        <table class="custom-results-table">
            <thead>
                <tr>
                    <th>着</th>
                    <th>枠</th>
                    <th>馬</th>
                    <th>馬名</th>
                    <th>騎手</th>
                    <th>タイム</th>
                    <th>オッズ</th>
                </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>`;
    } else {
        resultsContainer.innerHTML = '<div class="placeholder-text">着順詳細データがありません</div>';
    }

    // 払戻金テーブルの生成
    const payoffsContainer = document.getElementById('m-race-payoffs-table');
    if (race.payoffs && race.payoffs.length > 0) {
        let pRows = '';
        race.payoffs.forEach(p => {
            const popBadge = p.pop ? `<span class="badge-pop-sm">${p.pop}人気</span>` : '';
            pRows += `
            <tr>
                <td class="cell-ptype">${TICKET_ICONS[p.type] || ''} ${p.type}</td>
                <td class="cell-pcombo"><strong>${p.combo}</strong></td>
                <td class="cell-ppay"><strong>${p.pay.toLocaleString()}</strong> 円</td>
                <td class="cell-ppop">${popBadge}</td>
            </tr>`;
        });

        payoffsContainer.innerHTML = `
        <table class="custom-payoffs-table">
            <thead>
                <tr>
                    <th>券種</th>
                    <th>組合せ</th>
                    <th>払戻金</th>
                    <th>人気</th>
                </tr>
            </thead>
            <tbody>${pRows}</tbody>
        </table>`;
    } else {
        payoffsContainer.innerHTML = '<div class="placeholder-text">払戻金データがありません</div>';
    }

    // モーダル表示
    const modal = document.getElementById('modal-race-detail');
    if (modal) modal.classList.add('active');
}

function closeRaceDetailModal() {
    const modal = document.getElementById('modal-race-detail');
    if (modal) modal.classList.remove('active');
}
