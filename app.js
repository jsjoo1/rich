let transactions = [];
if (typeof initialTransactions !== 'undefined') { transactions = [...initialTransactions]; }
let savedTxs = JSON.parse(localStorage.getItem('mySavedTxs') || '[]');
if (localStorage.getItem('mySavedTxs')) { transactions = [...savedTxs]; } else { transactions = [...savedTxs, ...transactions]; }

let loans = JSON.parse(localStorage.getItem('myLoans') || '[]');
loans = loans.map(l => {
    if(!l.id) l.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    if(!l.records) { l.records = []; if(l.amount && Number(l.amount) > 0) { l.records.push({id: Date.now().toString(), date: l.startDate, amount: Number(l.amount)}); } }
    return l;
});
localStorage.setItem('myLoans', JSON.stringify(loans));

let modal = null; let selectedStock = null; let searchText = ''; let sortBy = 'invested_desc'; let viewMode = 'list'; let chartInstance = null;
let currentPrices = {}; let currentUsdKrw = 1300.0;
let tickerMap = {};
transactions.forEach(tx => { if (tx.name && tx.code) tickerMap[tx.name] = tx.code; });

function isTxOverseas(tx) {
    if (!tx) return false;
    if (tx.exchangeRate > 100) return true;
    if (tx.type && tx.type.includes('해외')) return true;
    if (tx.name === '달러') return true;
    if (tx.type === '주식') { if (tx.code && (tx.code.includes('KRX') || tx.code.includes('KOSDAQ'))) return false; return true; }
    return false;
}

// ⚠️ 여기에 본인의 구글 웹앱 URL을 정확히 입력하세요!
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbybtTcU_U83nQwiSjOriBk02wJcBdJ98Pmb-rfOQ1rsW4MvGR_BwwDnxBhKjBshr3kzRA/exec"; 

function num(n) { return Math.round(n).toLocaleString('ko-KR'); }
function usd(n) { return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function getColorClass(val) { if (val > 0) return 'c-up'; if (val < 0) return 'c-down'; return 'c-even'; }
function getSign(val) { return val > 0 ? '+' : ''; }

async function fetchHistoricalRate(dateStr) {
    try { const res = await fetch(`https://api.frankfurter.app/${dateStr}?from=USD&to=KRW`); const data = await res.json(); return data.rates.KRW; } catch (e) { return null; }
}

async function updatePricesInBackground() {
    let uniqueTickers = [...new Set(transactions.map(t => t.code || t.name).filter(c => c))];
    let ratePromise = fetch('https://api.frankfurter.app/latest?from=USD&to=KRW').then(res => res.json()).then(data => { if (data && data.rates && data.rates.KRW) currentUsdKrw = data.rates.KRW; }).catch(e => console.log("환율 로드 실패"));
    let pricePromise = Promise.resolve();
    if (GAS_API_URL && GAS_API_URL.startsWith("http")) {
        pricePromise = fetch(GAS_API_URL + "?tickers=" + uniqueTickers.join(',')).then(res => res.json()).then(data => { if (data && !data.error) currentPrices = data; }).catch(e => console.log("실시간 주가 로드 실패"));
    }
    await Promise.all([ratePromise, pricePromise]);
    render();
}

async function initApp() {
    const app = document.getElementById('app');
    app.innerHTML = `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:80vh; gap:16px;">
        <div style="font-size:16px; font-weight:700; color:var(--text-soft);">실시간 주가 정보를 불러오는 중입니다...</div>
    </div>`;

    let loaded = false;
    setTimeout(() => { if (!loaded) { loaded = true; render(); } }, 10000);
    await updatePricesInBackground();
    if (!loaded) { loaded = true; render(); }
    setInterval(updatePricesInBackground, 5000);
}

function render() {
    let focusedElementId = null; let cursorPosition = 0;
    if (document.activeElement && document.activeElement.id) { focusedElementId = document.activeElement.id; try { cursorPosition = document.activeElement.selectionStart || 0; } catch(e){} }
    let tempInputs = {};
    document.querySelectorAll('input, select').forEach(el => { if(el.id && el.type !== 'file') tempInputs[el.id] = el.value; });

    let scrollY = window.scrollY;
    let sheetScroll = document.getElementById('modalSheet') ? document.getElementById('modalSheet').scrollTop : 0;

    const app = document.getElementById('app'); const today = new Date();
    let totalInvested = 0; let accruedInterest = 0; let totalCurrentValue = 0; let portfolio = {};
    
    loans.forEach(loan => { loan.records.forEach(rec => { let diffDays = Math.max(0, Math.ceil((today.getTime() - new Date(rec.date).getTime()) / 86400000)); accruedInterest += rec.amount * (loan.rate / 100) / 365 * diffDays; }); });
    transactions.forEach(tx => {
        let isOverseas = isTxOverseas(tx);
        let amountKRW = isOverseas ? (tx.quantity * tx.price * tx.exchangeRate) : (tx.quantity * tx.price);
        let curPrice = currentPrices[tx.code || tx.name] || tx.price;
        let curAmountKRW = isOverseas ? (tx.quantity * curPrice * currentUsdKrw) : (tx.quantity * curPrice);
        if(!portfolio[tx.name]) portfolio[tx.name] = { type: tx.type, tickerKey: tx.code || tx.name, code: tx.code, quantity: 0, totalAmountKRW: 0, totalAmountOriginal: 0, currentValueKRW: 0, isOverseas: isOverseas };
        portfolio[tx.name].quantity += tx.quantity; portfolio[tx.name].totalAmountOriginal += (tx.quantity * tx.price); portfolio[tx.name].totalAmountKRW += amountKRW; portfolio[tx.name].currentValueKRW += curAmountKRW;
        totalInvested += amountKRW; totalCurrentValue += curAmountKRW;
    });

    let marketProfit = totalCurrentValue - totalInvested; let netProfit = marketProfit - accruedInterest;
    let html = `
        <div class="kw-summary">
            <div class="kw-summary-title">총 실질손익(원)</div>
            <div class="kw-summary-main ${getColorClass(netProfit)}"><div class="val">${getSign(netProfit)}${num(netProfit)}</div></div>
            <div class="kw-summary-grid">
                <div class="kw-sg-item"><span class="lbl">매입</span><span class="val">${num(totalInvested)}</span></div>
                <div class="kw-sg-item"><span class="lbl">평가</span><span class="val">${num(totalCurrentValue)}</span></div>
                <div class="kw-sg-item" style="cursor:pointer;" onclick="openLoanModal()"><span class="lbl" style="color:var(--primary);">이자관리 ⚙️</span><span class="val">- ${num(accruedInterest)}</span></div>
            </div>
        </div>
        <div class="page">
            <div class="portfolio-tools">
                <div class="view-toggles"><button class="${viewMode === 'list' ? 'active' : ''}" onclick="window.setViewMode('list')">일반</button><button class="${viewMode === 'chart' ? 'active' : ''}" onclick="window.setViewMode('chart')">차트</button></div>
                <div class="filter-sort-row" style="display:flex; gap:8px;">
                    <button onclick="window.openDataModal()" style="background:var(--surface-sub); border:none; color:var(--text); padding:0 12px; border-radius:8px; font-size:12px; cursor:pointer;">💾 데이터 관리</button>
                    <input type="text" id="searchInput" placeholder="검색..." value="${searchText}" oninput="window.setSearchText(this.value)" style="flex:1;">
                </div>
            </div>
            ${viewMode === 'list' ? '<div class="kw-table">' + Object.keys(portfolio).map(name => `
                <div class="kw-row" onclick="openStockDetail('${name}')">
                    <div class="col-name">${name}<span class="ticker">${portfolio[name].quantity.toLocaleString()}주</span></div>
                    <div class="col">${num(currentPrices[portfolio[name].tickerKey] || portfolio[name].totalAmountOriginal/portfolio[name].quantity)}</div>
                    <div class="col ${getColorClass(portfolio[name].currentValueKRW - portfolio[name].totalAmountKRW)}">${num(portfolio[name].currentValueKRW - portfolio[name].totalAmountKRW)}</div>
                </div>`).join('') + '</div>' : '<div class="chart-container"><canvas id="portfolioChart"></canvas></div>'}
        </div>
        <button class="fab" id="fabAdd">+</button>
    `;
    app.innerHTML = html;
    Object.keys(tempInputs).forEach(id => { let el = document.getElementById(id); if(el) el.value = tempInputs[id]; });
    if (focusedElementId) { let el = document.getElementById(focusedElementId); if (el) { el.focus(); try { el.setSelectionRange(cursorPosition, cursorPosition); } catch(e){} } }
    window.scrollTo(0, scrollY);
    if (document.getElementById('modalSheet')) document.getElementById('modalSheet').scrollTop = sheetScroll;
    
    // (모달, 서브밋 함수 등 이전 답변의 로직 추가)
}

document.addEventListener('DOMContentLoaded', () => initApp());
