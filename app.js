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

    let marketProfit = totalCurrentValue - totalInvested; let netProfit = marketProfit - accruedInterest; let realReturnRate = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;
    let activeStocks = Object.keys(portfolio).filter(name => portfolio[name].quantity > 0.0001 && name.toLowerCase().includes(searchText.toLowerCase())).sort((a,b) => {
        if (sortBy === 'name_asc') return a.localeCompare(b);
        if (sortBy === 'invested_desc') return portfolio[b].totalAmountKRW - portfolio[a].totalAmountKRW;
        return portfolio[b].currentValueKRW - portfolio[a].currentValueKRW;
    });

    let html = `
        <div class="kw-summary">
            <div class="kw-summary-title">총 실질손익(원) <span style="font-size:11px; color:var(--text-soft); padding:2px 6px; background:var(--surface-sub); border-radius:4px;">*대출이자 차감</span></div>
            <div class="kw-summary-main ${getColorClass(netProfit)}">
                <div class="val">${getSign(netProfit)}${num(netProfit)}</div>
                <div class="pct">${getSign(netProfit)}${realReturnRate.toFixed(2)}%</div>
            </div>
            <div class="kw-summary-grid">
                <div class="kw-sg-item"><span class="lbl">매입금액</span><span class="val">${num(totalInvested)}</span></div>
                <div class="kw-sg-item"><span class="lbl">평가금액</span><span class="val">${num(totalCurrentValue)}</span></div>
                <div class="kw-sg-item" style="cursor:pointer;" onclick="openLoanModal()"><span class="lbl" style="color:var(--primary); font-weight:700;">이자관리 ⚙️</span><span class="val" style="color:var(--text-soft);">- ${num(accruedInterest)}</span></div>
            </div>
        </div>
        <div class="page" style="padding:0;">
            <div class="portfolio-tools">
                <div class="view-toggles"><button class="${viewMode === 'list' ? 'active' : ''}" onclick="window.setViewMode('list')">일반 잔고</button><button class="${viewMode === 'chart' ? 'active' : ''}" onclick="window.setViewMode('chart')">파이 차트</button></div>
                <div class="filter-sort-row" style="display:flex; gap:8px;">
                    <button onclick="window.openDataModal()" style="background:var(--surface-sub); border:none; color:var(--text); padding:0 12px; border-radius:8px; font-size:12px; cursor:pointer;">💾 데이터 관리</button>
                    <input type="text" id="searchInput" placeholder="검색..." value="${searchText}" oninput="window.setSearchText(this.value)" style="flex:1;">
                    <select id="sortSelect" onchange="window.setSortBy(this.value)"><option value="invested_desc">매입금액순</option><option value="value_desc">평가금액순</option></select>
                </div>
            </div>
            ${viewMode === 'list' ? '<div class="kw-table">' + activeStocks.map(name => `
                <div class="kw-row" onclick="openStockDetail('${name}')">
                    <div class="col-name">${name}<span class="ticker">${portfolio[name].quantity.toLocaleString()}주</span></div>
                    <div class="col">${usd(currentPrices[portfolio[name].tickerKey] || portfolio[name].totalAmountOriginal/portfolio[name].quantity)}</div>
                    <div class="col ${getColorClass(portfolio[name].currentValueKRW - portfolio[name].totalAmountKRW)}">${getSign(portfolio[name].currentValueKRW - portfolio[name].totalAmountKRW)}${num(portfolio[name].currentValueKRW - portfolio[name].totalAmountKRW)}</div>
                    <div class="col col-amt">${num(portfolio[name].currentValueKRW)}</div>
                </div>`).join('') + '</div>' : '<div class="chart-container"><canvas id="portfolioChart"></canvas></div>'}
        </div>
        <button class="fab" id="fabAdd">+</button>
    `;

    if (modal === 'data') {
        html += `
            <div class="overlay" id="ovData">
                <div class="sheet" id="modalSheet">
                    <div class="sheet-title">💾 데이터 관리<button class="close" onclick="window.closeModal()">✕</button></div>
                    <div style="background:var(--surface-sub); padding:16px; border-radius:12px; margin-bottom:20px; font-size:13px; color:var(--text-soft); line-height:1.6;">
                        <span style="color:var(--primary); font-weight:800; font-size:14px;">📊 엑셀/CSV 일괄 업로드</span><br><br>
                        지원 확장자: <b>.xlsx, .xls, .csv</b><br>
                        <button class="primary-btn" onclick="window.downloadTemplate()" style="margin:8px 0; background:var(--surface); border:1px solid var(--primary); color:var(--primary);">📥 양식 다운로드</button>
                    </div>
                    <input type="file" id="fileUpload" accept=".csv, .xlsx, .xls" style="display:none;" onchange="window.handleFileUpload(event)">
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        <button class="primary-btn" onclick="document.getElementById('fileUpload').click()" style="margin:0; background:var(--primary); color:#fff; font-weight:800;">데이터 파일 업로드</button>
                        <button class="primary-btn" onclick="window.resetPortfolio()" style="margin:0; background:transparent; border:1px solid var(--danger); color:var(--danger); font-weight:800;">🚨 포트폴리오 완전 초기화</button>
                    </div>
                </div>
            </div>
        `;
    } else if (modal === 'loan') {
        let loanListHtml = loans.map((l, idx) => {
            let currentPrincipal = 0; let currentInterest = 0;
            let recordsHtml = l.records.map(rec => {
                currentPrincipal += rec.amount;
                let diffDays = Math.max(0, Math.ceil((today.getTime() - new Date(rec.date).getTime()) / 86400000));
                currentInterest += rec.amount * (l.rate / 100) / 365 * diffDays;
                return `<div style="display:flex; justify-content:space-between; font-size:13px; padding:4px 0;"><span>${rec.date}</span><span>${num(rec.amount)}원</span></div>`;
            }).join('');
            return `<div style="background:var(--surface-sub); padding:12px; border-radius:8px; margin-bottom:10px;"><b>${l.name}</b> (연 ${l.rate}%)<br>잔원금: ${num(currentPrincipal)}원 / 이자: ${num(currentInterest)}원${recordsHtml}</div>`;
        }).join('');
        html += `
            <div class="overlay" id="ovLoan">
                <div class="sheet" id="modalSheet">
                    <div class="sheet-title">🏦 대출 관리<button class="close" onclick="window.closeModal()">✕</button></div>
                    <div style="max-height:300px; overflow-y:auto;">${loanListHtml || '등록된 대출 없음'}</div>
                    <div class="field" style="margin-top:12px;"><label>대출명</label><input type="text" id="loanName"></div>
                    <div class="field"><label>연 이자율 (%)</label><input type="number" step="0.01" id="loanRate"></div>
                    <button class="primary-btn" onclick="window.submitLoanAdd()">대출 등록</button>
                </div>
            </div>
        `;
    }

    app.innerHTML = html;
    Object.keys(tempInputs).forEach(id => { let el = document.getElementById(id); if(el) el.value = tempInputs[id]; });
    if (focusedElementId) { let el = document.getElementById(focusedElementId); if (el) { el.focus(); try { el.setSelectionRange(cursorPosition, cursorPosition); } catch(e){} } }
    window.scrollTo(0, scrollY);
    if (document.getElementById('modalSheet')) document.getElementById('modalSheet').scrollTop = sheetScroll;
}

window.setViewMode = function(mode) { viewMode = mode; render(); }
window.setSearchText = function(text) { searchText = text; render(); }
window.setSortBy = function(sort) { sortBy = sort; render(); }
window.openLoanModal = function() { modal = 'loan'; render(); }
window.openDataModal = function() { modal = 'data'; render(); }
window.closeModal = function() { modal = null; render(); }

window.downloadTemplate = function() {
    let headers = ["날짜", "구분", "종목명", "코드", "수량", "단가", "환율"];
    let worksheet = XLSX.utils.aoa_to_sheet([headers]);
    let workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    XLSX.writeFile(workbook, "리치맨_포트폴리오_양식.xlsx");
}

window.resetPortfolio = function() {
    if (confirm('모든 매매 기록을 삭제하시겠습니까?')) {
        savedTxs = []; transactions = [];
        localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));
        window.closeModal();
    }
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
            if(rows.length > 0 && confirm(`총 ${rows.length}개 데이터를 적용하시겠습니까?`)) {
                savedTxs = rows.map(row => ({
                    portfolio: "업로드",
                    date: row['날짜'] || new Date().toISOString().split('T')[0],
                    type: row['구분'] || '국내주식',
                    name: row['종목명'] || '이름없음',
                    code: row['코드'] || '',
                    quantity: Number(row['수량'] || 0),
                    price: Number(row['단가'] || 0),
                    exchangeRate: Number(row['환율'] || 1.0)
                }));
                transactions = [...savedTxs];
                localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));
                window.closeModal();
            }
        } catch (err) { alert('파일 형식이 올바르지 않습니다.'); }
    };
    reader.readAsArrayBuffer(file);
}

window.submitLoanAdd = function() {
    let name = document.getElementById('loanName').value;
    let rate = Number(document.getElementById('loanRate').value);
    if(name && rate) {
        loans.push({ id: Date.now().toString(), name, rate, records: [{ id: Date.now().toString(), date: new Date().toISOString().split('T')[0], amount: 1000000 }] });
        localStorage.setItem('myLoans', JSON.stringify(loans));
        window.closeModal();
    }
}

document.addEventListener('DOMContentLoaded', () => initApp());
