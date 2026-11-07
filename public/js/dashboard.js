/**
 * Dashboard Module - Home page with real-time updates & currency conversion
 * Fixed: Uses available_balance for wallet display, proper INR conversion
 */
const Dashboard = {
    logs: [],
    strategies: [],
    refreshTimer: null,
    exchangeRate: 94, // USD to INR (updated from API)

    async init() {
        this.setupWebSocket();
        this.fetchExchangeRate();
        this.loadDashboard();
        this.loadStrategies();
        // Auto-refresh every 30 seconds
        this.refreshTimer = setInterval(() => this.loadDashboard(), 30000);
    },

    async fetchExchangeRate() {
        try {
            const res = await fetch('/api/exchange-rate');
            const data = await res.json();
            if (data.USD_INR) this.exchangeRate = data.USD_INR;
        } catch (e) { /* use default */ }
    },

    convertToDisplay(amount, fromAsset, displayCurrency) {
        if (!amount || isNaN(amount)) return 0;
        const from = (fromAsset || '').toUpperCase();
        const to = (displayCurrency || 'USD').toUpperCase();
        if (from === to) return amount;
        // USD/USDT -> INR
        if ((from === 'USD' || from === 'USDT' || from === 'USDC') && to === 'INR') return amount * this.exchangeRate;
        // INR -> USD/USDT
        if (from === 'INR' && (to === 'USD' || to === 'USDT')) return amount / this.exchangeRate;
        // USD <-> USDT (1:1)
        if ((from === 'USD' || from === 'USDT') && (to === 'USD' || to === 'USDT')) return amount;
        return amount;
    },

    async loadDashboard() {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();

            const displayCurrency = data.settings?.currency || 'USD';
            const sym = displayCurrency === 'INR' ? '₹' : (displayCurrency === 'BTC' ? '₿' : '$');
            const assetFrom = data.balance.assetSymbol || 'USD';

            // Update exchange rate from API response
            if (data.exchangeRates?.USD_INR) {
                this.exchangeRate = data.exchangeRates.USD_INR;
            }

            // === BALANCE: Use walletBalance (available_balance from Delta API) ===
            // This is the actual free cash shown in Delta app
            const walletBal = data.balance.walletBalance || data.balance.available || 0;
            const equity = data.balance.equity || walletBal;
            const displayBalance = this.convertToDisplay(walletBal, assetFrom, displayCurrency);

            const balEl = document.getElementById('statBalance');
            balEl.textContent = data.balanceAvailable === false ? '—' : `${sym}${this.formatNumber(displayBalance)}`;

            // Show asset info in sub-label
            const curEl = document.getElementById('statCurrency');
            if (data.balanceAvailable === false) {
                curEl.textContent = 'Balance unavailable';
            } else if (equity !== walletBal && equity > 0) {
                curEl.textContent = `${displayCurrency} (Equity: ${sym}${this.formatNumber(this.convertToDisplay(equity, assetFrom, displayCurrency))})`;
            } else {
                curEl.textContent = displayCurrency;
            }

            // P&L
            const pnl = data.stats.totalPnl || 0;
            const pnlEl = document.getElementById('statPnl');
            pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${sym}${this.formatNumber(Math.abs(pnl))}`;
            pnlEl.className = `stat-value ${pnl >= 0 ? 'positive' : 'negative'}`;

            // Win Rate & trade count
            document.getElementById('statWinRate').textContent = `${data.stats.winRate}%`;
            document.getElementById('statTradeCount').textContent = `${data.stats.totalTrades || 0} trades`;

            // Additional stats
            document.getElementById('statTotalTrades').textContent = data.stats.totalTrades || 0;

            // === MIN BALANCE: Convert from USD to display currency with INR equivalent ===
            const minBal = parseFloat(data.settings.minBalance || 0);
            // minBalance is stored in the asset's native currency (USD for USDT wallets)
            const minBalDisplay = this.convertToDisplay(minBal, assetFrom, displayCurrency);
            const minBalEl = document.getElementById('statMinBalance');
            if (displayCurrency === 'INR' && (assetFrom === 'USD' || assetFrom === 'USDT' || assetFrom === 'USDC')) {
                // Show INR conversion with USD original
                minBalEl.textContent = `₹${this.formatNumber(minBal * this.exchangeRate)}`;
                minBalEl.title = `$${minBal} × ₹${this.exchangeRate} = ₹${(minBal * this.exchangeRate).toFixed(2)}`;
            } else {
                minBalEl.textContent = `${sym}${this.formatNumber(minBalDisplay)}`;
            }

            // === PRICE RANGE: Convert from USD to display currency with INR equivalent ===
            const minP = parseFloat(data.settings.minPrice || 0);
            const maxP = parseFloat(data.settings.maxPrice || 0);
            const priceRangeEl = document.getElementById('statPriceRange');

            if (displayCurrency === 'INR') {
                // Convert USD prices to INR for display
                const minPInr = minP * this.exchangeRate;
                const maxPInr = maxP * this.exchangeRate;
                // If max price is very large (default), show as "No limit"
                if (maxP >= 9999999) {
                    priceRangeEl.textContent = `₹${this.formatNumber(minPInr)} - No limit`;
                } else {
                    priceRangeEl.textContent = `₹${this.formatNumber(minPInr)} - ₹${this.formatNumber(maxPInr)}`;
                }
                priceRangeEl.title = `$${minP} - $${maxP} (×₹${this.exchangeRate})`;
            } else {
                if (maxP >= 9999999) {
                    priceRangeEl.textContent = `${sym}${this.formatNumber(minP)} - No limit`;
                } else {
                    priceRangeEl.textContent = `${sym}${this.formatNumber(minP)} - ${sym}${this.formatNumber(maxP)}`;
                }
            }

            this.updateBotStatus(data.botStatus);
        } catch (error) {
            console.error('Failed to load dashboard:', error);
        }
    },

    async loadStrategies() {
        try {
            const res = await fetch('/api/strategies');
            this.strategies = await res.json();
            this.renderStrategies();
        } catch (error) {
            console.error('Failed to load strategies:', error);
        }
    },

    renderStrategies() {
        const container = document.getElementById('strategyList');
        container.innerHTML = this.strategies.map(s => {
            const isActive = s.active;
            if (isActive) {
                document.getElementById('activeStrategyBadge').textContent = s.winRate === 'N/A' ? 'Win rate: unknown' : `Win: ${s.winRate}%`;
            }
            const riskClass = s.riskLevel.toLowerCase();
            return `
                <button type="button" class="strategy-card ${isActive ? 'active' : ''}" onclick="Dashboard.selectStrategy('${s.id}')" id="strategy-${s.id}" aria-pressed="${isActive}">
                    <div class="strategy-radio"></div>
                    <div class="strategy-info">
                        <div class="strategy-name">${s.name}</div>
                        <div class="strategy-desc">${s.description}</div>
                        <div class="strategy-meta">
                            <span class="strategy-badge badge-winrate">${s.winRate === 'N/A' ? 'Win rate unknown' : s.winRate + '% Win'}</span>
                            <span class="strategy-badge badge-timeframe">${s.timeframe}</span>
                            <span class="strategy-badge badge-${riskClass}">${s.riskLevel}</span>
                        </div>
                    </div>
                </button>`;
        }).join('');
    },

    getRiskIcon(level) {
        switch ((level || '').toLowerCase()) {
            case 'conservative': return '🟢';
            case 'moderate': return '🟡';
            case 'aggressive': return '🔴';
            default: return '⚪';
        }
    },

    async selectStrategy(id) {
        try {
            const res = await fetch('/api/strategies/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ strategyId: id })
            });
            const data = await res.json();
            if (data.success) {
                App.showToast(`Strategy: ${data.strategy.name}`, 'success');
                await this.loadStrategies();
            }
        } catch (error) {
            App.showToast('Failed to change strategy', 'error');
        }
    },

    updateBotStatus(status) {
        const btn = document.getElementById('btnBotToggle');
        const btnText = document.getElementById('btnBotText');
        const indicator = document.getElementById('apiStatus');
        const statusText = document.getElementById('apiStatusText');
        if (status.running) {
            btn.className = 'btn-bot-toggle stop';
            btnText.textContent = 'Stop bot';
            indicator.className = 'status-indicator online';
            statusText.textContent = 'Running';
        } else {
            btn.className = 'btn-bot-toggle start';
            btnText.textContent = 'Start bot';
            indicator.className = 'status-indicator offline';
            statusText.textContent = 'Stopped';
        }
    },

    addLog(entry) {
        this.logs.unshift(entry);
        if (this.logs.length > 100) this.logs.pop();
        this.renderLogs();
    },

    renderLogs() {
        const container = document.getElementById('logContainer');
        if (this.logs.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-symbol">⌁</div><div class="title">No activity yet</div><div class="desc">Start the bot to see live activity</div></div>`;
            return;
        }
        const icons = { info: 'i', success: '✓', warning: '!', error: '×', trade: '↗', signal: '⌁' };
        container.innerHTML = this.logs.map(log => {
            const time = new Date(log.timestamp || log.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            return `<div class="log-entry ${log.level}"><span class="log-time">${time}</span><span class="log-icon">${icons[log.level] || '·'}</span><span class="log-message">${log.message}</span></div>`;
        }).join('');
    },

    async clearLogs() {
        try {
            await fetch('/api/logs', { method: 'DELETE' });
            this.logs = [];
            this.renderLogs();
            App.showToast('Logs cleared', 'info');
        } catch (error) {
            App.showToast('Failed to clear logs', 'error');
        }
    },

    setupWebSocket() {
        WS.on('botStatus', (data) => this.updateBotStatus(data));
        WS.on('botLog', (data) => this.addLog(data));
        WS.on('botLogs', (data) => { this.logs = Array.isArray(data) ? [...data].reverse() : []; this.renderLogs(); });
        WS.on('botBalance', (data) => {
            const cur = document.getElementById('statCurrency')?.textContent?.split(' ')[0] || 'USD';
            const sym = cur === 'INR' ? '₹' : (cur === 'BTC' ? '₿' : '$');
            const bal = data.walletBalance || data.available || 0;
            const display = this.convertToDisplay(bal, data.assetSymbol || 'USD', cur);
            document.getElementById('statBalance').textContent = `${sym}${this.formatNumber(display)}`;
        });
        WS.on('botTrade', () => setTimeout(() => this.loadDashboard(), 1000));
        WS.on('botRefresh', () => this.loadDashboard());
    },

    formatNumber(num) {
        if (num === null || num === undefined) return '0';
        num = parseFloat(num);
        if (isNaN(num)) return '0';
        if (Math.abs(num) >= 10000000) return (num / 10000000).toFixed(2) + 'Cr';
        if (Math.abs(num) >= 100000) return (num / 100000).toFixed(2) + 'L';
        if (Math.abs(num) >= 1000) return num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
        return num.toFixed(2);
    }
};
