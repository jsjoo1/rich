let transactions = [];
if (typeof initialTransactions !== 'undefined') { transactions = [...initialTransactions]; }
let savedTxs = JSON.parse(localStorage.getItem('mySavedTxs') || '[]');
if (localStorage.getItem('mySavedTxs')) { transactions = [...savedTxs]; } else { transactions = [...savedTxs, ...transactions]; }

let loans = JSON.parse(localStorage.getItem('myLoans') || '[]');
loans = loans.map(l => {
    if(!l.id) l.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    if(!l.records) { l.records = []; if(l.amount && Number(l.amount) > 0) { l.records.push({id: Date.now().toString(), date: l.startDate || new Date().toISOString().split('T')[0], amount: Number(l.amount)}); } }
    if(!l.kind) l.kind = '일반';   // 기존 대출은 '일반'으로 간주
    return l;
});
localStorage.setItem('myLoans', JSON.stringify(loans));

let modal = null; let selectedStock = null; let searchText = ''; let sortBy = 'invested_desc'; let viewMode = 'list'; let chartInstance = null;
let currentPrices = {}; let currentUsdKrw = 1300.0;
let priceStatus = { ok: true, msg: '', missing: [] }; let lastPriceUpdate = null;
let tickerMap = {};
transactions.forEach(tx => { if (tx.name && tx.code) tickerMap[tx.name] = tx.code.trim(); });

function isTxOverseas(tx) {
    if (!tx) return false;
    if (tx.exchangeRate > 100) return true;
    if (tx.type && tx.type.includes('해외')) return true;
    if (tx.name === '달러') return true;
    if (tx.type === '주식') { if (tx.code && (tx.code.includes('KRX') || tx.code.includes('KOSDAQ'))) return false; return true; }
    return false;
}

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx9u7YR3LDC_8ELh3hBiKOu7Grq2vv4IB7tZU3MfMg-bXcoIxnQpAXcwdMJ_qVoxEPjHA/exec"; 

function num(n) { 
    if(isNaN(n) || !isFinite(n)) return "0";
    return Math.round(n).toLocaleString('ko-KR'); 
}
function usd(n) { 
    if(isNaN(n) || !isFinite(n)) return "$0.00";
    return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); 
}
function getColorClass(val) { if (val > 0) return 'c-up'; if (val < 0) return 'c-down'; return 'c-even'; }
function getSign(val) { return val > 0 ? '+' : ''; }

// 이자 계산용 경과일수. 타임존 영향을 없애기 위해 날짜(연·월·일)만으로 비교한다.
// 당일 실행 건은 0일로 처리하여 1일치 이자 과대계상을 방지한다.
function daysBetween(fromStr, toDate) {
    const p = String(fromStr).split('-').map(Number);
    if (p.length < 3 || isNaN(p[0])) return 0;
    const a = Date.UTC(p[0], p[1] - 1, p[2]);
    const b = Date.UTC(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.max(0, Math.round((b - a) / 86400000));
}


// ── 시세 조회 대상 티커 산출 ───────────────────────────────
// code 가 있는 종목만 조회한다. (한글 종목명을 야후에 던지면 무조건 실패)
function getPriceTickers() {
    let validTxs = transactions.filter(t => {
        if (!t.type && !t.name) return false;
        let type = (t.type || '').toLowerCase();
        let name = (t.name || '').toLowerCase();
        if (type.includes('코인') || name.includes('krw') || name.includes('현금') || name.includes('달러')) return false;
        if (type.includes('손익') || type.includes('분배') || type.includes('배당')) return false;
        return true;
    });
    return [...new Set(
        validTxs
            // code 우선, 없으면 name 사용. 단 정규식으로 티커 형태만 통과시킨다.
            // (한글 종목명은 정규식에서 걸러지므로 야후에 잘못 질의되지 않음)
            .map(t => (t.code || t.name || '').trim())
            .filter(c => c && /^([A-Za-z0-9.\-]{1,10}|(KRX|KOSDAQ):[A-Za-z0-9]{6})$/.test(c))
    )];
}

// ── 환율: 여러 소스를 순차 폴백 ─────────────────────────────
const FX_SOURCES = [
    { url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW', pick: d => d?.rates?.KRW },
    { url: 'https://api.frankfurter.app/latest?from=USD&to=KRW',         pick: d => d?.rates?.KRW },
    { url: 'https://open.er-api.com/v6/latest/USD',                      pick: d => d?.rates?.KRW }
];

async function fetchUsdKrw() {
    for (const s of FX_SOURCES) {
        try {
            const res = await fetch(s.url, { cache: 'no-store' });
            if (!res.ok) continue;
            const v = s.pick(await res.json());
            if (v && isFinite(v)) { currentUsdKrw = Number(v); return true; }
        } catch (e) { /* 다음 소스로 */ }
    }
    console.warn('[FX] 모든 환율 소스 실패 — 직전 값 유지:', currentUsdKrw);
    return false;
}

async function fetchHistoricalRate(dateStr) {
    const urls = [
        `https://api.frankfurter.dev/v1/${dateStr}?base=USD&symbols=KRW`,
        `https://api.frankfurter.app/${dateStr}?from=USD&to=KRW`
    ];
    for (const u of urls) {
        try {
            const res = await fetch(u);
            if (!res.ok) continue;
            const d = await res.json();
            if (d?.rates?.KRW) return d.rates.KRW;
        } catch (e) { /* 다음 */ }
    }
    return null;
}

// ── 시세 조회 ─────────────────────────────────────────────
async function fetchPrices() {
    const tickers = getPriceTickers();
    if (!GAS_API_URL || !GAS_API_URL.startsWith('http') || tickers.length === 0) return;

    const url = GAS_API_URL + '?tickers=' + encodeURIComponent(tickers.join(','));
    let res;
    try {
        res = await fetch(url, { cache: 'no-store' });
    } catch (e) {
        priceStatus = { ok: false, msg: '시세 서버에 연결하지 못했습니다(네트워크/CORS).' };
        console.error('[PRICE] fetch 실패:', e);
        return;
    }
    if (!res.ok) {
        priceStatus = { ok: false, msg: '시세 서버 오류 HTTP ' + res.status };
        console.error('[PRICE] HTTP', res.status);
        return;
    }

    let data;
    try { data = await res.json(); }
    catch (e) {
        priceStatus = { ok: false, msg: '시세 서버가 JSON이 아닌 응답을 반환했습니다(배포 권한 확인 필요).' };
        console.error('[PRICE] JSON 파싱 실패:', e);
        return;
    }

    if (data.error) {
        priceStatus = { ok: false, msg: '시세 서버 오류: ' + data.error };
        console.error('[PRICE] 서버 오류:', data);
        return;
    }

    const result = data.data || data.result || {};
    Object.assign(currentPrices, result);

    const missing = data.missing || tickers.filter(t => currentPrices[t] === undefined);
    priceStatus = {
        ok: missing.length === 0,
        msg: missing.length === 0 ? '' : `시세 미수신 ${missing.length}종목: ${missing.join(', ')}`,
        missing
    };
    if (missing.length) console.warn('[PRICE] 미수신:', missing);
    else console.log('[PRICE] 전체 정상 (' + tickers.length + '종목)');
}

async function updatePricesInBackground() {
    await Promise.all([ fetchUsdKrw(), fetchPrices() ]);
    lastPriceUpdate = new Date();
    render();
}

async function initApp() {
    const app = document.getElementById('app');
    app.innerHTML = `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:80vh; gap:16px;">
        <div style="font-size:16px; font-weight:700; color:var(--text-soft);">실시간 주가 정보를 불러오는 중입니다...</div>
    </div>`;

    let loaded = false;
    let timeout = setTimeout(() => { if (!loaded) { loaded = true; render(); } }, 10000);
    
    await updatePricesInBackground();
    
    if (!loaded) { loaded = true; clearTimeout(timeout); render(); }
    
    // 💡 핵심: API 쿼터 초과 방지를 위해 60초 간격으로 갱신 주기 연장
    setInterval(updatePricesInBackground, 180000);
}

function render() {
    let focusedElementId = null; let cursorPosition = 0;
    if (document.activeElement && document.activeElement.id) { focusedElementId = document.activeElement.id; try { cursorPosition = document.activeElement.selectionStart || 0; } catch(e){} }
    let tempInputs = {};
    document.querySelectorAll('input, select').forEach(el => { if(el.id && el.type !== 'file') tempInputs[el.id] = el.value; });

    let scrollY = window.scrollY;
    let sheetScroll = document.getElementById('modalSheet') ? document.getElementById('modalSheet').scrollTop : 0;
    let loanListScroll = document.getElementById('loanListScroll') ? document.getElementById('loanListScroll').scrollTop : 0;

    const app = document.getElementById('app'); const today = new Date();
    let totalInvested = 0; let accruedInterest = 0; let totalCurrentValue = 0; let portfolio = {};
    
    loans.forEach(loan => { 
        loan.records.forEach(rec => { 
            let diffDays = daysBetween(rec.date, today); 
            accruedInterest += rec.amount * (loan.rate / 100) / 365 * diffDays; 
        }); 
    });

    transactions.forEach(tx => {
        let isOverseas = isTxOverseas(tx);
        let amountKRW = isOverseas ? (tx.quantity * tx.price * tx.exchangeRate) : (tx.quantity * tx.price);
        
        let tickerKey = (tx.code || tx.name).trim();
        let shortCode = tickerKey.replace('KRX:', '').replace('KOSDAQ:', '');
        
        let curPriceRaw = currentPrices[tickerKey] || currentPrices[shortCode] || currentPrices[tx.name.trim()] || tx.price;
        
        let curAmountKRW = isOverseas ? (tx.quantity * curPriceRaw * currentUsdKrw) : (tx.quantity * curPriceRaw);

        if(!portfolio[tx.name]) {
            portfolio[tx.name] = { 
                type: tx.type, tickerKey: tickerKey, code: tx.code, 
                quantity: 0, totalAmountKRW: 0, totalAmountOriginal: 0, 
                currentValueKRW: 0, isOverseas: isOverseas 
            };
        }
        portfolio[tx.name].quantity += tx.quantity; 
        portfolio[tx.name].totalAmountOriginal += (tx.quantity * tx.price); 
        portfolio[tx.name].totalAmountKRW += amountKRW; 
        portfolio[tx.name].currentValueKRW += curAmountKRW;

        totalInvested += amountKRW; 
        totalCurrentValue += curAmountKRW;
    });

    let marketProfit = totalCurrentValue - totalInvested; 
    let netProfit = marketProfit - accruedInterest; 
    let realReturnRate = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;

    let activeStocks = Object.keys(portfolio).filter(name => portfolio[name].quantity > 0.0001 && name.toLowerCase().includes(searchText.toLowerCase()));
    activeStocks.sort((a,b) => {
        let pA = portfolio[a]; let pB = portfolio[b];
        if (sortBy === 'name_asc') return a.localeCompare(b);
        if (sortBy === 'invested_desc') return pB.totalAmountKRW - pA.totalAmountKRW;
        if (sortBy === 'value_desc') return pB.currentValueKRW - pA.currentValueKRW;
        return 0;
    });

    let html = `
        ${priceStatus.ok ? '' : `<div style="background:rgba(255,90,90,0.12); border:1px solid rgba(255,90,90,0.35); color:#ff8f8f; padding:10px 12px; border-radius:10px; font-size:12px; margin-bottom:12px; line-height:1.5;">⚠️ ${priceStatus.msg}</div>`}
        <div class="kw-summary">
            <div class="kw-summary-title">
                총 실질손익(원) 
                <span style="font-size:11px; color:var(--text-soft); font-weight:400; margin-left:6px; background:var(--surface-sub); padding:2px 6px; border-radius:4px;">*대출이자 차감</span>
            </div>
            <div class="kw-summary-main ${getColorClass(netProfit)}">
                <div class="val">${getSign(netProfit)}${num(netProfit)}</div>
                <div class="pct">${getSign(netProfit)}${realReturnRate.toFixed(2)}%</div>
            </div>
            <div class="kw-summary-grid">
                <div class="kw-sg-item"><span class="lbl">매입금액</span><span class="val">${num(totalInvested)}</span></div>
                <div class="kw-sg-item"><span class="lbl">평가금액</span><span class="val">${num(totalCurrentValue)}</span></div>
                <div class="kw-sg-item"><span class="lbl">시세단순손익</span><span class="val ${getColorClass(marketProfit)}">${getSign(marketProfit)}${num(marketProfit)}</span></div>
                <div class="kw-sg-item" style="cursor:pointer;" onclick="window.openLoanModal()">
                    <span class="lbl" style="color:var(--primary); font-weight:700;">누적대출이자 ⚙️ 관리</span>
                    <span class="val" style="color:var(--text-soft);">- ${num(accruedInterest)}</span>
                </div>
            </div>
        </div>
        
        <div class="page" style="padding:0;">
            <div class="portfolio-tools">
                <div class="view-toggles">
                    <button class="${viewMode === 'list' ? 'active' : ''}" onclick="window.setViewMode('list')">일반 잔고</button>
                    <button class="${viewMode === 'chart' ? 'active' : ''}" onclick="window.setViewMode('chart')">파이 차트</button>
                </div>
                <div class="filter-sort-row" style="display:flex; gap:8px;">
                    <button onclick="window.openDataModal()" style="background:var(--surface-sub); border:none; color:var(--text); padding:0 12px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer;">💾 데이터 관리</button>
                    <input type="text" id="searchInput" placeholder="종목명 검색..." value="${searchText}" oninput="window.setSearchText(this.value)" style="flex:1;">
                    <select id="sortSelect" onchange="window.setSortBy(this.value)">
                        <option value="invested_desc" ${sortBy === 'invested_desc' ? 'selected' : ''}>매입금액순</option>
                        <option value="value_desc" ${sortBy === 'value_desc' ? 'selected' : ''}>평가금액순</option>
                        <option value="name_asc" ${sortBy === 'name_asc' ? 'selected' : ''}>종목명순</option>
                    </select>
                </div>
            </div>
    `;

    if (viewMode === 'list') {
        html += `
            <div class="kw-table">
                <div class="kw-header">
                    <div class="col-name">종목명(보유수량)</div>
                    <div class="col-price">현재가<br>평균단가</div>
                    <div class="col-pnl">평가손익<br>수익률</div>
                    <div class="col-amt">평가금액<br>매입금액</div>
                </div>
        `;
        activeStocks.forEach(name => {
            let p = portfolio[name];
            let avgPriceOriginal = p.totalAmountOriginal / p.quantity;
            let displayAvgPrice = p.isOverseas ? usd(avgPriceOriginal) : num(avgPriceOriginal);
            
            let curPriceRaw = currentPrices[p.tickerKey] || currentPrices[p.tickerKey.replace('KRX:','').replace('KOSDAQ:','')] || avgPriceOriginal;
            let displayCurPrice = p.isOverseas ? usd(curPriceRaw) : num(curPriceRaw);
            
            let stockProfitKRW = p.currentValueKRW - p.totalAmountKRW;
            let stockReturnRate = p.totalAmountKRW > 0 ? (stockProfitKRW / p.totalAmountKRW) * 100 : 0;
            let pColor = getColorClass(stockProfitKRW);
            let pSign = getSign(stockProfitKRW);

            html += `
                <div class="kw-row" onclick="window.openStockDetail('${name}')">
                    <div class="col-name">
                        <span style="font-size:14px;">${name}</span>
                        <span class="ticker">${p.quantity.toLocaleString('en-US', {maximumFractionDigits:4})}주</span>
                    </div>
                    <div class="col col-price">
                        <span class="${pColor}">${displayCurPrice}</span>
                        <span style="color:var(--text-soft); font-size:12px;">${displayAvgPrice}</span>
                    </div>
                    <div class="col ${pColor}">
                        <span>${pSign}${num(stockProfitKRW)}</span>
                        <span>${pSign}${stockReturnRate.toFixed(2)}%</span>
                    </div>
                    <div class="col col-amt">
                        <span class="${pColor}">${num(p.currentValueKRW)}</span>
                        <span style="color:var(--text-soft); font-size:12px;">${num(p.totalAmountKRW)}</span>
                    </div>
                </div>
            `;
        });
        if(activeStocks.length === 0) {
            html += `<div style="text-align:center; padding: 40px 0; color: var(--text-soft); font-size:14px;">조건에 맞는 종목이 없습니다.</div>`;
        }
        html += `</div>`;
    } else if (viewMode === 'chart') {
        html += `
            <div class="chart-container">
                ${activeStocks.length > 0 ? '<canvas id="portfolioChart"></canvas>' : '<div style="color:var(--text-soft); font-size:14px;">표시할 데이터가 없습니다.</div>'}
            </div>
        `;
    }
    html += `</div>`;
    html += `<button class="fab" id="fabAdd">+</button>`;

    let loanOptions = loans.length > 0 
        ? loans.map(l => `<option value="${l.id}">${l.name}</option>`).join('')
        : `<option value="" disabled selected>등록된 대출이 없습니다</option>`;

    if (modal === 'data') {
        html += `
            <div class="overlay" id="ovData">
                <div class="sheet" id="modalSheet">
                    <div class="sheet-title">💾 데이터 관리<button class="close" onclick="window.closeModal()">✕</button></div>
                    <div style="background:var(--surface-sub); padding:16px; border-radius:12px; margin-bottom:20px; font-size:13px; color:var(--text-soft); line-height:1.6;">
                        <span style="color:var(--primary); font-weight:800; font-size:14px;">📊 엑셀/CSV 일괄 업로드</span><br><br>
                        지원 확장자: <b>.xlsx, .xls, .csv</b><br>
                        컬럼: 날짜 / 구분 / 종목명 / 코드 / 수량 / 단가 / 환율 / <b style="color:var(--primary);">대출명</b><br>
                        <span style="font-size:12px;">※ <b>대출명</b>을 적으면 해당 대출의 인출로 자동 기록됩니다(매도는 상환). 대출은 '대출 관리'에서 먼저 등록하세요.</span><br>
                        <button class="primary-btn" onclick="window.downloadTemplate()" style="margin:8px 0; background:var(--surface); border:1px solid var(--primary); color:var(--primary);">📥 양식 다운로드</button>
                    </div>
                    <input type="file" id="fileUpload" accept=".csv, .xlsx, .xls" style="display:none;" onchange="window.handleFileUpload(event)">
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        <button class="primary-btn" onclick="document.getElementById('fileUpload').click()" style="margin:0; background:var(--primary); color:#fff; font-weight:800;">데이터 파일 업로드</button>
                        <button class="primary-btn" onclick="window.exportData()" style="margin:0; background:var(--surface); border:1px solid var(--primary); color:var(--primary); font-weight:800;">💾 현재 데이터 내보내기 (백업)</button>
                        <div style="border-top:1px dashed var(--line); margin:8px 0 4px;"></div>
                        <button class="primary-btn" onclick="window.resetPortfolio()" style="margin:0; background:transparent; border:1px solid var(--line); color:var(--text-soft); font-weight:700;">거래내역만 초기화 <span style="font-size:11px; font-weight:400;">(대출 보존)</span></button>
                        <button class="primary-btn" onclick="window.resetAll()" style="margin:0; background:transparent; border:1px solid var(--danger); color:var(--danger); font-weight:800;">🚨 전체 초기화 (대출 포함)</button>
                        <div style="font-size:11px; color:var(--text-soft); line-height:1.6; margin-top:4px;">
                            ※ 데이터는 이 브라우저에만 저장됩니다. 브라우저의 사이트 데이터를 삭제하거나 다른 기기에서 접속하면 내역이 보이지 않으므로, 주기적으로 백업을 내려받아 두시기 바랍니다.
                        </div>
                    </div>
                </div>
            </div>
        `;
    } else if (modal === 'loan') {
        let loanListHtml = loans.map((l, idx) => {
            let currentPrincipal = 0; let currentInterest = 0;
            let recordsHtml = l.records.map(rec => {
                currentPrincipal += rec.amount;
                let diffDays = daysBetween(rec.date, today);
                currentInterest += rec.amount * (l.rate / 100) / 365 * diffDays;
                
                let isRepay = rec.amount < 0;
                let amtStr = isRepay ? num(rec.amount) : '+' + num(rec.amount);
                let color = isRepay ? 'var(--primary)' : 'var(--danger)';

                return `<div style="display:flex; justify-content:space-between; align-items:center; padding: 6px 0; border-bottom:1px solid rgba(255,255,255,0.02); font-size:13px;">
                            <span style="color:var(--text-soft);">${rec.date}${rec.src === 'upload' ? ' <span style="font-size:10px; background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:4px;">업로드</span>' : ''}</span>
                            <div>
                                <span style="color:${color}; font-weight:600; margin-right:8px;">${amtStr}원</span>
                                <button onclick="window.deleteLoanRecord('${l.id}', '${rec.id}')" style="background:var(--surface); border:1px solid var(--line); color:var(--text-soft); font-size:10px; cursor:pointer; padding:2px 6px; border-radius:4px;">삭제</button>
                            </div>
                        </div>`;
            }).join('');
            
            return `
                <div style="background:var(--surface-sub); padding:16px; border-radius:12px; margin-bottom:16px; border:1px solid rgba(255,255,255,0.05);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <span style="font-weight:800; color:var(--text); font-size:16px;">${l.name} <span style="font-size:11px; background:${l.kind === '마통' ? 'rgba(255,180,60,0.15)' : 'rgba(58,130,246,0.15)'}; color:${l.kind === '마통' ? '#ffb43c' : 'var(--primary)'}; padding:2px 7px; border-radius:6px; margin-left:6px; font-weight:700;">${l.kind === '마통' ? '마이너스통장' : '일반대출'}</span> <span style="font-size:12px; color:var(--primary); margin-left:4px; font-weight:600;">연 ${l.rate}%</span></span>
                        <div>
                            <button onclick="window.deleteLoan('${l.id}')" style="background:transparent; border:none; color:var(--danger); cursor:pointer; font-size:13px; padding:4px 8px;">대출삭제</button>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:14px;"><span style="color:var(--text-soft);">${l.kind === '마통' ? '현재 사용액' : '대출 잔액'}</span><span style="font-weight:700;">${num(currentPrincipal)}원</span></div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:16px; font-size:14px;"><span style="color:var(--text-soft);">누적 이자</span><span style="font-weight:700; color:var(--danger);">${num(currentInterest)}원</span></div>
                    <div style="background:rgba(0,0,0,0.15); padding:12px; border-radius:8px; margin-bottom:12px;">
                        <div style="font-size:12px; color:var(--text-soft); margin-bottom:8px; font-weight:700;">${l.kind === '마통' ? '인출 및 상환 내역 (인출 +, 상환 −)' : '실행 및 원금상환 내역 (실행 +, 상환 −)'}</div>
                        ${recordsHtml || '<div style="font-size:12px; color:var(--text-soft);">내역이 없습니다.</div>'}
                    </div>
                    <div style="display:flex; gap:6px;">
                        <input type="date" id="recDate_${l.id}" value="${new Date().toISOString().split('T')[0]}" style="flex:1; font-size:13px; padding:10px; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:8px;">
                        <input type="number" id="recAmt_${l.id}" placeholder="${l.kind === '마통' ? '인출 +, 상환 −' : '추가실행 +, 상환 −'}" style="flex:1.5; font-size:13px; padding:10px; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:8px;">
                        <button onclick="window.addLoanRecord('${l.id}')" style="background:var(--primary); color:#fff; border:none; border-radius:8px; padding:0 14px; font-size:13px; font-weight:700; cursor:pointer;">추가</button>
                    </div>
                </div>`;
        }).join('');

        html += `
            <div class="overlay" id="ovLoan">
                <div class="sheet" id="modalSheet">
                    <div class="sheet-title">🏦 대출 관리<button class="close" onclick="window.closeModal()">✕</button></div>
                    <div style="max-height:400px; overflow-y:auto; margin-bottom:24px;" id="loanListScroll">${loanListHtml || '<div style="text-align:center; padding:30px; color:var(--text-soft); font-size:14px;">등록된 대출이 없습니다.</div>'}</div>
                    <div style="border-top:1px dashed var(--line); padding-top:20px;">
                        <div style="font-size: 15px; font-weight: 800; margin-bottom: 16px; color: var(--text);">+ 새로운 대출 추가</div>
                        <div class="field"><label>대출명</label><input type="text" id="loanName" placeholder="예: 마통(국민은행)"></div>
                        <div class="field"><label>대출 유형</label>
                            <select id="loanKind" onchange="window.onLoanKindChange()">
                                <option value="일반">일반대출 (원금 전액 실행)</option>
                                <option value="마통">마이너스통장 (쓴 만큼 이자)</option>
                            </select>
                        </div>
                        <div class="field"><label>연 이자율 (%)</label><input type="number" step="0.01" id="loanRate" placeholder="예: 5.2"></div>
                        <div class="field"><label id="loanAmountLabel">대출 실행금액 (원)</label><input type="number" id="loanAmount" placeholder="대출받은 원금 전액"></div>
                        <div class="field"><label id="loanDateLabel">실행일</label><input type="date" id="loanDate" value="${new Date().toISOString().split('T')[0]}"></div>
                        <div id="loanKindHelp" style="background:rgba(58,130,246,0.10); border:1px solid rgba(58,130,246,0.30); color:var(--text-soft); padding:10px 12px; border-radius:10px; font-size:12px; line-height:1.6; margin-bottom:16px;">
                            <b style="color:var(--primary);">일반대출</b> — 실행일에 원금 전액을 입력하세요. 이후 원금을 상환하면 아래 내역에 <b>마이너스 금액</b>으로 기록합니다.
                        </div>
                        <button class="primary-btn" onclick="window.submitLoanAdd()">대출 등록</button>
                    </div>
                </div>
            </div>
        `;
    } else if (modal === 'add') {
        html += `
            <div class="overlay" id="ovAdd">
                <div class="sheet" id="modalSheet">
                    <div class="sheet-title">새 종목 추가<button class="close" onclick="window.closeModal()">✕</button></div>
                    <div style="background:var(--surface-sub); padding:16px; border-radius:12px; margin-bottom:16px; border:1px solid rgba(255,255,255,0.05);">
                        <div class="field" style="margin-bottom:8px;"><label>💰 자금 출처 선택</label>
                            <select id="addFundSource" onchange="window.toggleFundLoan(this.value, 'addFundLoanWrap')" style="background:var(--surface); border:1px solid var(--primary); font-weight:600;">
                                <option value="현금">현금 (내 돈으로 매수)</option>
                                <option value="대출">대출 연동 (자동 잔액/이자 계산)</option>
                            </select>
                        </div>
                        <div class="field" id="addFundLoanWrap" style="display:none; margin-bottom:0;"><label>대출 선택</label><select id="addFundLoanId">${loanOptions}</select></div>
                    </div>
                    <div class="field"><label>날짜</label><input type="date" id="addDate" value="${new Date().toISOString().split('T')[0]}"></div>
                    <div class="field"><label>구분</label><select id="addType"><option value="국내주식">국내주식</option><option value="주식(해외)">주식(해외)</option></select></div>
                    <div class="field"><label>종목명</label><input type="text" id="addName" placeholder="예: 삼성전자"></div>
                    <div class="field"><label>종목코드</label><input type="text" id="addCode" placeholder="예: KRX:005930"></div>
                    <div class="field"><label>수량 (매도 시 -음수 입력)</label><input type="number" step="0.0001" id="addQty" placeholder="수량"></div>
                    <div class="field"><label>단가</label><input type="number" step="0.01" id="addPrice" placeholder="단가"></div>
                    <button class="primary-btn" onclick="window.submitAdd()">기록 추가</button>
                </div>
            </div>
        `;
    } else if (modal === 'detail' && selectedStock) {
        let pInfo = portfolio[selectedStock] || { isOverseas: false, currentValueKRW: 0, tickerKey: '', code: '' };
        let curP = currentPrices[pInfo.tickerKey] || currentPrices[pInfo.tickerKey.replace('KRX:','').replace('KOSDAQ:','')] || null;
        let stockTxs = transactions.filter(tx => tx.name === selectedStock).sort((a,b) => new Date(b.date) - new Date(a.date));
        
        let listHtml = stockTxs.map(tx => {
            let isOvs = isTxOverseas(tx);
            let pStr = isOvs ? usd(tx.price) : num(tx.price)+'원';
            let actionType = tx.quantity > 0 ? '<span class="c-up">매수</span>' : '<span class="c-down">매도</span>';
            return `
                <div class="detail-tx-item">
                    <div class="detail-tx-date">${tx.date}<br><span style="font-size:12px; font-weight:400; color:var(--text-soft)">${actionType}</span></div>
                    <div class="detail-tx-info"><span class="qty">${Math.abs(tx.quantity).toLocaleString('en-US', {maximumFractionDigits:4})}주</span><span class="price">단가: ${pStr}</span></div>
                </div>`;
        }).join('');

        html += `
            <div class="overlay" id="ovDetail">
                <div class="sheet" id="modalSheet">
                    <div class="sheet-title" style="margin-bottom:20px;">
                        <div>
                            <div style="font-size:20px;">${selectedStock}</div>
                            <div style="font-size:12px; color:var(--text-soft); font-weight:400; margin-top:4px;">실시간 주가: <span style="font-weight:700; color:var(--text);">${curP ? (pInfo.isOverseas ? usd(curP) : num(curP)+'원') : 'API 연동 전'}</span></div>
                        </div>
                        <button class="close" onclick="window.closeModal()">✕</button>
                    </div>
                    
                    <div style="background: var(--surface-sub); padding: 16px 16px 4px; border-radius: 16px; margin-bottom: 24px;">
                        <div style="font-size: 13px; font-weight: 800; margin-bottom: 12px; color: var(--text);">📝 이 종목 신규 기록 추가</div>
                        <div class="filter-sort-row" style="margin-bottom:12px;">
                            <select id="detailFundSource" onchange="window.toggleFundLoan(this.value, 'detailFundLoanWrap')" style="flex:1; border:1px solid var(--primary); background:var(--surface); color:var(--text); font-weight:600; padding:10px 12px; border-radius:10px; outline:none;">
                                <option value="현금">💰 자금출처: 현금</option><option value="대출">💰 자금출처: 대출 연동</option>
                            </select>
                        </div>
                        <div id="detailFundLoanWrap" style="display:none; margin-bottom:12px;">
                            <select id="detailFundLoanId" style="width:100%; border:1px solid var(--line); background:var(--surface); color:var(--text); border-radius:10px; padding:10px 12px; font-size:14px; outline:none;">${loanOptions}</select>
                        </div>
                        <div class="filter-sort-row" style="margin-bottom:8px;">
                            <input type="date" id="detailAddDate" value="${new Date().toISOString().split('T')[0]}" style="flex:1;">
                            <input type="number" step="0.0001" id="detailAddQty" placeholder="수량 (-매도)" style="flex:1;">
                        </div>
                        <div class="filter-sort-row" style="margin-bottom:12px;">
                            <input type="number" step="0.01" id="detailAddPrice" placeholder="거래 단가" style="flex:1;">
                        </div>
                        <button class="primary-btn" onclick="window.submitDetailAdd('${pInfo.code}')" style="margin-top: 0; margin-bottom: 12px;">기록 추가하기</button>
                    </div>
                    <div style="font-size: 14px; font-weight: 800; margin-bottom: 8px;">최근 체결 내역</div>
                    <div class="detail-tx-list">${listHtml}</div>
                </div>
            </div>
        `;
    }

    app.innerHTML = html;

    Object.keys(tempInputs).forEach(id => { 
        let el = document.getElementById(id); 
        if(el) {
            el.value = tempInputs[id];
            if (id === 'addFundSource') window.toggleFundLoan(el.value, 'addFundLoanWrap');
            if (id === 'detailFundSource') window.toggleFundLoan(el.value, 'detailFundLoanWrap');
        }
    });

    if (focusedElementId) { 
        let el = document.getElementById(focusedElementId); 
        if (el) { el.focus(); try { el.setSelectionRange(cursorPosition, cursorPosition); } catch(e){} } 
    }

    window.scrollTo(0, scrollY);
    if (document.getElementById('modalSheet')) document.getElementById('modalSheet').scrollTop = sheetScroll;
    if (document.getElementById('loanListScroll')) document.getElementById('loanListScroll').scrollTop = loanListScroll;

    if (viewMode === 'chart' && activeStocks.length > 0) {
        renderChart(activeStocks, portfolio);
    }

    let fab = document.getElementById('fabAdd');
    if(fab) fab.onclick = () => { selectedStock = null; modal = 'add'; render(); };
    
    let modals = ['ovAdd', 'ovDetail', 'ovLoan', 'ovData'];
    modals.forEach(id => {
        let m = document.getElementById(id);
        if(m) m.onclick = (e) => { if(e.target === m) window.closeModal(); };
    });
}

window.setViewMode = function(mode) { viewMode = mode; render(); }
window.setSearchText = function(text) { searchText = text; render(); }
window.setSortBy = function(sort) { sortBy = sort; render(); }
window.openLoanModal = function() { modal = 'loan'; render(); }
window.openDataModal = function() { modal = 'data'; render(); }
window.closeModal = function() { modal = null; render(); }
window.openStockDetail = function(name) { selectedStock = name; modal = 'detail'; render(); }
window.toggleFundLoan = function(val, wrapId) {
    let wrap = document.getElementById(wrapId);
    if(wrap) wrap.style.display = (val === '대출') ? 'block' : 'none';
}

function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2500);
}

window.downloadTemplate = function() {
    const headers = ["날짜", "구분", "종목명", "코드", "수량", "단가", "환율", "대출명"];
    const loanName = loans.length > 0 ? loans[0].name : "";
    const sample = [
        ["2026-01-15", "국내주식", "삼성전자", "KRX:005930", 10, 75000, 1, ""],
        ["2026-02-03", "해외주식", "AAPL",     "AAPL",       5,   220,  1380, loanName],
        ["2026-03-10", "해외주식", "AAPL",     "AAPL",      -2,   240,  1400, loanName]
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws['!cols'] = [{wch:12},{wch:10},{wch:16},{wch:14},{wch:8},{wch:10},{wch:8},{wch:18}];

    const guide = XLSX.utils.aoa_to_sheet([
        ["항목", "설명"],
        ["날짜",   "YYYY-MM-DD 형식 (예: 2026-01-15)"],
        ["구분",   "국내주식 / 해외주식 / 코인 / 배당금 / 분배금 / 공모주 손익"],
        ["종목명", "화면에 표시될 이름"],
        ["코드",   "국내는 KRX:005930 또는 KOSDAQ:046970, 해외는 AAPL 형식. 비우면 종목명을 코드로 사용"],
        ["수량",   "매수는 양수, 매도는 음수로 입력"],
        ["단가",   "1주당 가격. 해외주식은 달러 기준"],
        ["환율",   "해외주식 매수 당시 원/달러 환율. 국내주식은 1"],
        ["대출명", "★ 비우면 현금 매수. 대출로 매수했다면 앱에 등록한 대출명을 그대로 입력"],
        ["", ""],
        ["대출명 사용 안내", ""],
        ["1", "대출은 앱의 '대출 관리'에서 먼저 등록하세요 (유형·연이자율 필요)"],
        ["2", "여기에 적는 이름은 등록한 대출명과 정확히 일치해야 합니다"],
        ["3", "매수(수량 +)는 대출 인출, 매도(수량 −)는 대출 상환으로 자동 기록됩니다"],
        ["4", "재업로드 시 이전 업로드로 만들어진 대출 기록은 자동 정리됩니다"]
    ]);
    guide['!cols'] = [{wch:18},{wch:80}];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "거래내역");
    XLSX.utils.book_append_sheet(wb, guide, "작성안내");
    XLSX.writeFile(wb, "리치맨_포트폴리오_양식.xlsx");
}

// ── 현재 데이터 내보내기 (업로드 양식과 동일한 컬럼) ──────────
window.exportData = function() {
    if (transactions.length === 0 && loans.length === 0) { showToast('내보낼 데이터가 없습니다.'); return; }

    const headers = ["날짜", "구분", "종목명", "코드", "수량", "단가", "환율", "대출명"];
    const rows = transactions.map(t => [
        t.date, t.type || '', t.name || '', t.code || '',
        Number(t.quantity || 0), Number(t.price || 0), Number(t.exchangeRate || 1), t.loanName || ''
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [{wch:12},{wch:10},{wch:16},{wch:14},{wch:8},{wch:12},{wch:8},{wch:18}];

    const lh = ["대출명", "유형", "연이자율(%)", "기록일자", "금액", "출처"];
    const lr = [];
    loans.forEach(l => (l.records || []).forEach(r => {
        lr.push([l.name, l.kind === '마통' ? '마이너스통장' : '일반대출', l.rate, r.date, r.amount, r.src === 'upload' ? '업로드' : '직접입력']);
    }));
    if (lr.length === 0) lr.push(["(대출 기록 없음)", "", "", "", "", ""]);
    const lws = XLSX.utils.aoa_to_sheet([lh, ...lr]);
    lws['!cols'] = [{wch:18},{wch:14},{wch:12},{wch:12},{wch:14},{wch:10}];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "거래내역");
    XLSX.utils.book_append_sheet(wb, lws, "대출내역(참고용)");
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
    XLSX.writeFile(wb, `리치맨_백업_${stamp}.xlsx`);
    showToast(`거래 ${transactions.length}건 / 대출기록 ${lr.length}건 내보내기 완료`);
}

// ── 거래내역만 초기화 (대출 마스터·직접입력 기록은 보존) ────────
window.resetPortfolio = function() {
    const txCount = transactions.length;
    const upCount = loans.reduce((a, l) => a + (l.records || []).filter(r => r.src === 'upload').length, 0);
    if (txCount === 0 && upCount === 0) { showToast('삭제할 거래내역이 없습니다.'); return; }

    const msg = `거래내역을 초기화합니다.\n\n` +
        `  · 삭제: 매매 기록 ${txCount}건\n` +
        `  · 삭제: 업로드로 생성된 대출 기록 ${upCount}건\n` +
        `  · 보존: 대출 마스터(${loans.length}건)와 직접 입력한 대출 기록\n\n` +
        `되돌릴 수 없습니다. 진행할까요?`;
    if (!confirm(msg)) return;

    savedTxs = []; transactions = [];
    localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));
    loans.forEach(l => { l.records = (l.records || []).filter(r => r.src !== 'upload'); });
    localStorage.setItem('myLoans', JSON.stringify(loans));

    window.closeModal();
    showToast('거래내역이 초기화되었습니다.');
}

// ── 전체 초기화 (대출 포함) ─────────────────────────────────
window.resetAll = function() {
    const txCount = transactions.length;
    const loanCount = loans.length;
    const recCount = loans.reduce((a, l) => a + (l.records || []).length, 0);
    if (txCount === 0 && loanCount === 0) { showToast('삭제할 데이터가 없습니다.'); return; }

    const msg = `⚠️ 전체 초기화\n\n` +
        `  · 매매 기록 ${txCount}건\n  · 대출 ${loanCount}건 (기록 ${recCount}건)\n\n` +
        `모두 삭제되며 복구할 수 없습니다.\n먼저 '데이터 내보내기'로 백업하셨나요?\n\n계속하려면 확인을 누르세요.`;
    if (!confirm(msg)) return;

    const typed = prompt('확인을 위해 아래 문구를 그대로 입력하세요.\n\n초기화');
    if (typed === null) return;
    if (String(typed).trim() !== '초기화') { alert('입력이 일치하지 않아 취소되었습니다.'); return; }

    savedTxs = []; transactions = []; loans = [];
    localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));
    localStorage.setItem('myLoans', JSON.stringify(loans));

    window.closeModal();
    showToast('전체 데이터가 초기화되었습니다.');
}

window.handleFileUpload = function(e) {
    let file = e.target.files[0];
    if(!file) return;
    let reader = new FileReader();
    reader.onload = function(evt) {
        try {
            let data = new Uint8Array(evt.target.result);
            let workbook = XLSX.read(data, {type: 'array'});
            let rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
            if (rows.length === 0) { alert('읽을 수 있는 데이터가 없습니다.'); return; }

            // ── 1) 행 파싱 ─────────────────────────────────────
            const parsed = rows.map((row, i) => {
                let d = row['날짜'] || new Date().toISOString().split('T')[0];
                if (typeof d === 'number') {   // 엑셀 일련번호 → 날짜
                    d = new Date(Math.round((d - 25569) * 86400 * 1000)).toISOString().split('T')[0];
                }
                d = String(d).trim().slice(0, 10);
                return {
                    _row: i + 2,
                    portfolio: "업로드",
                    date: d,
                    type: String(row['구분'] || '국내주식').trim(),
                    name: String(row['종목명'] || '이름없음').trim(),
                    code: String(row['코드'] || '').trim(),
                    quantity: Number(row['수량'] || 0),
                    price: Number(row['단가'] || 0),
                    exchangeRate: Number(row['환율'] || 1.0),
                    loanName: String(row['대출명'] || '').trim()
                };
            });

            // ── 2) 대출명 검증 ─────────────────────────────────
            const loanByName = {};
            loans.forEach(l => { loanByName[l.name.trim()] = l; });

            const unknown = {};
            parsed.forEach(p => {
                if (p.loanName && !loanByName[p.loanName]) {
                    unknown[p.loanName] = (unknown[p.loanName] || 0) + 1;
                }
            });
            const unknownNames = Object.keys(unknown);
            if (unknownNames.length > 0) {
                const detail = unknownNames.map(nm => `  · ${nm} (${unknown[nm]}건)`).join('\n');
                const msg = '아래 대출명이 등록되어 있지 않습니다.\n\n' + detail +
                    '\n\n[확인] 해당 행을 현금 매수로 처리하고 계속 진행\n' +
                    '[취소] 업로드 중단 → 대출 관리에서 먼저 등록 (권장)';
                if (!confirm(msg)) { document.getElementById('fileUpload').value = ''; return; }
            }

            const linked = parsed.filter(p => p.loanName && loanByName[p.loanName]).length;
            const summary = `총 ${parsed.length}건을 적용합니다.\n\n` +
                `  · 대출 연동: ${linked}건\n  · 현금 매수: ${parsed.length - linked}건\n\n` +
                `기존 거래내역은 모두 교체됩니다. 진행할까요?`;
            if (!confirm(summary)) { document.getElementById('fileUpload').value = ''; return; }

            // ── 3) 거래내역 저장 ───────────────────────────────
            savedTxs = parsed.map(p => ({
                portfolio: p.portfolio, date: p.date, type: p.type, name: p.name,
                code: p.code, quantity: p.quantity, price: p.price, exchangeRate: p.exchangeRate,
                loanName: loanByName[p.loanName] ? p.loanName : ''   // 내보내기 왕복을 위해 보존
            }));
            transactions = [...savedTxs];
            localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));

            // ── 4) 대출 기록 반영 (업로드분만 교체) ──────────────
            // src === 'upload' 인 기록만 제거 → 수동 입력분(상환 등)은 보존
            loans.forEach(l => { l.records = (l.records || []).filter(r => r.src !== 'upload'); });

            parsed.forEach(p => {
                const loan = loanByName[p.loanName];
                if (!loan) return;
                const isOvs = (p.exchangeRate > 100) || p.type.includes('해외');
                const amtKRW = Math.round(p.quantity * p.price * (isOvs ? p.exchangeRate : 1));
                if (!amtKRW) return;
                // 매수(+) = 인출, 매도(−) = 상환
                loan.records.push({
                    id: 'up_' + p._row + '_' + Math.random().toString(36).substr(2, 5),
                    date: p.date,
                    amount: amtKRW,
                    src: 'upload'
                });
            });
            loans.forEach(l => l.records.sort((a, b) => String(a.date).localeCompare(String(b.date))));
            localStorage.setItem('myLoans', JSON.stringify(loans));

            window.closeModal();
            showToast(`${parsed.length}건 적용 완료 (대출연동 ${linked}건)`);
            setTimeout(() => location.reload(), 1500);

        } catch (err) {
            console.error('[UPLOAD]', err);
            alert('파일을 처리하지 못했습니다.\n\n' + err.message);
        }
        document.getElementById('fileUpload').value = '';
    };
    reader.readAsArrayBuffer(file);
}

window.onLoanKindChange = function() {
    const kind = document.getElementById('loanKind').value;
    const isNeg = (kind === '마통');
    document.getElementById('loanAmountLabel').textContent = isNeg ? '현재 사용중인 금액 (원)' : '대출 실행금액 (원)';
    document.getElementById('loanDateLabel').textContent   = isNeg ? '해당 금액을 인출한 날짜' : '실행일';
    document.getElementById('loanAmount').placeholder      = isNeg ? '한도가 아니라 실제 쓴 금액' : '대출받은 원금 전액';
    document.getElementById('loanKindHelp').innerHTML = isNeg
        ? '<b style="color:#ffb43c;">마이너스통장</b> — <b>한도가 아니라 실제 사용중인 금액</b>을 입력하세요. 한도를 입력하면 이자가 과대계상됩니다. 이후 인출은 <b>플러스</b>, 상환은 <b>마이너스</b>로 기록하면 일별 잔액 기준으로 이자가 계산됩니다.'
        : '<b style="color:var(--primary);">일반대출</b> — 실행일에 원금 전액을 입력하세요. 이후 원금을 상환하면 아래 내역에 <b>마이너스 금액</b>으로 기록합니다.';
}

window.submitLoanAdd = function() {
    let name   = (document.getElementById('loanName').value || '').trim();
    let kind   = document.getElementById('loanKind').value;
    let rate   = Number(document.getElementById('loanRate').value);
    let amount = Number(document.getElementById('loanAmount').value || 0);
    let date   = document.getElementById('loanDate').value;

    if (!name)          { showToast('대출명을 입력해주세요.'); return; }
    if (!rate || rate <= 0) { showToast('연 이자율을 입력해주세요.'); return; }
    if (amount < 0)     { showToast('실행금액은 0 이상이어야 합니다.'); return; }
    if (amount > 0 && !date) { showToast('실행일을 선택해주세요.'); return; }

    let records = [];
    if (amount > 0) {
        records.push({
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            date: date,
            amount: amount
        });
    }

    loans.push({ id: Date.now().toString(), name, kind, rate, records });
    localStorage.setItem('myLoans', JSON.stringify(loans));
    render();
    showToast(amount > 0
        ? `${name} 등록 완료 (${num(amount)}원)`
        : `${name} 등록 완료 — 아래 카드에서 금액을 추가하세요.`);
}

window.deleteLoan = function(id) {
    if (confirm('이 대출과 모든 내역을 정말 삭제하시겠습니까?')) {
        loans = loans.filter(l => l.id !== id);
        localStorage.setItem('myLoans', JSON.stringify(loans));
        render();
    }
}

window.addLoanRecord = function(loanId) {
    let dateInput = document.getElementById(`recDate_${loanId}`);
    let amtInput = document.getElementById(`recAmt_${loanId}`);
    let date = dateInput.value;
    let amount = Number(amtInput.value);
    
    if(!date || !amount) { showToast('날짜와 금액을 정확히 입력해주세요.'); return; }

    let loan = loans.find(l => l.id === loanId);
    if(loan) {
        loan.records.push({ id: Date.now().toString() + Math.random().toString(36).substr(2, 5), date: date, amount: amount });
        localStorage.setItem('myLoans', JSON.stringify(loans));
        amtInput.value = ''; 
        render();
        showToast('내역이 추가되었습니다.');
    }
}

window.deleteLoanRecord = function(loanId, recId) {
    if (confirm('해당 내역을 삭제하시겠습니까?')) {
        let loan = loans.find(l => l.id === loanId);
        if(loan) {
            loan.records = loan.records.filter(r => r.id !== recId);
            localStorage.setItem('myLoans', JSON.stringify(loans));
            render();
        }
    }
}

window.submitAdd = function() {
    let fundSource = document.getElementById('addFundSource') ? document.getElementById('addFundSource').value : '현금';
    let fundLoanId = document.getElementById('addFundLoanId') ? document.getElementById('addFundLoanId').value : null;

    let name = document.getElementById('addName').value.trim();
    let qty = Number(document.getElementById('addQty').value);
    let price = Number(document.getElementById('addPrice').value);
    let rate = Number(document.getElementById('addRate') ? document.getElementById('addRate').value : 1.0);
    
    if(!name || !qty || !price) { alert('필수 정보를 입력하세요.'); return; }
    if (fundSource === '대출' && !fundLoanId) { showToast('먼저 대출 관리 메뉴에서 대출을 등록해주세요.'); return; }
    
    let isOvs = document.getElementById('addType').value.includes('해외');
    let totalAmountKRW = qty * price * (isOvs ? rate : 1.0);

    let newTx = {
        portfolio: "수동입력",
        date: document.getElementById('addDate').value,
        type: document.getElementById('addType').value,
        name: name,
        code: document.getElementById('addCode').value.trim(),
        quantity: qty,
        price: price,
        exchangeRate: isOvs ? rate : 1.0
    };
    transactions.unshift(newTx);
    savedTxs.unshift(newTx);
    localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));

    if (fundSource === '대출') {
        let loan = loans.find(l => l.id === fundLoanId);
        if (loan) {
            newTx.loanName = loan.name;
            savedTxs[0].loanName = loan.name;
            localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));
            loan.records.push({ id: Date.now().toString() + Math.random().toString(36).substr(2, 5), date: document.getElementById('addDate').value, amount: totalAmountKRW });
            localStorage.setItem('myLoans', JSON.stringify(loans));
        }
    }

    window.closeModal();
    showToast(fundSource === '대출' ? '새 종목 및 대출 연동이 완료되었습니다.' : '새로운 종목이 추가되었습니다.');
}

window.submitDetailAdd = function(code) {
    let fundSource = document.getElementById('detailFundSource') ? document.getElementById('detailFundSource').value : '현금';
    let fundLoanId = document.getElementById('detailFundLoanId') ? document.getElementById('detailFundLoanId').value : null;

    let dateInput = document.getElementById('detailAddDate');
    let qtyInput = document.getElementById('detailAddQty');
    let priceInput = document.getElementById('detailAddPrice');
    let rateInput = document.getElementById('detailAddRate');
    
    let date = dateInput.value;
    let qty = Number(qtyInput.value);
    let price = Number(priceInput.value);
    let rate = rateInput ? (Number(rateInput.value) || 1.0) : 1.0;
    
    if(!qty || !price) { showToast('수량과 단가를 입력해주세요'); return; }
    if (fundSource === '대출' && !fundLoanId) { showToast('먼저 대출 관리 메뉴에서 대출을 등록해주세요.'); return; }
    
    let pObj = transactions.find(t => t.name === selectedStock);
    let type = pObj ? pObj.type : '국내주식';
    let isOvs = isTxOverseas(pObj);

    let newTx = {
        portfolio: "수동입력", date: date, type: type, name: selectedStock,
        code: code || '', quantity: qty, price: price, exchangeRate: isOvs ? rate : 1.0
    };

    transactions.unshift(newTx);
    savedTxs.unshift(newTx);
    localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs)); 

    if (fundSource === '대출') {
        let totalAmountKRW = qty * price * (isOvs ? rate : 1.0);
        let loan = loans.find(l => l.id === fundLoanId);
        if (loan) {
            loan.records.push({ id: Date.now().toString() + Math.random().toString(36).substr(2, 5), date: date, amount: totalAmountKRW });
            localStorage.setItem('myLoans', JSON.stringify(loans));
        }
    }

    qtyInput.value = ''; priceInput.value = '';
    render(); 
    showToast('기록이 추가되었습니다.');
}

function renderChart(stocks, portfolioData) {
    let ctx = document.getElementById('portfolioChart').getContext('2d');
    if (chartInstance) chartInstance.destroy(); 
    let labels = stocks;
    let data = stocks.map(name => portfolioData[name].currentValueKRW);
    let bgColors = stocks.map((_, i) => `hsl(${(i * 360 / stocks.length) % 360}, 70%, 60%)`);

    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: data, backgroundColor: bgColors, borderWidth: 0 }] },
        options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, color: '#8f95b2' } } } }
    });
}

document.addEventListener('DOMContentLoaded', () => initApp());
