// 초기 데이터 로드 (initial_data.js 연동)
let transactions = [];
if (typeof initialTransactions !== 'undefined') {
  transactions = initialTransactions;
}

// 대출 설정 (마이너스 통장 연이율)
let loanSettings = {
    rate: 5.5, // 연 5.5% 이자
};

let modal = null;
let selectedStock = null; // 상세 조회를 위한 선택 종목

function won(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
function usd(n) { return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }

// 과거 환율 불러오기 API (Frankfurter 무료 API 활용)
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

function render() {
    const app = document.getElementById('app');
    
    let totalInvested = 0;
    let accruedInterest = 0;
    let totalCurrentValue = 0; 
    let portfolio = {};
    const today = new Date();
    
    // 1. 거래 내역 집계 및 마이너스 통장 이자 정밀 계산
    transactions.forEach(tx => {
        let isOverseas = tx.type === '주식' || tx.type.includes('해외') || tx.exchangeRate > 100 || tx.name.includes('달러');
        
        let amountKRW = isOverseas ? (tx.quantity * tx.price * tx.exchangeRate) : (tx.quantity * tx.price);
        
        // 개별 매수일부터 오늘까지의 일별 이자 누적
        let txDate = new Date(tx.date);
        let diffTime = today.getTime() - txDate.getTime();
        let diffDays = diffTime > 0 ? Math.ceil(diffTime / (1000 * 60 * 60 * 24)) : 0;
        
        accruedInterest += amountKRW * (loanSettings.rate / 100) / 365 * diffDays;
        
        if(!portfolio[tx.name]) {
            portfolio[tx.name] = { 
                type: tx.type, 
                code: tx.code, 
                quantity: 0, 
                totalAmountKRW: 0, 
                totalAmountOriginal: 0, 
                isOverseas: isOverseas
            };
        }
        
        portfolio[tx.name].quantity += tx.quantity;
        portfolio[tx.name].totalAmountOriginal += (tx.quantity * tx.price);
        portfolio[tx.name].totalAmountKRW += amountKRW;
        
        totalInvested += amountKRW;
        totalCurrentValue += amountKRW; // API 연동 전이므로 평가금액 = 매수금액 임시 맵핑
    });

    let marketProfit = totalCurrentValue - totalInvested; 
    let netProfit = marketProfit - accruedInterest; 
    let realReturnRate = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;

    // 2. 화면 상단 요약 렌더링
    let html = `
        <div class="header-container">
            <div class="top-bar">
                <div class="app-title">주식 투자 수첩</div>
            </div>
            
            <div class="summary-card">
                <div class="summary-row">
                    <span class="summary-label">총 투자 원금</span>
                    <span class="summary-value">${won(totalInvested)}</span>
                </div>
                <div class="summary-row">
                    <span class="summary-label">누적 대출 이자 (추정)</span>
                    <span class="summary-value danger">-${won(accruedInterest)}</span>
                </div>
                <div class="summary-row" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--line);">
                    <span class="summary-label">실질 수익률 (수익금 - 이자)</span>
                    <span class="summary-value ${netProfit >= 0 ? 'ok' : 'danger'}">
                        ${netProfit > 0 ? '+' : ''}${won(netProfit)}
                        <span style="font-size:14px; font-weight:600; color:var(--text-soft);">(${realReturnRate > 0 ? '+' : ''}${realReturnRate.toFixed(2)}%)</span>
                    </span>
                </div>
            </div>
        </div>
        
        <div class="page">
            <div class="section-title">보유 종목 현황 (터치하여 상세 내역 조회)</div>
    `;

    // 3. 보유 수량이 0 초과인 종목만 필터링하여 카드 렌더링
    let activeStockCount = 0;
    
    Object.keys(portfolio).forEach(name => {
        let p = portfolio[name];
        
        if (p.quantity <= 0.0001) return; // 0 이하 숨김 처리
        activeStockCount++;
        
        let avgPriceOriginal = p.totalAmountOriginal / p.quantity;
        let displayPrice = p.isOverseas ? usd(avgPriceOriginal) : won(avgPriceOriginal);
        
        // 개별 종목 수익률 계산 (현재가 API 연동 전이므로 평단가를 현재가로 대입)
        let currentPriceOriginal = avgPriceOriginal; 
        let stockProfitKRW = (currentPriceOriginal - avgPriceOriginal) * p.quantity * (p.isOverseas ? (p.totalAmountKRW / p.totalAmountOriginal) : 1);
        let stockReturnRate = p.totalAmountKRW > 0 ? (stockProfitKRW / p.totalAmountKRW) * 100 : 0;
        
        html += `
            <div class="card" onclick="openStockDetail('${name}')">
                <div class="card-top">
                    <div class="card-name"><span class="tag-type">${p.type || '주식'}</span> ${name}</div>
                    <div class="card-arrow">›</div>
                </div>
                <div class="tx-row"><span>구매단가 (평균)</span> <span class="val">${displayPrice}</span></div>
                <div class="tx-row"><span>구매수량</span> <span class="val">${p.quantity.toLocaleString('en-US', {maximumFractionDigits:4})}주</span></div>
                
                <div class="tx-row" style="border-top: 1px dashed var(--line); padding-top: 8px; margin-top: 8px;">
                    <span>총 구매금액${p.isOverseas ? '(환율 적용)' : ''}</span> 
                    <span class="val" style="color:var(--text);">${won(p.totalAmountKRW)}</span>
                </div>
                <div class="tx-row">
                    <span>수익률 (평가)</span> 
                    <span class="val ${stockReturnRate > 0 ? 'ok' : (stockReturnRate < 0 ? 'danger' : '')}">
                        ${stockReturnRate > 0 ? '+' : ''}${stockReturnRate.toFixed(2)}%
                    </span>
                </div>
            </div>
        `;
    });
    
    if(activeStockCount === 0) {
        html += `<div style="text-align:center; padding: 40px 0; color: var(--text-soft); font-size:14px;">현재 보유 중인 종목이 없습니다.</div>`;
    }

    html += `</div>`;
    html += `<button class="fab" id="fabAdd">+</button>`;

    // 4. 모달창 렌더링 (매수 추가 & 상세 내역 조회)
    if(modal === 'add') {
        html += `
            <div class="overlay" id="ovAdd">
                <div class="sheet">
                    <div class="sheet-title">매수 내역 추가<button class="close" onclick="closeModal()">✕</button></div>
                    <div class="field"><label>날짜</label><input type="date" id="addDate" value="${new Date().toISOString().split('T')[0]}"></div>
                    <div class="field"><label>구분</label>
                        <select id="addType">
                            <option value="국내주식">국내주식</option>
                            <option value="주식(해외)">주식(해외)</option>
                        </select>
                    </div>
                    <div class="field"><label>종목명</label><input type="text" id="addName" placeholder="예: AAPL"></div>
                    <div class="field"><label>구매 수량</label><input type="number" step="0.0001" id="addQty" placeholder="0"></div>
                    <div class="field"><label>구매 단가</label><input type="number" step="0.01" id="addPrice" placeholder="0"></div>
                    
                    <div class="field" id="rateFieldWrap" style="display:none;">
                        <label>환율 (선택한 날짜 기준 자동 불러오기)</label>
                        <input type="number" step="0.1" id="addRate" value="1300.0">
                        <div style="font-size:11px; color:var(--text-soft); margin-top:4px;" id="rateMsg">환율 정보를 불러오는 중...</div>
                    </div>

                    <button class="primary-btn" onclick="submitAdd()">기록하기</button>
                </div>
            </div>
        `;
    } else if (modal === 'detail' && selectedStock) {
        // 선택한 주식의 매매 기록 필터링 및 최신순 정렬
        let stockTxs = transactions.filter(tx => tx.name === selectedStock).sort((a,b) => new Date(b.date) - new Date(a.date));
        
        let listHtml = stockTxs.map(tx => {
            let isOvs = tx.type === '주식' || tx.type.includes('해외') || tx.exchangeRate > 100 || tx.name.includes('달러');
            let pStr = isOvs ? usd(tx.price) : won(tx.price);
            let actionType = tx.quantity > 0 ? '<span style="color:var(--danger)">매수</span>' : '<span style="color:var(--primary)">매도</span>';
            
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
                    <div class="sheet-title">${selectedStock} 매매 기록<button class="close" onclick="closeModal()">✕</button></div>
                    <div class="detail-tx-list">
                        ${listHtml}
                    </div>
                </div>
            </div>
        `;
    }

    app.innerHTML = html;

    // 이벤트 리스너 바인딩
    let fab = document.getElementById('fabAdd');
    if(fab) fab.onclick = () => { modal = 'add'; render(); setTimeout(bindModalEvents, 50); };
    
    let ovAdd = document.getElementById('ovAdd');
    if(ovAdd) ovAdd.onclick = (e) => { if(e.target === ovAdd) closeModal(); };
    
    let ovDetail = document.getElementById('ovDetail');
    if(ovDetail) ovDetail.onclick = (e) => { if(e.target === ovDetail) closeModal(); };
}

// 개별 주식 상세 기록 모달 열기
window.openStockDetail = function(name) {
    selectedStock = name;
    modal = 'detail';
    render();
}

function bindModalEvents() {
    const addType = document.getElementById('addType');
    const addDate = document.getElementById('addDate');
    const rateFieldWrap = document.getElementById('rateFieldWrap');
    const addRate = document.getElementById('addRate');
    const rateMsg = document.getElementById('rateMsg');

    async function checkRate() {
        if (addType.value.includes('해외')) {
            rateFieldWrap.style.display = 'block';
            rateMsg.textContent = '선택한 날짜의 환율 정보를 불러오는 중...';
            rateMsg.style.color = 'var(--text-soft)';
            
            const rate = await fetchHistoricalRate(addDate.value);
            if (rate) {
                addRate.value = rate;
                rateMsg.textContent = `${addDate.value} 기준 실제 환율(${rate}원)이 적용되었습니다.`;
                rateMsg.style.color = 'var(--ok)';
            } else {
                rateMsg.textContent = '환율을 불러오지 못했습니다. 수동으로 입력해주세요.';
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
    let qty = Number(document.getElementById('addQty').value);
    let price = Number(document.getElementById('addPrice').value);
    let rate = Number(document.getElementById('addRate').value) || 1.0;

    if(!name || !qty || !price) {
        showToast('필수 정보를 입력해주세요');
        return;
    }

    transactions.unshift({
        portfolio: "수동입력",
        date: date,
        type: type,
        name: name,
        code: '',
        quantity: qty,
        price: price,
        exchangeRate: type.includes('해외') ? rate : 1.0
    });

    closeModal();
    showToast('매수 내역이 기록되었습니다.');
}

function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2200);
}

document.addEventListener('DOMContentLoaded', () => {
    render();
});
