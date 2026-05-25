// ============================================================
//  ボトムナビゲーション
// ============================================================
let currentMainView = 'race';

function switchMainView(view) {
    currentMainView = view;
    document.getElementById('bnav-race').classList.toggle('active', view === 'race');
    document.getElementById('bnav-bias').classList.toggle('active', view === 'bias');
    if (view === 'race') {
        navigate('dashboard');
    } else {
        navigate('bias');
        const dateEl = document.getElementById('bias-date-select');
        if (!dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
    }
}

// ============================================================
//  バイアス内部タブ切り替え
// ============================================================
let currentBiasTab = 'summary';

function switchBiasTab(tabId) {
    currentBiasTab = tabId;
    document.querySelectorAll('.bias-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.bias-subview').forEach(s => s.classList.remove('active'));
    const tabEl = document.getElementById('btab-' + tabId);
    if (tabEl) tabEl.classList.add('active');
    const subviewEl = document.getElementById('bias-subview-' + tabId);
    if (subviewEl) subviewEl.classList.add('active');
    const selectorArea = document.getElementById('bias-selector-area');
    selectorArea.style.display = (tabId === 'summary' || tabId === 'trend') ? 'flex' : 'none';
    if (tabId === 'wintime') renderWinningTime();
    if (tabId === 'summary' || tabId === 'trend') onBiasSelectorChange();
}

function onBiasSelectorChange() {
    const venue = document.getElementById('bias-venue-select').value;
    const date  = document.getElementById('bias-date-select').value;
    if (!venue) return;
    renderBiasSummary(venue, date);
    renderBiasTrend(venue, date);
}

// ============================================================
//  Phase 2 - サブビュー①: 開催別バイアスサマリー
// ============================================================
function renderBiasSummary(venue, date) {
    renderCushionSection(venue, date);
    renderWeatherSection(venue, date);
    renderFrameSection(venue);
}

function renderCushionSection(venue, date) {
    const el = document.getElementById('bias-cushion-content');
    const biasData = window.TRACK_BIAS_DATA || {};
    const dateData = (biasData.cushion || {})[date] || {};
    const data = dateData[venue] || null;

    if (!data) {
        el.innerHTML = '<div class="placeholder-text" style="margin:0;">この日の馬場データなし<br><small style="color:var(--text-muted);">collect_jra_track_pdf.py を実行してください</small></div>';
        return;
    }

    const cushion   = data.cushion != null ? data.cushion : null;
    const moistTurf = data.moisture_turf != null ? data.moisture_turf : null;
    const moistDirt = data.moisture_dirt != null ? data.moisture_dirt : null;

    let cushionBiasClass = 'bias-neutral', cushionBiasLabel = '標準';
    if (cushion !== null) {
        if (cushion >= 9.0) { cushionBiasClass = 'bias-inner'; cushionBiasLabel = '高速 → 内有利'; }
        else if (cushion < 7.0) { cushionBiasClass = 'bias-outer'; cushionBiasLabel = '低速 → 差し有利'; }
    }
    let dirtBiasClass = 'bias-neutral', dirtBiasLabel = '標準';
    if (moistDirt !== null) {
        if (moistDirt >= 10) { dirtBiasClass = 'bias-front'; dirtBiasLabel = '高め → 内前有利'; }
        else if (moistDirt < 6) { dirtBiasClass = 'bias-closer'; dirtBiasLabel = '低め → 差し有利'; }
    }

    const cushionColor = (cushion >= 9) ? '#34d399' : (cushion < 7) ? '#a78bfa' : '#f8fafc';
    const dirtColor    = (moistDirt >= 10) ? '#34d399' : (moistDirt < 6) ? '#a78bfa' : '#f8fafc';

    el.innerHTML =
        '<div class="track-gauge-grid">' +
            '<div class="track-gauge-item">' +
                '<div class="track-gauge-label">クッション値（芝）</div>' +
                '<div class="track-gauge-value" style="color:' + cushionColor + '">' + (cushion != null ? cushion : '—') + '</div>' +
                '<div class="track-gauge-unit">9.0以上で高速</div>' +
                '<div class="track-bias-label ' + cushionBiasClass + '">' + cushionBiasLabel + '</div>' +
            '</div>' +
            '<div class="track-gauge-item">' +
                '<div class="track-gauge-label">含水率 芝</div>' +
                '<div class="track-gauge-value">' + (moistTurf != null ? moistTurf : '—') + '</div>' +
                '<div class="track-gauge-unit">%</div>' +
            '</div>' +
            '<div class="track-gauge-item">' +
                '<div class="track-gauge-label">含水率 ダート</div>' +
                '<div class="track-gauge-value" style="color:' + dirtColor + '">' + (moistDirt != null ? moistDirt : '—') + '</div>' +
                '<div class="track-gauge-unit">%</div>' +
                '<div class="track-bias-label ' + dirtBiasClass + '">' + dirtBiasLabel + '</div>' +
            '</div>' +
        '</div>';
}

function renderWeatherSection(venue, date) {
    const el = document.getElementById('bias-weather-content');
    const biasData = window.TRACK_BIAS_DATA || {};
    const dateData = (biasData.weather || {})[date] || {};
    const dayWeather = dateData[venue] || null;

    if (!dayWeather || dayWeather.length === 0) {
        el.innerHTML = '<div class="placeholder-text" style="margin:0;">天気データなし<small style="display:block;color:var(--text-muted);">collect_weather.py を実行してください</small></div>';
        return;
    }

    const raceHours = dayWeather.filter(function(r) {
        const h = parseInt((r.time || '').split(':')[0]);
        return h >= 9 && h <= 18;
    });

    const biasCount = {};
    raceHours.forEach(function(r) {
        const b = r.wind_bias || '不明';
        biasCount[b] = (biasCount[b] || 0) + 1;
    });

    let dom = '不明';
    let maxCnt = 0;
    for (const k in biasCount) {
        if (biasCount[k] > maxCnt) { maxCnt = biasCount[k]; dom = k; }
    }

    const badgeMap = {'向かい風':'wind-badge-head','追い風':'wind-badge-tail','横風':'wind-badge-side','静穏（微風）':'wind-badge-calm'};
    const labelMap = {'向かい風':'↙ 向かい風 → 逃げ先行有利','追い風':'↗ 追い風 → 差し追い込み有利','横風':'↔ 横風','静穏（微風）':'〜 微風'};

    function weatherIcon(w) {
        if (!w) return '🌤';
        if (/rain|雨/.test(w)) return '🌧';
        if (/snow|雪/.test(w)) return '❄️';
        if (/cloud|曇/.test(w)) return '☁️';
        if (/clear|晴/.test(w)) return '☀️';
        return '🌤';
    }

    const timeline = raceHours.map(function(r) {
        return '<div class="weather-card">' +
            '<div class="weather-time">' + (r.time || '') + '</div>' +
            '<div class="weather-icon">' + weatherIcon(r.weather) + '</div>' +
            '<div class="weather-wind">' + (r.wind_dir || '') + '<br>' + (r.wind_speed != null ? r.wind_speed : '—') + 'm</div>' +
            '<div class="weather-precip">' + (r.precipitation > 0 ? r.precipitation + 'mm' : '') + '</div>' +
        '</div>';
    }).join('');

    el.innerHTML =
        '<div class="weather-timeline">' + timeline + '</div>' +
        '<div class="wind-bias-badge ' + (badgeMap[dom] || 'wind-badge-calm') + '">' + (labelMap[dom] || dom) + '</div>';
}

function renderFrameSection(venue) {
    const el = document.getElementById('bias-frame-content');
    const biasData = window.TRACK_BIAS_DATA || {};
    const frameData = (biasData.frame_stats || {})[venue] || null;

    if (!frameData) {
        el.innerHTML = '<div class="placeholder-text" style="margin:0;">データなし<small style="display:block;color:var(--text-muted);">track_bias_stats.py を実行してください</small></div>';
        return;
    }

    const rates = [];
    for (let f = 1; f <= 8; f++) {
        if (frameData[f]) rates.push(frameData[f].place_rate);
    }
    const maxRate = Math.max.apply(null, rates);
    const minRate = Math.min.apply(null, rates);

    let cells = '';
    for (let f = 1; f <= 8; f++) {
        const d = frameData[f];
        if (!d) {
            cells += '<div class="frame-cell frame-' + f + '"><div class="frame-num">' + f + '枠</div><div class="frame-rate">—</div></div>';
            continue;
        }
        const norm = maxRate > minRate ? (d.place_rate - minRate) / (maxRate - minRate) : 0.5;
        const alpha = 0.15 + norm * 0.5;
        let bg;
        if (norm > 0.6) bg = 'rgba(59,130,246,' + alpha + ')';
        else if (norm < 0.4) bg = 'rgba(139,92,246,' + alpha + ')';
        else bg = 'rgba(100,116,139,' + alpha + ')';
        cells += '<div class="frame-cell frame-' + f + '" style="background:' + bg + ';">' +
            '<div class="frame-num">' + f + '枠</div>' +
            '<div class="frame-rate">' + (d.place_rate * 100).toFixed(0) + '%</div>' +
        '</div>';
    }

    el.innerHTML =
        '<div class="frame-heatmap">' + cells + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:center;">青=高い 紫=低い（過去5年・連対率）</div>';
}

// ============================================================
//  Phase 2 - サブビュー②: 平均勝ち時計比較
// ============================================================
function renderWinningTime() {
    const venue     = document.getElementById('wt-venue').value;
    const surface   = document.getElementById('wt-surface').value;
    const condition = document.getElementById('wt-condition').value;
    const el = document.getElementById('wt-result-area');

    if (!venue) { el.innerHTML = '<div class="placeholder-text">会場を選択してください</div>'; return; }

    const biasData = window.TRACK_BIAS_DATA || {};
    const venueData = (biasData.winning_time || {})[venue] || {};
    const surfaceData = surface ? (venueData[surface] || {}) : venueData;

    const rows = [];
    function collectRows(sdObj) {
        for (const dist in sdObj) {
            const condMap = sdObj[dist];
            for (const cond in condMap) {
                if (condition && cond !== condition) continue;
                rows.push({ dist: parseInt(dist) || 0, cond: cond, avg: condMap[cond].avg, n: condMap[cond].n });
            }
        }
    }

    if (surface) {
        collectRows(venueData[surface] || {});
    } else {
        for (const surf in venueData) collectRows(venueData[surf]);
    }

    if (!rows.length) {
        el.innerHTML = '<div class="placeholder-text">対象データなし（notebooks/track_bias_stats.py --generate-js を実行してください）</div>';
        return;
    }

    rows.sort(function(a, b) { return a.dist - b.dist; });

    function secsToTime(s) {
        if (!s) return '—';
        const m = Math.floor(s / 60);
        const sec = (s % 60).toFixed(1);
        if (m > 0) { const p = sec.length < 4 ? '0' + sec : sec; return m + ':' + p; }
        return sec;
    }

    const tableRows = rows.map(function(r) {
        return '<tr><td>' + r.dist + 'm</td><td>' + r.cond + '</td><td>' + secsToTime(r.avg) + '</td><td style="color:var(--text-muted);font-size:11px;">n=' + r.n + '</td></tr>';
    }).join('');

    el.innerHTML =
        '<div class="glass-panel">' +
            '<table class="wt-table">' +
                '<thead><tr><th>距離</th><th>馬場</th><th>平均勝ち時計</th><th>件数</th></tr></thead>' +
                '<tbody>' + tableRows + '</tbody>' +
            '</table>' +
        '</div>';
}

// ============================================================
//  Phase 2 - サブビュー③: 時系列トレンド
// ============================================================
function renderBiasTrend(venue, date) {
    const el = document.getElementById('bias-trend-content');
    const biasData = window.TRACK_BIAS_DATA || {};
    const allCushion = biasData.cushion || {};

    const entries = [];
    for (const d in allCushion) {
        if (allCushion[d][venue]) {
            entries.push({ date: d, cushion: allCushion[d][venue].cushion, moisture_turf: allCushion[d][venue].moisture_turf });
        }
    }
    entries.sort(function(a, b) { return a.date.localeCompare(b.date); });

    if (!entries.length) {
        el.innerHTML = '<div class="placeholder-text" style="margin:0;">データなし</div>';
        document.getElementById('bias-trend-canvas').style.display = 'none';
        return;
    }

    const recent = entries.slice(-30);
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">直近' + recent.length + '日（' + recent[0].date + '〜' + recent[recent.length - 1].date + '）</div>';

    const canvas = document.getElementById('bias-trend-canvas');
    canvas.style.display = 'block';
    canvas.width = canvas.offsetWidth || 340;
    canvas.height = 150;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const vals = recent.map(function(d) { return d.cushion; }).filter(function(v) { return v != null; });
    if (!vals.length) {
        el.innerHTML += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">クッション値データなし</div>';
        return;
    }

    const cMin = Math.min.apply(null, vals) - 0.5;
    const cMax = Math.max.apply(null, vals) + 0.5;
    const pad = { l: 34, r: 10, t: 16, b: 28 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const n = recent.length;
    const xSt = pw / Math.max(n - 1, 1);
    const toX = function(i) { return pad.l + i * xSt; };
    const toYc = function(v) { return pad.t + ph - ((v - cMin) / (cMax - cMin)) * ph; };

    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = pad.t + (i / 3) * ph;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    }

    ctx.beginPath(); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2.5;
    let started = false;
    recent.forEach(function(d, i) {
        const v = d.cushion;
        if (v == null) { started = false; return; }
        if (!started) { ctx.moveTo(toX(i), toYc(v)); started = true; }
        else ctx.lineTo(toX(i), toYc(v));
    });
    ctx.stroke();

    recent.forEach(function(d, i) {
        const v = d.cushion;
        if (v == null) return;
        ctx.beginPath(); ctx.arc(toX(i), toYc(v), 3, 0, Math.PI * 2);
        ctx.fillStyle = '#3b82f6'; ctx.fill();
    });

    ctx.fillStyle = 'rgba(148,163,184,0.8)'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    for (let i = 0; i <= 2; i++) {
        const v = cMin + (i / 2) * (cMax - cMin);
        ctx.fillText(v.toFixed(1), pad.l - 2, toYc(v) + 3);
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#3b82f6'; ctx.font = '10px sans-serif';
    ctx.fillRect(pad.l, 4, 12, 3); ctx.fillText('クッション値', pad.l + 14, 11);
}

// ============================================================
//  Phase 3 - 当日天気自動取得（OpenWeatherMap）
// ============================================================
const VENUE_COORDS = {
    '東京':  { lat: 35.761, lon: 139.512, straight: 0 },
    '中山':  { lat: 35.769, lon: 139.977, straight: 0 },
    '阪神':  { lat: 34.753, lon: 135.348, straight: 0 },
    '京都':  { lat: 34.853, lon: 135.736, straight: 0 },
    '中京':  { lat: 35.132, lon: 136.966, straight: 315 },
    '新潟':  { lat: 37.888, lon: 139.070, straight: 45 },
    '福島':  { lat: 37.720, lon: 140.476, straight: 135 },
    '小倉':  { lat: 33.862, lon: 130.866, straight: 0 },
    '札幌':  { lat: 43.057, lon: 141.344, straight: 180 },
    '函館':  { lat: 41.769, lon: 140.729, straight: 135 },
};

let todayWeatherCache = {};

const OPEN_METEO_WEATHER_CODES = {
    0: '晴れ',
    1: '晴れ', 2: '曇り', 3: '曇り',
    45: '霧', 48: '霧',
    51: '小雨', 53: '小雨', 55: '小雨',
    56: 'みぞれ', 57: 'みぞれ',
    61: '雨', 63: '雨', 65: '強い雨',
    66: 'みぞれ', 67: '強いみぞれ',
    71: '雪', 73: '雪', 75: '強い雪',
    77: '雪',
    80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨',
    85: 'にわか雪', 86: '激しいにわか雪',
    95: '雷雨', 96: '雷雨', 99: '雷雨'
};

async function fetchTodayWeather() {
    const venue = document.getElementById('today-venue').value;
    const el = document.getElementById('today-weather-content');
    if (!venue) return;

    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">天気を取得中...</div>';
    const cacheKey = 'weather_' + venue + '_' + new Date().toISOString().slice(0, 13);
    if (todayWeatherCache[cacheKey]) { renderTodayWeather(venue, todayWeatherCache[cacheKey]); return; }

    const coords = VENUE_COORDS[venue];
    if (!coords) { el.innerHTML = '<div class="placeholder-text" style="margin:0;">会場座標未登録</div>'; return; }

    try {
        const url = 'https://api.open-meteo.com/v1/forecast' +
            '?latitude=' + coords.lat + '&longitude=' + coords.lon +
            '&hourly=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,weather_code&timezone=Asia/Tokyo';
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();

        const hourly = data.hourly || {};
        const times = hourly.time || [];
        const temps = hourly.temperature_2m || [];
        const precips = hourly.precipitation || [];
        const windSpeeds = hourly.wind_speed_10m || [];
        const windDirs = hourly.wind_direction_10m || [];
        const codes = hourly.weather_code || [];

        let records = [];
        for (let i = 0; i < times.length; i++) {
            const dtStr = times[i];
            const hh = parseInt(dtStr.split('T')[1].split(':')[0]);
            
            // 9時から20時までのレース時間帯に絞る
            if (hh >= 9 && hh <= 20) {
                const temp = temps[i] != null ? temps[i] : null;
                const precip = precips[i] != null ? precips[i] : 0;
                const windSpeedKmh = windSpeeds[i] != null ? windSpeeds[i] : 0;
                // km/h から m/s に変換 (1 m/s = 3.6 km/h)
                const windSpeedMs = Math.round((windSpeedKmh / 3.6) * 10) / 10;
                const windDeg = windDirs[i] != null ? windDirs[i] : null;
                const code = codes[i] != null ? codes[i] : 0;
                const weatherDesc = OPEN_METEO_WEATHER_CODES[code] || '不明';

                records.push({
                    time: (hh < 10 ? '0' + hh : '' + hh) + ':00',
                    weather: weatherDesc,
                    wind_dir: (windDeg != null ? windDeg : '—') + '°',
                    wind_speed: windSpeedMs,
                    wind_bias: judgeWindBias(windDeg, coords.straight),
                    precipitation: precip,
                    temperature: temp,
                });
            }
        }

        todayWeatherCache[cacheKey] = records;
        renderTodayWeather(venue, records);
        calcTodayBias();
    } catch (err) {
        el.innerHTML = '<div class="placeholder-text" style="margin:0;">取得失敗: ' + err.message + '</div>';
    }
}

function judgeWindBias(windDeg, straightDir) {
    if (windDeg == null) return '静穏（微風）';
    const diff = ((windDeg - straightDir) % 360 + 360) % 360;
    if (diff <= 45 || diff >= 315) return '向かい風';
    if (diff >= 135 && diff <= 225) return '追い風';
    return '横風';
}

function renderTodayWeather(venue, records) {
    const el = document.getElementById('today-weather-content');
    if (!records.length) { el.innerHTML = '<div class="placeholder-text" style="margin:0;">取得データなし</div>'; return; }

    const biasCount = {};
    records.forEach(function(r) { const b = r.wind_bias || '不明'; biasCount[b] = (biasCount[b] || 0) + 1; });
    let dom = '不明', maxCnt = 0;
    for (const k in biasCount) { if (biasCount[k] > maxCnt) { maxCnt = biasCount[k]; dom = k; } }

    const badgeMap = {'向かい風':'wind-badge-head','追い風':'wind-badge-tail','横風':'wind-badge-side','静穏（微風）':'wind-badge-calm'};
    const labelMap = {'向かい風':'↙ 向かい風 → 逃げ先行有利','追い風':'↗ 追い風 → 差し追い込み有利','横風':'↔ 横風','静穏（微風）':'〜 微風'};

    function weatherIcon(w) {
        if (!w) return '🌤';
        if (/rain|雨/.test(w)) return '🌧';
        if (/snow|雪/.test(w)) return '❄️';
        if (/cloud|曇/.test(w)) return '☁️';
        if (/clear|晴/.test(w)) return '☀️';
        return '🌤';
    }

    const timeline = records.map(function(r) {
        return '<div class="weather-card">' +
            '<div class="weather-time">' + r.time + '</div>' +
            '<div class="weather-icon">' + weatherIcon(r.weather) + '</div>' +
            '<div class="weather-wind">' + (r.wind_speed != null ? r.wind_speed : '—') + 'm</div>' +
            '<div class="weather-precip">' + (r.precipitation > 0 ? r.precipitation.toFixed(1) + 'mm' : '') + '</div>' +
        '</div>';
    }).join('');

    el.innerHTML =
        '<div class="weather-timeline">' + timeline + '</div>' +
        '<div class="wind-bias-badge ' + (badgeMap[dom] || 'wind-badge-calm') + '">' + (labelMap[dom] || dom) + '</div>';
}

// ============================================================
//  Phase 3 - 総合バイアス判定（5段階ゲージ）
// ============================================================
function calcTodayBias() {
    const venue     = document.getElementById('today-venue').value;
    const el        = document.getElementById('today-bias-gauge-area');
    const cushion   = parseFloat(document.getElementById('input-cushion').value);
    const moistDirt = parseFloat(document.getElementById('input-moisture-dirt').value);
    const timeDiff  = parseFloat(document.getElementById('input-time-diff').value);

    let score = 0;
    const chips = [];

    // クッション値判定
    if (!isNaN(cushion)) {
        if (cushion >= 9.5)       { score -= 2;   chips.push({ label: 'クッション' + cushion + '→高速内有利', cls: 'positive' }); }
        else if (cushion >= 9.0)  { score -= 1;   chips.push({ label: 'クッション' + cushion + '→やや内有利', cls: 'positive' }); }
        else if (cushion < 7.0)   { score += 2;   chips.push({ label: 'クッション' + cushion + '→低速差し有利', cls: 'negative' }); }
        else if (cushion < 7.5)   { score += 1;   chips.push({ label: 'クッション' + cushion + '→やや差し有利', cls: 'negative' }); }
        else                       { chips.push({ label: 'クッション' + cushion + '→標準', cls: 'neutral' }); }
    }

    // ダート含水率判定
    if (!isNaN(moistDirt)) {
        if (moistDirt >= 12)      { score -= 1.5; chips.push({ label: 'ダート含水' + moistDirt + '%→内前有利', cls: 'positive' }); }
        else if (moistDirt >= 10) { score -= 0.5; chips.push({ label: 'ダート含水' + moistDirt + '%→やや前有利', cls: 'positive' }); }
        else if (moistDirt < 5)   { score += 1;   chips.push({ label: 'ダート含水' + moistDirt + '%→差し有利', cls: 'negative' }); }
    }

    // 天気（風バイアス）
    const cacheKey = 'weather_' + venue + '_' + new Date().toISOString().slice(0, 13);
    const weatherData = todayWeatherCache[cacheKey] || [];
    if (weatherData.length > 0) {
        const biasCount = {};
        weatherData.forEach(function(r) { const b = r.wind_bias || '不明'; biasCount[b] = (biasCount[b] || 0) + 1; });
        let dom = '不明', maxCnt = 0;
        for (const k in biasCount) { if (biasCount[k] > maxCnt) { maxCnt = biasCount[k]; dom = k; } }
        if (dom === '向かい風') { score -= 0.5; chips.push({ label: '向かい風→前有利', cls: 'positive' }); }
        else if (dom === '追い風') { score += 0.5; chips.push({ label: '追い風→差し有利', cls: 'negative' }); }
    }

    // 勝ち時計補正
    if (!isNaN(timeDiff)) {
        if (timeDiff <= -0.5)     { score -= 1; chips.push({ label: '時計' + timeDiff + '秒→高速', cls: 'positive' }); }
        else if (timeDiff >= 0.5) { score += 1; chips.push({ label: '時計+' + timeDiff + '秒→低速', cls: 'negative' }); }
    }

    if (!chips.length) {
        el.innerHTML = '<div class="placeholder-text" style="margin:0;">数値を入力してください</div>';
        return;
    }

    // スコアを 0〜100% に正規化（-4〜+4 の範囲を想定）
    const norm = Math.max(0, Math.min(100, ((score + 4) / 8) * 100));

    let verdict = '';
    if      (score <= -2)   verdict = '🟦 内・前有利（強）';
    else if (score <= -0.75) verdict = '🔵 内・前有利（中）';
    else if (score <=  0.75) verdict = '⬜ ほぼ中立';
    else if (score <=  2)   verdict = '🟣 外・差し有利（中）';
    else                    verdict = '🟪 外・差し有利（強）';

    const chipsHtml = chips.map(function(c) {
        return '<div class="bias-chip ' + c.cls + '">' + c.label + '</div>';
    }).join('');

    el.innerHTML =
        '<div style="font-size:18px;font-weight:800;margin-bottom:12px;">' + verdict + '</div>' +
        '<div class="bias-gauge-container">' +
            '<div class="bias-gauge-track">' +
                '<div class="bias-gauge-needle" style="left:' + norm + '%"></div>' +
            '</div>' +
            '<div class="bias-gauge-labels">' +
                '<span>◀ 内有利</span><span>中立</span><span>外有利 ▶</span>' +
            '</div>' +
        '</div>' +
        '<div class="bias-summary-chips">' + chipsHtml + '</div>';
}

// ============================================================
//  バイアスデータ再読み込み
// ============================================================
async function reloadBiasData() {
    if (typeof syncDataFromDrive === 'function' && typeof accessToken !== 'undefined' && accessToken) {
        showToast('🔄 Google Driveから最新のバイアスデータを取得中...');
        await syncDataFromDrive();
        showToast('✅ バイアスデータを更新しました');
        onBiasSelectorChange();
    } else {
        showToast('⚠️ 先にログインして同期を行ってください');
    }
}
