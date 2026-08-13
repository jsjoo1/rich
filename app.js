let transactions = [];
if (typeof initialTransactions !== 'undefined') { transactions = [...initialTransactions]; }
let savedTxs = JSON.parse(localStorage.getItem('mySavedTxs') || '[]');
if (localStorage.getItem('mySavedTxs')) { transactions = [...savedTxs]; } else { transactions = [...savedTxs, ...transactions]; }

let loans = JSON.parse(localStorage.getItem('myLoans') || '[]');
loans = loans.map(l => {
    if(!l.id) l.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    if(!l.records) { l.records = []; if(l.amount && Number(l.amount) > 0) { l.records.push({id: Date.now().toString(), date: l.startDate || new Date().toISOString().split('T')[0], amount: Number(l.amount)}); } }
    return l;
});
localStorage.setItem('myLoans', JSON.stringify(loans));

let modal = null; let selectedStock = null; let searchText = ''; let sortBy = 'invested_desc'; let viewMode = 'list'; let chartInstance = null;
let currentPrices = {}; let currentUsdKrw = 1300.0;
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

async function fetchHistoricalRate(dateStr) {
    try { const res = await fetch(`https://api.frankfurter.app/${dateStr}?from=USD&to=KRW`); const data = await res.json(); return data.rates.KRW; } catch (e) { return null; }
}

async function updatePricesInBackground() {
    let validTxs = transactions.filter(t => {
        if (!t.type && !t.name) return false;
        let type = (t.type || '').toLowerCase();
        let name = (t.name || '').toLowerCase();
        if (type.includes('코인') || name.includes('krw') || name.includes('현금') || name.includes('달러')) return false;
        if (type.includes('손익') || type.includes('분배') || type.includes('배당')) return false;
        return true;
    });

    let uniqueTickers = [...new Set(validTxs.map(t => (t.code || t.name).trim()).filter(c => c))];
    
    let ratePromise = fetch('https://api.frankfurter.app/latest?from=USD&to=KRW')
        .then(res => res.json())
        .then(data => { if (data && data.rates && data.rates.KRW) currentUsdKrw = data.rates.KRW; })
        .catch(e => console.log("환율 로드 실패"));

    let pricePromise = Promise.resolve();

    if (GAS_API_URL && GAS_API_URL.startsWith("http") && uniqueTickers.length > 0) {
        // 💡 핵심: 티커가 많으면(60개 이상) GAS 실행 시간이 길어져 CORS 헤더 없는 오류(net::ERR_FAILED)가 발생함.
        // 15개씩 나눠서 여러 요청을 동시에(병렬로) 보내면 각 요청이 짧게 끝나서 타임아웃을 피할 수 있음.
        const BATCH_SIZE = 15;
        let batches = [];
        for (let i = 0; i < uniqueTickers.length; i += BATCH_SIZE) {
            batches.push(uniqueTickers.slice(i, i + BATCH_SIZE));
        }

        let batchPromises = batches.map(batch => {
            let tickersQuery = encodeURIComponent(batch.join(','));
            return fetch(GAS_API_URL + "?tickers=" + tickersQuery)
                .then(res => {
                    if (!res.ok) throw new Error("Server HTTP Error: " + res.status);
                    return res.json();
                })
                .then(data => {
                    if (data && !data.error) {
                        let resultData = data.result || data.data || data;
                        Object.assign(currentPrices, resultData); // 배치별 결과를 순서 상관없이 병합
                    }
                })
                .catch(e => {
                    console.error("실시간 주가 배치 로드 실패:", batch, e);
                });
        });

        pricePromise = Promise.all(batchPromises);
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
    let timeout = setTimeout(() => { if (!loaded) { loaded = true; render(); } }, 10000);
    
    await updatePricesInBackground();
    
    if (!loaded) { loaded = true; clearTimeout(timeout); render(); }
    
    // 💡 핵심: API 쿼터 초과 방지를 위해 60초 간격으로 갱신 주기 연장
    setInterval(updatePricesInBackground, 60000);
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
            let diffDays = Math.max(0, Math.ceil((today.getTime() - new Date(rec.date).getTime()) / 86400000)); 
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
                
                let isRepay = rec.amount < 0;
                let amtStr = isRepay ? num(rec.amount) : '+' + num(rec.amount);
                let color = isRepay ? 'var(--primary)' : 'var(--danger)';

                return `<div style="display:flex; justify-content:space-between; align-items:center; padding: 6px 0; border-bottom:1px solid rgba(255,255,255,0.02); font-size:13px;">
                            <span style="color:var(--text-soft);">${rec.date}</span>
                            <div>
                                <span style="color:${color}; font-weight:600; margin-right:8px;">${amtStr}원</span>
                                <button onclick="window.deleteLoanRecord('${l.id}', '${rec.id}')" style="background:var(--surface); border:1px solid var(--line); color:var(--text-soft); font-size:10px; cursor:pointer; padding:2px 6px; border-radius:4px;">삭제</button>
                            </div>
                        </div>`;
            }).join('');
            
            return `
                <div style="background:var(--surface-sub); padding:16px; border-radius:12px; margin-bottom:16px; border:1px solid rgba(255,255,255,0.05);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <span style="font-weight:800; color:var(--text); font-size:16px;">${l.name} <span style="font-size:12px; color:var(--primary); margin-left:4px; font-weight:600;">연 ${l.rate}%</span></span>
                        <div>
                            <button onclick="window.deleteLoan('${l.id}')" style="background:transparent; border:none; color:var(--danger); cursor:pointer; font-size:13px; padding:4px 8px;">대출삭제</button>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:14px;"><span style="color:var(--text-soft);">현재 잔액</span><span style="font-weight:700;">${num(currentPrincipal)}원</span></div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:16px; font-size:14px;"><span style="color:var(--text-soft);">누적 이자</span><span style="font-weight:700; color:var(--danger);">${num(currentInterest)}원</span></div>
                    <div style="background:rgba(0,0,0,0.15); padding:12px; border-radius:8px; margin-bottom:12px;">
                        <div style="font-size:12px; color:var(--text-soft); margin-bottom:8px; font-weight:700;">대출 실행 및 상환 내역</div>
                        ${recordsHtml || '<div style="font-size:12px; color:var(--text-soft);">내역이 없습니다.</div>'}
                    </div>
                    <div style="display:flex; gap:6px;">
                        <input type="date" id="recDate_${l.id}" value="${new Date().toISOString().split('T')[0]}" style="flex:1; font-size:13px; padding:10px; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:8px;">
                        <input type="number" id="recAmt_${l.id}" placeholder="금액 (-상환)" style="flex:1.5; font-size:13px; padding:10px; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:8px;">
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
                        <div class="field"><label>대출명</label><input type="text" id="loanName"></div>
                        <div class="field"><label>연 이자율 (%)</label><input type="number" step="0.01" id="loanRate"></div>
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
    let headers = ["날짜", "구분", "종목명", "코드", "수량", "단가", "환율"];
    let worksheet = XLSX.utils.aoa_to_sheet([headers]);
    let workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    XLSX.writeFile(workbook, "리치맨_포트폴리오_양식.xlsx");
}

window.resetPortfolio = function() {
    if (confirm('모든 매매 기록을 삭제하시겠습니까? (대출 내역은 보존됩니다)')) {
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
                savedTxs = rows.map(row => {
                    let d = row['날짜'] || new Date().toISOString().split('T')[0];
                    if (typeof d === 'number') {
                        let dateObj = new Date(Math.round((d - 25569) * 86400 * 1000));
                        d = dateObj.toISOString().split('T')[0];
                    }
                    return {
                        portfolio: "업로드",
                        date: d,
                        type: row['구분'] || '국내주식',
                        name: row['종목명'] || '이름없음',
                        code: row['코드'] || '',
                        quantity: Number(row['수량'] || 0),
                        price: Number(row['단가'] || 0),
                        exchangeRate: Number(row['환율'] || 1.0)
                    };
                });
                transactions = [...savedTxs];
                localStorage.setItem('mySavedTxs', JSON.stringify(savedTxs));
                window.closeModal();
                showToast('데이터가 적용되었습니다. 페이지를 새로고침합니다.');
                setTimeout(() => location.reload(), 1500);
            }
        } catch (err) { alert('파일 형식이 올바르지 않습니다.'); }
        document.getElementById('fileUpload').value = '';
    };
    reader.readAsArrayBuffer(file);
}

window.submitLoanAdd = function() {
    let name = document.getElementById('loanName').value;
    let rate = Number(document.getElementById('loanRate').value);
    if(name && rate) {
        loans.push({ id: Date.now().toString(), name, rate, records: [] });
        localStorage.setItem('myLoans', JSON.stringify(loans));
        render();
        showToast('대출이 등록되었습니다.');
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
