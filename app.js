// Firebase 없이 일단 로컬 메모리 기반으로 동작하게 구성 (1단계 테스트용)
let transactions = [];
if (typeof initialTransactions !== 'undefined') {
  transactions = initialTransactions;
}

// 대출 설정 (돈의심리학 기준)
let loanSettings = {
    amount: 1515456, // 초기 대출 설정 테스트 값
    rate: 5.5,
    startDate: '2026-04-27'
};

let modal = null;

function won(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
function usd(n) { return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }

function calculateAccruedInterest() {
    const start = new Date(loanSettings.startDate);
    const today = new Date();
    const diffTime = Math.abs(today - start);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    // (원금 * 연이율) / 365 * 일수
    return (loanSettings.amount * (loanSettings.rate / 100)) / 365 * diffDays;
}

// 과거 환율 불러오기 API (Frankfurter 무료 API 활용)
async function fetchHistoricalRate(dateStr) {
    try {
        const res = await fetch(`https://api.frankfurter.app/${dateStr}?from=USD&to=KRW`);
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        return data.rates.KRW;
    } catch (e) {
        console.error('환율 데이터를 불러오는 데 실패했습니다.', e);
        return null;
    }
}

function render() {
    const app = document.getElementById('app');
    
    let totalInvested = 0;
    let totalCurrentValue = 0; // 임시로 원금과 동일 (추후 현재가 연동)
    let portfolio = {};
    
    // 1. 거래 내역 집계 (보유 수량 및 총 금액 계산)
    transactions.forEach(tx => {
        let isOverseas = tx.type === '주식' || tx.type.includes('해외') || tx.exchangeRate > 100;
        let amountKRW = tx.quantity * tx.price * (tx.exchangeRate || 1);
        
        if(!portfolio[tx.name]) {
            portfolio[tx.name] = { 
                type: tx.type, 
                code: tx.code, 
                quantity: 0, 
                totalAmountKRW: 0, 
                totalAmountUSD: 0,
                isOverseas: isOverseas
            };
        }
        
        portfolio[tx.name].quantity += tx.quantity;
        
        // 매수/매도 누적 처리
        if (isOverseas) {
            portfolio[tx.name].totalAmountUSD += (tx.quantity * tx.price);
        }
        portfolio[tx.name].totalAmountKRW += amountKRW;
        
        totalInvested += amountKRW;
        totalCurrentValue += amountKRW;
    });

    let accruedInterest = calculateAccruedInterest();
    let marketProfit = totalCurrentValue - totalInvested;
    let netProfit = marketProfit - accruedInterest;
    let realReturnRate = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;

    // 2. 화면 상단 렌더링
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
            <div class="section-title">보유 종목 현황</div>
    `;

    // 3. 보유 수량이 0 초과인 종목만 필터링하여 렌더링
    let activeStockCount = 0;
    
    Object.keys(portfolio).forEach(name => {
        let p = portfolio[name];
        
        // ** 핵심: 보유 수량이 0 이하면 화면에 표시하지 않음 **
        if (p.quantity <= 0) return;
        
        activeStockCount++;
        
        // 평균 구매 단가 계산
        let avgPriceKRW = p.totalAmountKRW / p.quantity;
        let avgPriceUSD = p.isOverseas ? (p.totalAmountUSD / p.quantity) : 0;
        let displayPrice = p.isOverseas ? usd(avgPriceUSD) : won(avgPriceKRW);
        
        html += `
            <div class="card">
                <div class="card-top">
                    <div class="card-name"><span class="tag-type">${p.type}</span> ${name}</div>
                </div>
                <div class="tx-row"><span>평균 구매단가</span> <span class="val">${displayPrice}</span></div>
                <div class="tx-row"><span>보유 수량</span> <span class="val">${p.quantity.toLocaleString('ko-KR')}주</span></div>
                <div class="tx-row"><span>총 구매금액</span> <span class="val">${won(p.totalAmountKRW)}</span></div>
            </div>
        `;
    });
    
    // 만약 보유 종목이 없다면 메시지 표시
    if(activeStockCount === 0) {
        html += `<div style="text-align:center; padding: 40px 0; color: var(--text-soft); font-size:14px;">현재 보유 중인 종목이 없습니다.</div>`;
    }

    html += `</div>`;
    html += `<button class="fab" id="fabAdd">+</button>`;

    // 4. 모달창 렌더링
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
                        <label>환율 (선택한 날짜 기준)</label>
                        <input type="number" step="0.1" id="addRate" value="1300.0">
                        <div style="font-size:11px; color:var(--text-soft); margin-top:4px;" id="rateMsg">환율 정보를 불러오는 중...</div>
                    </div>

                    <button class="primary-btn" onclick="submitAdd()">기록하기</button>
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
}

// 환율 자동 조회 이벤트 
function bindModalEvents() {
    const addType = document.getElementById('addType');
    const addDate = document.getElementById('addDate');
    const rateFieldWrap = document.getElementById('rateFieldWrap');
    const addRate = document.getElementById('addRate');
    const rateMsg = document.getElementById('rateMsg');

    async function checkRate() {
        if (addType.value.includes('해외')) {
            rateFieldWrap.style.display = 'block';
            rateMsg.textContent = '환율 정보를 불러오는 중...';
            rateMsg.style.color = 'var(--text-soft)';
            
            const rate = await fetchHistoricalRate(addDate.value);
            if (rate) {
                addRate.value = rate;
                rateMsg.textContent = `${addDate.value} 기준 환율이 적용되었습니다.`;
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

// Initial render
document.addEventListener('DOMContentLoaded', () => {
    render();
});
