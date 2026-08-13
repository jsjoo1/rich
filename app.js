// 초기 데이터 로드 (initial_data.js 연동)
let transactions = [];
if (typeof initialTransactions !== 'undefined') {
  transactions = initialTransactions;
}

// 대출 설정
let loanSettings = { rate: 5.5 };

let modal = null;
let selectedStock = null; 
let searchText = '';
let sortBy = 'invested_desc'; 
let viewMode = 'list'; 
let chartInstance = null; 

// 실시간 데이터 저장소
let currentPrices = {}; 
let currentUsdKrw = 1300.0; // 기본 환율

// 종목명 -> 티커(코드) 자동 매칭을 위한 딕셔너리 구축
let tickerMap = {};
transactions.forEach(tx => {
    if (tx.name && tx.code) {
        tickerMap[tx.name] = tx.code;
    }
});

function num(n) { return Math.round(n).toLocaleString('ko-KR'); }
function usd(n) { return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }

function getColorClass(val) {
    if (val > 0) return 'c-up';
    if (val < 0) return 'c-down';
    return 'c-even';
}
function getSign(val) {
    return val > 0 ? '+' : '';
}

// 과거 환율 API
async function fetchHistoricalRate(dateStr) {
    try {
        const res = await fetch(`[https://api.frankfurter.app/$](https://api.frankfurter.app/$){dateStr}?from=USD&to=KRW`);
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        return data.rates.KRW;
    } catch (e) {
        return null;
    }
}

if (typeof Chart !== 'undefined') { Chart.defaults.color = '#8f95b2'; }

async function initApp() {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.innerText = "실시간 현재가 및 환율 동기화 중...";

    try {
        const res = await fetch('[https://api.frankfurter.app/latest?from=USD&to=KRW](https://api.frankfurter.app/latest?from=USD&to=KRW)');
        const data = await res.json();
        if (data && data.rates && data.rates.KRW) {
            currentUsdKrw = data.rates.KRW;
        }
    } catch(e) { console.log("환율 로드 실패"); }

    let uniqueTickers = [...new Set(transactions.map(t => t.code || t.name).filter(c => c))];

    // ▼▼▼ 여기에 구글 웹 앱 URL을 붙여넣으세요 ▼▼▼
    const GAS_API_URL = "https://script.google.com/macros/s/AKfycbw49U0md_xKhA1c5P599LDDUnFG81OQFzuE75Y2P9pqsiPAysbLbuVfUv14m4-hwc3e8w/exec"; 
    
    if (GAS_API_URL && GAS_API_URL.startsWith("http")) {
        try {
            const res = await fetch(GAS_API_URL + "?tickers=" + uniqueTickers.join(','));
            const data = await res.json();
            if (data && !data.error) {
                currentPrices = data;
            }
        } catch(e) { console.log("실시간 주가 로드 실패"); }
    }

    render();
}

function render() {
    let focusedElementId = null;
    let cursorPosition = 0;
    if (document.activeElement) {
        focusedElementId = document.activeElement.id;
        if (focusedElementId === 'searchInput') {
            cursorPosition = document.activeElement.selectionStart;
        }
    }

    const app = document.getElementById('app');
    
    let totalInvested = 0;
    let accruedInterest = 0;
    let totalCurrentValue = 0; 
    let portfolio = {};
    const today = new Date();
    
    transactions.forEach(tx => {
        let isOverseas = tx.type === '주식' || tx.type.includes('해외') || tx.exchangeRate > 100 || tx.name.includes('달러');
        let amountKRW = isOverseas ? (tx.quantity * tx.price * tx.exchangeRate) : (tx.quantity * tx.price);
        
        let txDate = new Date(tx.date);
        let diffDays = Math.max(0, Math.ceil((today.getTime() - txDate.getTime()) / (1000 * 60 * 60 * 24)));
        accruedInterest += amountKRW * (loanSettings.rate / 100) / 365 * diffDays;
        
        let tickerKey = tx.code || tx.name;
        let curPrice = currentPrices[tickerKey] || tx.price;
        let curAmountKRW = isOverseas ? (tx.quantity * curPrice * currentUsdKrw) : (tx.quantity * curPrice);

        if(!portfolio[tx.name]) {
            portfolio[tx.name] = { 
                type: tx.type, 
                tickerKey: tickerKey,
                code: tx.code,
                quantity: 0, 
                totalAmountKRW: 0, 
                totalAmountOriginal: 0, 
                currentValueKRW: 0, 
                isOverseas: isOverseas
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

    let activeStocks = Object.keys(portfolio).filter(name => {
        let p = portfolio[name];
        return p.quantity > 0.0001 && name.toLowerCase().includes(searchText.toLowerCase());
    });

    activeStocks.sort((a, b) => {
        let pA = portfolio[a];
        let pB = portfolio[b];
        if (sortBy === 'name_asc') return a.localeCompare(b);
        if (sortBy === 'invested_desc') return pB.totalAmountKRW - pA.totalAmountKRW;
        if (sortBy === 'value_desc') return pB.currentValueKRW - pA.currentValueKRW; 
        return 0;
    });

    let netProfitColor = getColorClass(netProfit);
    let netProfitSign = getSign(netProfit);

    let html = `
        <div class="kw-summary">
            <div class="kw-summary-title">
                총 실질손익(원) 
                <span style="font-size:11px; color:var(--text-soft); font-weight:400; margin-left:6px; background:var(--surface-sub); padding:2px 6px; border-radius:4px;">*대출이자 차감</span>
            </div>
            <div class="kw-summary-main ${netProfitColor}">
                <div class="val">${netProfitSign}${num(netProfit)}</div>
                <div class="pct">${netProfitSign}${realReturnRate.toFixed(2)}%</div>
            </div>
            <div class="kw-summary-grid">
                <div class="kw-sg-item">
                    <span class="lbl">매입금액</span>
                    <span class="val">${num(totalInvested)}</span>
                </div>
                <div class="kw-sg-item">
                    <span class="lbl">평가금액</span>
                    <span class="val">${num(totalCurrentValue)}</span>
                </div>
                <div class="kw-sg-item">
                    <span class="lbl">시세단순손익</span>
                    <span class="val ${getColorClass(marketProfit)}">${getSign(marketProfit)}${num(marketProfit)}</span>
                </div>
                <div class="kw-sg-item">
                    <span class="lbl">누적대출이자</span>
                    <span class="val" style="color:var(--text-soft); font-weight:400;">-${num(accruedInterest)}</span>
                </div>
            </div>
        </div>
        
        <div class="page" style="padding:0;">
            <div class="portfolio-tools">
                <div class="view-toggles">
                    <button class="${viewMode === 'list' ? 'active' : ''}" onclick="window.setViewMode('list')">일반 잔고</button>
                    <button class="${viewMode === 'chart' ? 'active' : ''}" onclick="window.setViewMode('chart')">파이 차트</button>
                </div>
                <div class="filter-sort-row">
                    <input type="text" id="searchInput" placeholder="종목명 검색..." value="${searchText}" oninput="window.setSearchText(this.value)">
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
                    <div class="col-name">종목명</div>
                    <div class="col-pnl">평가손익<br>수익률</div>
                    <div class="col-qty">보유수량<br>평균단가</div>
                    <div class="col-amt">매입금액<br>평가금액</div>
                </div>
        `;
        
        activeStocks.forEach(name => {
            let p = portfolio[name];
            let avgPriceOriginal = p.totalAmountOriginal / p.quantity;
            let displayAvgPrice = p.isOverseas ? usd(avgPriceOriginal) : num(avgPriceOriginal);
            
            let stockProfitKRW = p.currentValueKRW - p.totalAmountKRW;
            let stockReturnRate = p.totalAmountKRW > 0 ? (stockProfitKRW / p.totalAmountKRW) * 100 : 0;
            let pColor = getColorClass(stockProfitKRW);
            let pSign = getSign(stockProfitKRW);
            
            html += `
                <div class="kw-row" onclick="openStockDetail('${name}')">
                    <div class="col-name">
                        <span>${name}</span>
                        <span class="ticker">${p.type || '주식'}</span>
                    </div>
                    <div class="col ${pColor}">
                        <span>${pSign}${num(stockProfitKRW)}</span>
                        <span>${pSign}${stockReturnRate.toFixed(2)}%</span>
                    </div>
                    <div class="col col-qty">
                        <span>${p.quantity.toLocaleString('en-US', {maximumFractionDigits:4})}</span>
                        <span style="color:var(--text-soft); font-size:12px;">${displayAvgPrice}</span>
                    </div>
                    <div class="col col-amt">
                        <span style="color:var(--text-soft);">${num(p.totalAmountKRW)}</span>
                        <span>${num(p.currentValueKRW)}</span>
                    </div>
                </div>
            `;
        });
        
        if(activeStocks.length === 0) {
            html += `<div style="text-align:center; padding: 40px 0; color: var(--text-soft); font-size:14px;">조건에 맞는 종목이 없습니다.</div>`;
        }
        html += `</div>`; 
    } 
    else if (viewMode === 'chart') {
        html += `
            <div class="chart-container">
                ${activeStocks.length > 0 ? '<canvas id="portfolioChart"></canvas>' : '<div style="color:var(--text-soft); font-size:14px;">표시할 데이터가 없습니다.</div>'}
            </div>
        `;
    }

    html += `</div>`;
    html += `<button class="fab" id="fabAdd">+</button>`;

    if(modal === 'add') {
        let pName = selectedStock || '';
        let pType = '국내주식';
        let pCode = '';
        if (selectedStock && portfolio[selectedStock]) {
            pType = portfolio[selectedStock].isOverseas ? '주식(해외)' : '국내주식';
            pCode = portfolio[selectedStock].code || '';
        }

        html += `
            <div class="overlay" id="ovAdd">
                <div class="sheet">
                    <div class="sheet-title">새 종목 추가<button class="close" onclick="closeModal()">✕</button></div>
                    <div class="field"><label>날짜</label><input type="date" id="addDate" value="${new Date().toISOString().split('T')[0]}"></div>
                    <div class="field"><label>구분</label>
                        <select id="addType">
                            <option value="국내주식" ${pType === '국내주식' ? 'selected' : ''}>국내주식</option>
                            <option value="주식(해외)" ${pType === '주식(해외)' ? 'selected' : ''}>주식(해외)</option>
                        </select>
                    </div>
                    <div class="field"><label>종목명 (입력 시 티커 자동완성)</label><input type="text" id="addName" placeholder="예: 삼성전자" value="${pName}"></div>
                    <div class="field"><label>종목코드 / 티커 (API 연동용)</label><input type="text" id="addCode" placeholder="예: KRX:005930 또는 AAPL" value="${pCode}"></div>
                    <div class="field"><label>수량 (매도 시 -음수 입력)</label><input type="number" step="0.0001" id="addQty" placeholder="예: 매수 10 / 매도 -5"></div>
                    <div class="field"><label>거래 단가</label><input type="number" step="0.01" id="addPrice" placeholder="0"></div>
                    
                    <div class="field" id="rateFieldWrap" style="${pType === '주식(해외)' ? 'display:block;' : 'display:none;'}">
                        <label>환율 (선택일 자동조회)</label>
                        <input type="number" step="0.1" id="addRate" value="${currentUsdKrw.toFixed(1)}">
                        <div style="font-size:11px; color:var(--text-soft); margin-top:4px;" id="rateMsg">환율 정보 조회 중...</div>
                    </div>
                    <button class="primary-btn" onclick="submitAdd()">기록 추가</button>
                </div>
            </div>
        `;
    } 
    else if (modal === 'detail' && selectedStock) {
        let pInfo = portfolio[selectedStock] || { isOverseas: false, currentValueKRW: 0, tickerKey: '', code: '' };
        let curP = currentPrices[pInfo.tickerKey] ? currentPrices[pInfo.tickerKey] : null;
        
        let stockTxs = transactions.filter(tx => tx.name === selectedStock).sort((a,b) => new Date(b.date) - new Date(a.date));
        let listHtml = stockTxs.map(tx => {
            let isOvs = tx.type === '주식' || tx.type.includes('해외') || tx.exchangeRate > 100 || tx.name.includes('달러');
            let pStr = isOvs ? usd(tx.price) : num(tx.price)+'원';
            let actionType = tx.quantity > 0 ? '<span class="c-up">매수</span>' : '<span class="c-down">매도</span>';
            
            return `
                <div class="detail-tx-item">
                    <div class="detail-tx-date">${tx.date}<br><span style="font-size:12px; font-weight:400; color:var(--text-soft)">${actionType}</span></div>
                    <div class="detail-tx-info">
                        <span class="qty">${Math.abs(tx.quantity).toLocaleString('en-US', {maximumFractionDigits:4})}주</span>
                        <span class="price">단가: ${pStr}</span>
                    </div>
                </div>
            `;
        }).join('');

        html += `
            <div class="overlay" id="ovDetail">
                <div class="sheet">
                    <div class="sheet-title" style="margin-bottom:20px;">
                        <div>
                            <div style="font-size:20px;">${selectedStock}</div>
                            <div style="font-size:12px; color:var(--text-soft); font-weight:400; margin-top:4px;">
                                실시간 주가: ${curP ? (pInfo.isOverseas ? usd(curP) : num(curP)+'원') : 'API 연동 전'}
                            </div>
                        </div>
                        <button class="close" onclick="closeModal()">✕</button>
                    </div>
                    
                    <div style="background: var(--surface-sub); padding: 16px 16px 4px; border-radius: 16px; margin-bottom: 24px;">
                        <div style="font-size: 13px; font-weight: 800; margin-bottom: 12px; color: var(--text);">📝 이 종목 신규 기록 추가</div>
                        <div class="filter-sort-row" style="margin-bottom:8px;">
                            <input type="date" id="detailAddDate" value="${new Date().toISOString().split('T')[0]}" style="flex:1;">
                            <input type="number" step="0.0001" id="detailAddQty" placeholder="수량 (-매도)" style="flex:1;">
                        </div>
                        <div class="filter-sort-row" style="margin-bottom:12px;">
                            <input type="number" step="0.01" id="detailAddPrice" placeholder="거래 단가" style="flex:1;">
                            ${pInfo.isOverseas ? `<input type="number" step="0.1" id="detailAddRate" value="${currentUsdKrw.toFixed(1)}" style="flex:1;" title="환율">` : `<input type="hidden" id="detailAddRate" value="1.0">`}
                        </div>
                        ${pInfo.isOverseas ? `<div style="font-size:11px; color:var(--text-soft); text-align:right; margin-bottom:12px;" id="detailRateMsg">오늘 기준 환율이 입력되었습니다.</div>` : ''}
                        
                        <button class="primary-btn" onclick="submitDetailAdd('${pInfo.code}')" style="margin-top: 0; margin-bottom: 12px;">기록 추가하기</button>
                    </div>

                    <div style="font-size: 14px; font-weight: 800; margin-bottom: 8px;">최근 체결 내역</div>
                    <div class="detail-tx-list">
                        ${listHtml}
                    </div>
                </div>
            </div>
        `;
    }

    app.innerHTML = html;

    if (focusedElementId) {
        let el = document.getElementById(focusedElementId);
        if (el) {
            el.focus();
            if (focusedElementId === 'searchInput') {
                el.setSelectionRange(cursorPosition, cursorPosition);
            }
        }
    }

    if (viewMode === 'chart' && activeStocks.length > 0) {
        renderChart(activeStocks, portfolio);
    }

    let fab = document.getElementById('fabAdd');
    if(fab) fab.onclick = () => { selectedStock = null; modal = 'add'; render(); setTimeout(bindModalEvents, 50); };
    let ovAdd = document.getElementById('ovAdd');
    if(ovAdd) ovAdd.onclick = (e) => { if(e.target === ovAdd) closeModal(); };
    let ovDetail = document.getElementById('ovDetail');
    if(ovDetail) ovDetail.onclick = (e) => { if(e.target === ovDetail) closeModal(); };
}

window.setViewMode = function(mode) { viewMode = mode; render(); }
window.setSearchText = function(text) { searchText = text; render(); }
window.setSortBy = function(sort) { sortBy = sort; render(); }

window.openStockDetail = function(name) {
    selectedStock = name;
    modal = 'detail';
    render();
    setTimeout(bindDetailRateEvent, 50);
}

window.submitDetailAdd = function(code) {
    let date = document.getElementById('detailAddDate').value;
    let qty = Number(document.getElementById('detailAddQty').value);
    let price = Number(document.getElementById('detailAddPrice').value);
    let rate = Number(document.getElementById('detailAddRate').value) || 1.0;
    
    if(!qty || !price) {
        showToast('수량과 단가를 입력해주세요');
        return;
    }
    
    let pObj = transactions.find(t => t.name === selectedStock);
    let type = pObj ? pObj.type : '국내주식';

    transactions.unshift({
        portfolio: "수동입력",
        date: date,
        type: type,
        name: selectedStock,
        code: code || '',
        quantity: qty,
        price: price,
        exchangeRate: type.includes('해외') || type === '주식' ? rate : 1.0
    });

    render(); 
    showToast('매매 기록이 추가되었습니다.');
    setTimeout(bindDetailRateEvent, 50);
}

function bindDetailRateEvent() {
    const dateInput = document.getElementById('detailAddDate');
    const rateInput = document.getElementById('detailAddRate');
    const rateMsg = document.getElementById('detailRateMsg');
    
    if(!rateInput || rateInput.type === 'hidden') return;

    async function checkRate() {
        rateMsg.textContent = '선택일 환율 조회 중...';
        rateMsg.style.color = 'var(--text-soft)';
        const rate = await fetchHistoricalRate(dateInput.value);
        if(rate) {
            rateInput.value = rate;
            rateMsg.textContent = `(${dateInput.value} 환율 ${rate}원 적용됨)`;
            rateMsg.style.color = 'var(--ok)';
        } else {
            rateMsg.textContent = '조회 실패. 직접 입력해주세요.';
            rateMsg.style.color = 'var(--danger)';
        }
    }
    dateInput.addEventListener('change', checkRate);
}

function renderChart(stocks, portfolioData) {
    let ctx = document.getElementById('portfolioChart').getContext('2d');
    if (chartInstance) chartInstance.destroy(); 

    let labels = stocks;
    let data = stocks.map(name => portfolioData[name].currentValueKRW);
    let bgColors = stocks.map((_, i) => `hsl(${(i * 360 / stocks.length) % 360}, 70%, 60%)`);

    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: bgColors,
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 12, color: '#8f95b2' } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.label || '';
                            if (label) label += ': ';
                            label += won(context.raw);
                            return label;
                        }
                    }
                }
            }
        }
    });
}

function bindModalEvents() {
    const addType = document.getElementById('addType');
    const addDate = document.getElementById('addDate');
    const rateFieldWrap = document.getElementById('rateFieldWrap');
    const addRate = document.getElementById('addRate');
    const rateMsg = document.getElementById('rateMsg');
    const addName = document.getElementById('addName');
    const addCode = document.getElementById('addCode');

    // 종목명 입력 시 티커 자동 매칭 이벤트
    addName.addEventListener('input', function() {
        let n = this.value.trim();
        if (tickerMap[n]) {
            addCode.value = tickerMap[n];
        }
    });

    async function checkRate() {
        if (addType.value.includes('해외')) {
            rateFieldWrap.style.display = 'block';
            rateMsg.textContent = '환율 정보 조회 중...';
            rateMsg.style.color = 'var(--text-soft)';
            
            const rate = await fetchHistoricalRate(addDate.value);
            if (rate) {
                addRate.value = rate;
                rateMsg.textContent = `(${addDate.value} 환율 ${rate}원 적용됨)`;
                rateMsg.style.color = 'var(--ok)';
            } else {
                rateMsg.textContent = '조회 실패. 직접 입력해주세요.';
                rateMsg.style.color = 'var(--danger)';
            }
        } else {
            rateFieldWrap.style.display = 'none';
            addRate.value = 1.0;
        }
    }

    addType.addEventListener('change', checkRate);
    addDate.addEventListener('change', checkRate);
    checkRate();
}

window.closeModal = function() {
    modal = null;
    selectedStock = null;
    render();
}

window.submitAdd = function() {
    let date = document.getElementById('addDate').value;
    let type = document.getElementById('addType').value;
    let name = document.getElementById('addName').value.trim();
    let code = document.getElementById('addCode').value.trim();
    let qty = Number(document.getElementById('addQty').value);
    let price = Number(document.getElementById('addPrice').value);
    let rate = Number(document.getElementById('addRate').value) || 1.0;

    if(!name || !qty || !price) {
        showToast('필수 정보를 입력해주세요');
        return;
    }

    if (code) tickerMap[name] = code;

    transactions.unshift({
        portfolio: "수동입력",
        date: date,
        type: type,
        name: name,
        code: code,
        quantity: qty,
        price: price,
        exchangeRate: type.includes('해외') ? rate : 1.0
    });

    closeModal();
    showToast('새로운 종목이 추가되었습니다.');
}

function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2200);
}

document.addEventListener('DOMContentLoaded', () => {
    initApp(); 
});
