// 초기 데이터 로드 (initial_data.js 연동)
let transactions = [];
if (typeof initialTransactions !== 'undefined') {
  transactions = initialTransactions;
}

// 대출 설정 (마이너스 통장 연이율)
let loanSettings = {
    rate: 5.5, 
};

// UI 상태 관리 변수들
let modal = null;
let selectedStock = null; 
let searchText = '';
let sortBy = 'invested_desc'; // 'invested_desc', 'value_desc', 'name_asc'
let viewMode = 'list'; // 'list' 또는 'chart'
let chartInstance = null; // Chart.js 인스턴스

function won(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
function usd(n) { return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }

// 과거 환율 불러오기 API
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

// Chart.js 텍스트 색상 (다크모드)
if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#8f95b2';
}

function render() {
    // 검색창 포커스 유지를 위한 변수
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
    
    // 거래 내역 집계
    transactions.forEach(tx => {
        let isOverseas = tx.type === '주식' || tx.type.includes('해외') || tx.exchangeRate > 100 || tx.name.includes('달러');
        let amountKRW = isOverseas ? (tx.quantity * tx.price * tx.exchangeRate) : (tx.quantity * tx.price);
        
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
                currentValueKRW: 0, 
                isOverseas: isOverseas
            };
        }
        
        portfolio[tx.name].quantity += tx.quantity;
        portfolio[tx.name].totalAmountOriginal += (tx.quantity * tx.price);
        portfolio[tx.name].totalAmountKRW += amountKRW;
        
        // 현재 평가금액 (API 연동 전 임시 매수금액 매핑)
        portfolio[tx.name].currentValueKRW += amountKRW; 

        totalInvested += amountKRW;
        totalCurrentValue += amountKRW; 
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
                    <span class="summary-label">총 평가 금액</span>
                    <span class="summary-value">${won(totalCurrentValue)}</span>
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
            <div class="section-title">보유 종목 현황 (${activeStocks.length}종목)</div>
            
            <div class="portfolio-tools">
                <div class="view-toggles">
                    <button class="${viewMode === 'list' ? 'active' : ''}" onclick="window.setViewMode('list')">리스트로 보기</button>
                    <button class="${viewMode === 'chart' ? 'active' : ''}" onclick="window.setViewMode('chart')">파이 차트로 보기</button>
                </div>
                <div class="filter-sort-row">
                    <input type="text" id="searchInput" placeholder="종목명 검색..." value="${searchText}" oninput="window.setSearchText(this.value)">
                    <select id="sortSelect" onchange="window.setSortBy(this.value)">
                        <option value="invested_desc" ${sortBy === 'invested_desc' ? 'selected' : ''}>구매금액순</option>
                        <option value="value_desc" ${sortBy === 'value_desc' ? 'selected' : ''}>평가금액순</option>
                        <option value="name_asc" ${sortBy === 'name_asc' ? 'selected' : ''}>종목명순</option>
                    </select>
                </div>
            </div>
    `;

    if (viewMode === 'list') {
        activeStocks.forEach(name => {
            let p = portfolio[name];
            let avgPriceOriginal = p.totalAmountOriginal / p.quantity;
            let displayPrice = p.isOverseas ? usd(avgPriceOriginal) : won(avgPriceOriginal);
            
            let stockProfitKRW = p.currentValueKRW - p.totalAmountKRW;
            let stockReturnRate = p.totalAmountKRW > 0 ? (stockProfitKRW / p.totalAmountKRW) * 100 : 0;
            
            html += `
                <div class="card" onclick="openStockDetail('${name}')">
                    <div class="card-top">
                        <div class="card-name"><span class="tag-type">${p.type || '주식'}</span> ${name}</div>
                        <div class="card-arrow">›</div>
                    </div>
                    <div class="tx-row"><span>구매단가 (평균)</span> <span class="val">${displayPrice}</span></div>
                    <div class="tx-row"><span>보유 수량</span> <span class="val">${p.quantity.toLocaleString('en-US', {maximumFractionDigits:4})}주</span></div>
                    
                    <div class="tx-row" style="border-top: 1px dashed var(--line); padding-top: 8px; margin-top: 8px;">
                        <span>총 구매금액${p.isOverseas ? '(환율 적용)' : ''}</span> 
                        <span class="val" style="color:var(--text);">${won(p.totalAmountKRW)}</span>
                    </div>
                    <div class="tx-row">
                        <span>현재 평가금액</span> 
                        <span class="val">${won(p.currentValueKRW)}</span>
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
        
        if(activeStocks.length === 0) {
            html += `<div style="text-align:center; padding: 40px 0; color: var(--text-soft); font-size:14px;">조건에 맞는 종목이 없습니다.</div>`;
        }
    } else if (viewMode === 'chart') {
        html += `
            <div class="chart-container">
                ${activeStocks.length > 0 ? '<canvas id="portfolioChart"></canvas>' : '<div style="color:var(--text-soft); font-size:14px;">표시할 데이터가 없습니다.</div>'}
            </div>
        `;
    }

    html += `</div>`;
    html += `<button class="fab" id="fabAdd">+</button>`;

    // 4. 모달창 렌더링
    if(modal === 'add') {
        html += `
            <div class="overlay" id="ovAdd">
                <div class="sheet">
                    <div class="sheet-title">새로운 종목 추가<button class="close" onclick="closeModal()">✕</button></div>
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

                    <button class="primary-btn" onclick="submitAdd()">새 종목 기록하기</button>
                </div>
            </div>
        `;
    } else if (modal === 'detail' && selectedStock) {
        let pInfo = portfolio[selectedStock] || { isOverseas: false };
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

        // 종목 클릭 시 바로 추가할 수 있도록 상단에 폼 내장
        html += `
            <div class="overlay" id="ovDetail">
                <div class="sheet">
                    <div class="sheet-title">${selectedStock}<button class="close" onclick="closeModal()">✕</button></div>
                    
                    <div style="background: var(--surface-sub); padding: 16px; border-radius: 16px; margin-bottom: 24px; border: 1px solid var(--primary);">
                        <div style="font-size: 14px; font-weight: 800; margin-bottom: 12px; color: var(--primary);">+ 신규 매수/매도 추가</div>
                        <div class="field"><label>날짜</label><input type="date" id="detailAddDate" value="${new Date().toISOString().split('T')[0]}"></div>
                        <div class="field"><label>수량 (매도 시 -음수 입력)</label><input type="number" step="0.0001" id="detailAddQty" placeholder="예: 10 또는 -5"></div>
                        <div class="field"><label>단가</label><input type="number" step="0.01" id="detailAddPrice" placeholder="0"></div>
                        
                        ${pInfo.isOverseas ? `
                        <div class="field" id="detailRateFieldWrap">
                            <label>환율 (선택 날짜 자동 조회)</label>
                            <input type="number" step="0.1" id="detailAddRate" value="1300.0">
                            <div style="font-size:11px; color:var(--text-soft); margin-top:4px;" id="detailRateMsg">환율 확인 중...</div>
                        </div>` : `<input type="hidden" id="detailAddRate" value="1.0">`}
                        
                        <button class="primary-btn" onclick="submitDetailAdd()" style="margin-top: 4px;">기록 추가하기</button>
                    </div>

                    <div style="font-size: 14px; font-weight: 800; margin-bottom: 8px;">최근 매매 기록</div>
                    <div class="detail-tx-list">
                        ${listHtml}
                    </div>
                </div>
            </div>
        `;
    }

    app.innerHTML = html;

    // 포커스 복원 (검색창 텍스트 입력 끊김 방지)
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

    // 하단 FAB 버튼: 완전 새로운 종목 등록 시 사용
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

// 상세 모달 열기 및 환율 이벤트 바인딩
window.openStockDetail = function(name) {
    selectedStock = name;
    modal = 'detail';
    render();
    setTimeout(bindDetailRateEvent, 50); // 모달 열린 직후 환율 체크
}

// 상세 모달 내 신규 기록 폼 등록 기능
window.submitDetailAdd = function() {
    let date = document.getElementById('detailAddDate').value;
    let qty = Number(document.getElementById('detailAddQty').value);
    let price = Number(document.getElementById('detailAddPrice').value);
    let rate = Number(document.getElementById('detailAddRate').value) || 1.0;
    
    if(!qty || !price) {
        showToast('수량과 단가를 입력해주세요');
        return;
    }
    
    // 기존 종목의 타입을 그대로 복사
    let pObj = transactions.find(t => t.name === selectedStock);
    let type = pObj ? pObj.type : '국내주식';

    transactions.unshift({
        portfolio: "수동입력",
        date: date,
        type: type,
        name: selectedStock,
        code: '',
        quantity: qty,
        price: price,
        exchangeRate: type.includes('해외') || type === '주식' ? rate : 1.0
    });

    render(); // 창을 닫지 않고 다시 그려서 즉시 반영된 것을 보여줌
    showToast('매매 기록이 추가되었습니다.');
    setTimeout(bindDetailRateEvent, 50);
}

// 상세 모달 안의 환율 자동 조회
function bindDetailRateEvent() {
    const dateInput = document.getElementById('detailAddDate');
    const rateInput = document.getElementById('detailAddRate');
    const rateMsg = document.getElementById('detailRateMsg');
    
    if(!rateInput || rateInput.type === 'hidden') return;

    async function checkRate() {
        rateMsg.textContent = '선택한 날짜의 환율 조회 중...';
        rateMsg.style.color = 'var(--text-soft)';
        const rate = await fetchHistoricalRate(dateInput.value);
        if(rate) {
            rateInput.value = rate;
            rateMsg.textContent = `${dateInput.value} 기준 환율(${rate}원) 적용 완료.`;
            rateMsg.style.color = 'var(--ok)';
        } else {
            rateMsg.textContent = '환율 조회 실패. 수동으로 입력해주세요.';
            rateMsg.style.color = 'var(--danger)';
        }
    }
    dateInput.addEventListener('change', checkRate);
    checkRate(); 
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
    showToast('새로운 종목이 기록되었습니다.');
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
