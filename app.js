
// Firebase 없이 일단 로컬 메모리 기반으로 동작하게 구성 (1단계 테스트용)
let transactions = [];
if (typeof initialTransactions !== 'undefined') {
  transactions = initialTransactions;
}

// 대출 설정 (돈의심리학 기준)
let loanSettings = {
    amount: 1515456, // 초기 대출 설정 테스트 값. 필요시 앱 내 설정 추가.
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

function render() {
    const app = document.getElementById('app');
    
    // 합계 계산
    let totalInvested = 0;
    
    // 종목별 수량 및 평균 단가 계산용 맵
    let portfolio = {};
    
    transactions.forEach(tx => {
        let amountKRW = tx.quantity * tx.price * (tx.exchangeRate || 1);
        totalInvested += amountKRW;
        
        if(!portfolio[tx.name]) {
            portfolio[tx.name] = { type: tx.type, code: tx.code, quantity: 0, totalAmount: 0 };
        }
        portfolio[tx.name].quantity += tx.quantity;
        portfolio[tx.name].totalAmount += amountKRW;
    });

    let accruedInterest = calculateAccruedInterest();

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
                    <span class="summary-label">투자 원금 대비 이자율</span>
                    <span class="summary-value danger">${((accruedInterest / totalInvested) * 100).toFixed(2)}%</span>
                </div>
            </div>
        </div>
        
        <div class="page">
            <div class="section-title">보유 종목 현황 (총 ${Object.keys(portfolio).length}종목)</div>
    `;

    // 보유 종목 렌더링
    Object.keys(portfolio).forEach(name => {
        let p = portfolio[name];
        let avgPrice = p.totalAmount / p.quantity;
        
        html += `
            <div class="card">
                <div class="card-top">
                    <div class="card-name"><span class="tag-type">${p.type}</span> ${name}</div>
                </div>
                <div class="tx-row"><span>보유 수량</span> <span class="val">${p.quantity}주</span></div>
                <div class="tx-row"><span>매수 원금 (원화)</span> <span class="val">${won(p.totalAmount)}</span></div>
                <div class="tx-row"><span>평균 매수 단가</span> <span class="val">${won(avgPrice)}</span></div>
            </div>
        `;
    });

    html += `</div>`;
    html += `<button class="fab" id="fabAdd">+</button>`;

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
                    <div class="field"><label>종목명</label><input type="text" id="addName" placeholder="예: TIGER 미국S&P500"></div>
                    <div class="field"><label>구매 수량</label><input type="number" id="addQty" placeholder="0"></div>
                    <div class="field"><label>구매 단가</label><input type="number" id="addPrice" placeholder="0"></div>
                    <div class="field"><label>환율 (해외 주식인 경우)</label><input type="number" id="addRate" value="1.0"></div>
                    <button class="primary-btn" onclick="submitAdd()">기록하기</button>
                </div>
            </div>
        `;
    }

    app.innerHTML = html;

    // Event listeners
    let fab = document.getElementById('fabAdd');
    if(fab) fab.onclick = () => { modal = 'add'; render(); };
    
    let ovAdd = document.getElementById('ovAdd');
    if(ovAdd) ovAdd.onclick = (e) => { if(e.target === ovAdd) closeModal(); };
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
    let rate = Number(document.getElementById('addRate').value);

    if(!name || !qty || !price) {
        showToast('필수 정보를 입력해주세요');
        return;
    }

    transactions.unshift({
        date: date,
        type: type,
        name: name,
        code: '', // 수동 입력시 코드 생략
        quantity: qty,
        price: price,
        exchangeRate: rate
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
