let transactions = [];
if (typeof initialTransactions !== 'undefined') {
  transactions = [...initialTransactions];
}

let savedTxs = JSON.parse(localStorage.getItem('mySavedTxs') || '[]');
transactions = [...savedTxs, ...transactions];

let loans = JSON.parse(localStorage.getItem('myLoans') || '[]');
// 기존 대출 데이터가 있다면 새로운 "내역(records)" 기반 구조로 자동 마이그레이션
loans = loans.map(l => {
    if(!l.id) l.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    if(!l.records) {
        l.records = [];
        if(l.amount && Number(l.amount) > 0) {
            l.records.push({
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                date: l.startDate || new Date().toISOString().split('T')[0],
                amount: Number(l.amount)
            });
        }
    }
    return l;
});
localStorage.setItem('myLoans', JSON.stringify(loans));

let modal = null;
let selectedStock = null; 
let searchText = '';
let sortBy = 'invested_desc'; 
let viewMode = 'list'; 
let chartInstance = null; 

let currentPrices = {}; 
let currentUsdKrw = 1300.0; 

let tickerMap = {};
transactions.forEach(tx => {
    if (tx.name && tx.code) {
        tickerMap[tx.name] = tx.code;
    }
});

function isTxOverseas(tx) {
    if (!tx) return false;
    if (tx.exchangeRate > 100) return true; 
    if (tx.type && tx.type.includes('해외')) return true; 
    if (tx.name === '달러') return true; 
    if (tx.type === '주식') {
        if (tx.code && (tx.code.includes('KRX') || tx.code.includes('KOSDAQ'))) return false;
        return true;
    }
    return false;
}

// ▼▼▼ 여기에 직접 발급받으신 구글 웹앱 URL을 붙여넣으세요 ▼▼▼
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbybtTcU_U83nQwiSjOriBk02wJcBdJ98Pmb-rfOQ1rsW4MvGR_BwwDnxBhKjBshr3kzRA/exec"; 

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

async function fetchHistoricalRate(dateStr) {
    try {
        const res = await fetch(`https://api.frankfurter.app/${dateStr}?from=USD&to=KRW`);
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        return data.rates.KRW;
    } catch (e) {
        return null;
    }
}

if (typeof Chart !== 'undefined') { Chart.defaults.color = '#8f95b2'; }

async function updatePricesInBackground() {
    let uniqueTickers = [...new Set(transactions.map(t => t.code || t.name).filter(c => c))];
    
    let ratePromise = fetch('https://api.frankfurter.app/latest?from=USD&to=KRW')
        .then(res => res.json())
        .then(data => { if (data && data.rates && data.rates.KRW) currentUsdKrw = data.rates.KRW; })
        .catch(e => console.log("환율 로드 실패"));

    let pricePromise = Promise.resolve();
    if (GAS_API_URL && GAS_API_URL.startsWith("http")) {
        pricePromise = fetch(GAS_API_URL + "?tickers=" + uniqueTickers.join(','))
            .then(res => res.json())
            .then(data => { if (data && !data.error) currentPrices = data; })
            .catch(e => console.log("실시간 주가 로드 실패"));
    }

    await Promise.all([ratePromise, pricePromise]);
    render(); 
}

async function initApp() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:80vh; gap:16px;">
            <div style="font-size:16px; font-weight:700; color:var(--text-soft);">실시간 가격 정보를 불러오는 중입니다...</div>
            <div style="font-size:13px; color:var(--text-soft); opacity:0.7;">잠시만 기다려 주세요.</div>
        </div>
    `;

    await updatePricesInBackground();
    setInterval(updatePricesInBackground, 5000);
}

function render() {
    let focusedElementId = null;
    let cursorPosition = 0;
    if (document.activeElement && document.activeElement.id) {
        focusedElementId = document.activeElement.id;
        try { cursorPosition = document.activeElement.selectionStart || 0; } catch(e){}
    }

    // 💡 화면 안의 모든 input, select 값을 싹 다 기억 (동적 ID 포함)
    let tempInputs = {};
    document.querySelectorAll('input, select').forEach(el => {
        if(el.id) tempInputs[el.id] = el.value;
    });

    const app = document.getElementById('app');
    const today = new Date();
    
    let totalInvested = 0;
    let accruedInterest = 0;
    let totalCurrentValue = 0; 
    let portfolio = {};
    
    // 💡 정밀한 일할 대출 이자 계산 (내역 기반)
    loans.forEach(loan => {
        loan.records.forEach(rec => {
            let recDate = new Date(rec.date);
            let diffDays = Math.max(0, Math.ceil((today.getTime() - recDate.getTime()) / (1000 * 60 * 60 * 24)));
            accruedInterest += rec.amount * (loan.rate / 100) / 365 * diffDays;
        });
    });
    
    transactions.forEach(tx => {
        let isOverseas = isTxOverseas(tx);
        let amountKRW = isOverseas ? (tx.quantity * tx.price * tx.exchangeRate) : (tx.quantity * tx.price);
        
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
                <div class="kw-sg-item" style="cursor:pointer;" onclick="openLoanModal()">
                    <span class="lbl" style="color:var(--primary); font-weight:700; display:flex; align-items:center; gap:4px;">
                        누적대출이자 <span style="background:var(--surface-sub); padding:2px 6px; border-radius:4px; font-size:10px;">⚙️ 관리</span>
                    </span>
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
            
            let curPriceRaw = currentPrices[p.tickerKey] || avgPriceOriginal;
            let displayCurPrice = p.isOverseas ? usd(curPriceRaw) : num(curPriceRaw);

            let stockProfitKRW = p.currentValueKRW - p.totalAmountKRW;
            let stockReturnRate = p.totalAmountKRW > 0 ? (stockProfitKRW / p.totalAmountKRW) * 100 : 0;
            let pColor = getColorClass(stockProfitKRW);
            let pSign = getSign(stockProfitKRW);
            
            html += `
                <div class="kw-row" onclick="openStockDetail('${name}')">
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
            let isOvs = isTxOverseas(tx);
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
                                실시간 주가: <span style="font-weight:700; color:var(--text);">${curP ? (pInfo.isOverseas ? usd(curP) : num(curP)+'원') : 'API 연동 전'}</span>
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
    // 💡 대출 관리 모달창
    else if (modal === 'loan') {
        let loanListHtml = loans.map((l, idx) => {
            let currentPrincipal = 0;
            let currentInterest = 0;
            let todayTime = today.getTime();

            // 기록(실행/상환) 목록 생성 및 잔액/이자 계산
            let recordsHtml = l.records.sort((a,b)=> new Date(b.date) - new Date(a.date)).map(rec => {
                currentPrincipal += rec.amount;
                let recTime = new Date(rec.date).getTime();
                let diffDays = Math.max(0, Math.ceil((todayTime - recTime) / (1000 * 60 * 60 * 24)));
                currentInterest += rec.amount * (l.rate / 100) / 365 * diffDays;

                let isRepay = rec.amount < 0;
                let amtStr = isRepay ? num(rec.amount) : '+' + num(rec.amount);
                let color = isRepay ? 'var(--primary)' : 'var(--danger)';

                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding: 6px 0; border-bottom:1px solid rgba(255,255,255,0.02); font-size:13px;">
                        <span style="color:var(--text-soft);">${rec.date}</span>
                        <div>
                            <span style="color:${color}; font-weight:600; margin-right:8px;">${amtStr}원</span>
                            <button onclick="deleteLoanRecord('${l.id}', '${rec.id}')" style="background:var(--surface); border:1px solid var(--line); color:var(--text-soft); font-size:10px; cursor:pointer; padding:2px 6px; border-radius:4px;">삭제</button>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div style="background:var(--surface-sub); padding:16px; border-radius:12px; margin-bottom:16px; border:1px solid rgba(255,255,255,0.05);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <span style="font-weight:800; color:var(--text); font-size:16px;">${l.name} <span style="font-size:12px; color:var(--primary); margin-left:4px; font-weight:600;">연 ${l.rate}%</span></span>
                        <div>
                            <button onclick="editLoan('${l.id}')" style="background:transparent; border:none; color:var(--text); cursor:pointer; font-size:13px; padding:4px 8px;">수정</button>
                            <button onclick="deleteLoan('${l.id}')" style="background:transparent; border:none; color:var(--danger); cursor:pointer; font-size:13px; padding:4px 8px;">대출삭제</button>
                        </div>
                    </div>
                    
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:14px;">
                        <span style="color:var(--text-soft);">현재 남은 원금 (잔액)</span>
                        <span style="font-weight:700;">${num(currentPrincipal)}원</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:16px; font-size:14px;">
                        <span style="color:var(--text-soft);">발생한 누적 이자</span>
                        <span style="font-weight:700; color:var(--danger);">${num(currentInterest)}원</span>
                    </div>

                    <div style="background:rgba(0,0,0,0.15); padding:12px; border-radius:8px; margin-bottom:12px;">
                        <div style="font-size:12px; color:var(--text-soft); margin-bottom:8px; font-weight:700;">대출 실행 및 상환 내역</div>
                        ${recordsHtml}
                        ${l.records.length === 0 ? '<div style="font-size:12px; color:var(--text-soft);">내역이 없습니다. (아래에서 추가해주세요)</div>' : ''}
                    </div>

                    <div style="display:flex; gap:6px;">
                        <input type="date" id="recDate_${l.id}" value="${new Date().toISOString().split('T')[0]}" style="flex:1; font-size:13px; padding:10px; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:8px;">
                        <input type="number" id="recAmt_${l.id}" placeholder="실행금액 (-상환)" style="flex:1.5; font-size:13px; padding:10px; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:8px;">
                        <button onclick="addLoanRecord('${l.id}')" style="background:var(--primary); color:#fff; border:none; border-radius:8px; padding:0 14px; font-size:13px; font-weight:700; cursor:pointer;">내역 추가</button>
                    </div>
                </div>
            `;
        }).join('');

        html += `
            <div class="overlay" id="ovLoan">
                <div class="sheet">
                    <div class="sheet-title" style="margin-bottom:24px;">🏦 대출 및 이자 관리<button class="close" onclick="closeModal()">✕</button></div>
                    
                    <div style="max-height: 400px; overflow-y:auto; margin-bottom:24px;">
                        ${loanListHtml}
                        ${loans.length === 0 ? `<div style="text-align:center; padding:30px; color:var(--text-soft); font-size:14px;">등록된 대출이 없습니다.<br>아래에서 추가해주세요.</div>` : ''}
                    </div>

                    <div style="border-top:1px dashed var(--line); padding-top:20px;">
                        <div style="font-size: 15px; font-weight: 800; margin-bottom: 16px; color: var(--text);" id="loanFormTitle">+ 새로운 대출 추가</div>
                        
                        <input type="hidden" id="editLoanId" value="">
                        <div class="field"><label>대출명 (예: 신한 마통, 전세자금대출)</label><input type="text" id="loanName" placeholder="대출 이름 입력"></div>
                        <div class="field"><label>연 이자율 (%)</label><input type="number" step="0.01" id="loanRate" placeholder="예: 5.5"></div>
                        
                        <button class="primary-btn" onclick="submitLoanAdd()" id="loanSubmitBtn" style="margin-top: 10px;">대출 등록하기</button>
                    </div>
                </div>
            </div>
        `;
    }

    app.innerHTML = html;

    // 💡 저장해둔 사용자 폼 입력값 및 포커스 복구 (10초 새로고침에도 입력내용 날아감 방지)
    Object.keys(tempInputs).forEach(id => {
        let el = document.getElementById(id);
        if(el && tempInputs[id] !== undefined) el.value = tempInputs[id];
    });

    if (focusedElementId) {
        let el = document.getElementById(focusedElementId);
        if (el) {
            el.focus();
            try { el.setSelectionRange(cursorPosition, cursorPosition); } catch(e){}
        }
    }

    if (viewMode === 'chart' && activeStocks.length > 0) {
        renderChart(activeStocks, portfolio);
    }

    let fab = document.getElementById('fabAdd');
    if(fab) fab.onclick = () => { selectedStock = null; modal = 'add'; render(); };
    let ovAdd = document.getElementById('ovAdd');
    if(ovAdd) ovAdd.onclick = (e) => { if(e.target === ovAdd) closeModal(); };
    let ovDetail = document.getElementById('ovDetail');
    if(ovDetail) ovDetail.onclick = (e) => { if(e.target === ovDetail) closeModal(); };
    let ovLoan = document.getElementById('ovLoan');
    if(ovLoan) ovLoan.onclick = (e) => { if(e.target === ovLoan) closeModal(); };

    if (modal === 'add') {
        bindModalEvents();
    } else if (modal === 'detail' && selectedStock) {
        bindDetailRateEvent();
    }
}

window.setViewMode = function(mode) { viewMode = mode; render(); }
window.setSearchText = function(text) { searchText = text; render(); }
window.setSortBy = function(sort) { sortBy = sort; render(); }

window.openStockDetail = function(name) {
    selectedStock = name;
    modal = 'detail';
    render();
}

window.openLoanModal = function() {
    modal = 'loan';
    render();
}

// 💡 대출 모달의 액션 함수들
window.submitLoanAdd = function() {
    let id = document.getElementById('editLoanId').value;
    let name = document.getElementById('loanName').value.trim();
    let rate = Number(document.getElementById('loanRate').value);

    if (!name || !rate) {
        showToast('대출명과 이자율을 정확히 입력해주세요.');
        return;
    }

    if (id) {
        let loan = loans.find(l => l.id === id);
        if(loan) {
            loan.name = name;
            loan.rate = rate;
        }
    } else {
        loans.push({ 
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            name: name, 
            rate: rate, 
            records: [] 
        });
    }
    
    localStorage.setItem('myLoans', JSON.stringify(loans));
    
    // 입력폼 초기화
    document.getElementById('editLoanId').value = '';
    document.getElementById('loanName').value = '';
    document.getElementById('loanRate').value = '';
    document.getElementById('loanFormTitle').innerText = '+ 새로운 대출 추가';
    document.getElementById('loanSubmitBtn').innerText = '대출 등록하기';
    
    render();
    showToast(id ? '대출 정보가 수정되었습니다.' : '새 대출이 등록되었습니다.');
}

window.editLoan = function(id) {
    let loan = loans.find(l => l.id === id);
    if(loan) {
        document.getElementById('editLoanId').value = loan.id;
        document.getElementById('loanName').value = loan.name;
        document.getElementById('loanRate').value = loan.rate;
        document.getElementById('loanFormTitle').innerText = '✏️ 대출 정보 수정';
        document.getElementById('loanSubmitBtn').innerText = '대출 수정완료';
    }
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
    
    if(!date || !amount) {
        showToast('날짜와 금액을 정확히 입력해주세요.');
        return;
    }

    let loan = loans.find(l => l.id === loanId);
    if(loan) {
        loan.records.push({
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            date: date,
            amount: amount
        });
        localStorage.setItem('myLoans', JSON.stringify(loans));
        
        amtInput.value = ''; // 금액칸 비우기
        render();
        showToast('대출/상환 내역이 추가되었습니다.');
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

window.submitDetailAdd = function(code) {
    let dateInput = document.getElementById('detailAddDate');
    let qtyInput = document.getElementById('detailAddQty');
    let priceInput = document.getElementById('detailAddPrice');
    let rateInput = document.getElementById('detailAddRate');
    
    let date = dateInput.value;
    let qty = Number(qtyInput.value);
    let price = Number(priceInput.value);
    let rate = rateInput ? (Number(rateInput.value) || 1.0) : 1.0;
    
    if(!qty || !price) {
        showToast('수량과 단가를 입력해주세요');
        return;
    }
    
    let pObj = transactions.find(t => t.name === selectedStock);
    let type = pObj ? pObj.type : '국내주식';

    let newTx = {
        portfolio: "수동입력",
        date: date,
        type: type,
        name: selectedStock,
        code: code || '',
        quantity: qty,
        price: price,
        exchangeRate: isTxOverseas(pObj) ? rate : 1.0
    };

    transactions.unshift(newTx);
    savedTxs.unshift(newTx);
    localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs)); // 영구 보존

    qtyInput.value = '';
    priceInput.value = '';

    render(); 
    showToast('매매 기록이 영구적으로 추가되었습니다.');
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

    addName.addEventListener('input', function() {
        let n = this.value.trim();
        
        if (n === '') {
            addCode.value = ''; 
        } 
        else if (tickerMap[n]) {
            addCode.value = tickerMap[n]; 
        } 
        else if (/^[a-zA-Z0-9]+$/.test(n) && addType.value.includes('해외')) {
            addCode.value = n.toUpperCase();
        }
        else {
            addCode.value = ''; 
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

    let isOvs = type.includes('해외') || type === '주식';

    let newTx = {
        portfolio: "수동입력",
        date: date,
        type: type,
        name: name,
        code: code,
        quantity: qty,
        price: price,
        exchangeRate: isOvs ? rate : 1.0
    };

    transactions.unshift(newTx);
    savedTxs.unshift(newTx);
    localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs)); 

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
