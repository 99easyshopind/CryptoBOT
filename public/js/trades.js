/**
 * Trades Module - Enhanced transaction log with detailed reasoning and summary
 * v2.1: Expandable trade details, trade reasoning, filters, export, INR support
 */
const Trades = {
    trades: [],
    filter: 'all',
    exchangeRate: 94,
    displayCurrency: 'INR',

    async init() {
        await this.loadTrades();
        this.setupRealTimeUpdates();
    },

    async loadTrades() {
        try {
            const res = await fetch('/api/trades');
            const data = await res.json();
            this.trades = Array.isArray(data) ? data : (Array.isArray(data.trades) ? data.trades : []);

            // Try to get exchange rate and currency
            try {
                const rateRes = await fetch('/api/exchange-rate');
                const rateData = await rateRes.json();
                if (rateData.USD_INR) this.exchangeRate = rateData.USD_INR;
            } catch (e) { /* use default */ }

            // Get display currency from settings
            try {
                const settingsRes = await fetch('/api/settings');
                const settingsData = await settingsRes.json();
                if (settingsData.currency) this.displayCurrency = settingsData.currency;
            } catch (e) { /* use default */ }

            this.render();
        } catch (error) {
            console.error('Failed to load trades:', error);
        }
    },

    setupRealTimeUpdates() {
        if (typeof WS !== 'undefined') {
            WS.on('botTrade', () => setTimeout(() => this.loadTrades(), 1500));
            WS.on('botRefresh', () => this.loadTrades());
        }
    },

    setFilter(filter, btn) {
        this.filter = filter;
        document.querySelectorAll('.trade-filter-tab').forEach(t => t.classList.remove('active'));
        if (btn) btn.classList.add('active');
        this.render();
    },

    getFilteredTrades() {
        let trades = [...this.trades];
        switch (this.filter) {
            case 'open': return trades.filter(t => t.status === 'open');
            case 'closed': return trades.filter(t => t.status === 'closed');
            case 'wins': return trades.filter(t => t.status === 'closed' && t.pnl > 0);
            case 'losses': return trades.filter(t => t.status === 'closed' && t.pnl < 0);
            default: return trades;
        }
    },

    render() {
        this.updateSummary();
        this.renderTradeList();
    },

    getCurrencySymbol() {
        const c = (this.displayCurrency || 'USD').toUpperCase();
        if (c === 'INR') return '₹';
        if (c === 'BTC') return '₿';
        return '$';
    },

    updateSummary() {
        const closed = this.trades.filter(t => t.status === 'closed');
        const wins = closed.filter(t => t.pnl > 0);
        const losses = closed.filter(t => t.pnl <= 0);
        const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const openCount = this.trades.filter(t => t.status === 'open').length;

        document.getElementById('tradeTotal').textContent = this.trades.length;
        document.getElementById('tradeWins').textContent = wins.length;
        document.getElementById('tradeLosses').textContent = losses.length;

        const pnlEl = document.getElementById('tradePnl');
        const sym = this.getCurrencySymbol();
        pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}${sym}${Math.abs(totalPnl).toFixed(2)}`;
        pnlEl.className = `value ${totalPnl >= 0 ? 'text-green' : 'text-red'}`;

        // Update open count if element exists
        const openEl = document.getElementById('tradeOpen');
        if (openEl) openEl.textContent = openCount;

        // Win rate
        const winRateEl = document.getElementById('tradeWinRate');
        if (winRateEl) {
            const winRate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : '0.0';
            winRateEl.textContent = `${winRate}%`;
        }
    },

    renderTradeList() {
        const container = document.getElementById('tradeList');
        const trades = this.getFilteredTrades();

        if (trades.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-symbol">⇄</div><div class="title">No Trades</div><div class="desc">${this.filter === 'all' ? 'Bot will record all trades here' : `No ${this.filter} trades found`}</div></div>`;
            return;
        }

        // Group by date
        const grouped = {};
        trades.forEach(t => {
            const ts = t.entry_time || t.created_at || t.timestamp;
            const d = ts ? new Date(ts.includes('T') || ts.includes('-') ? ts : parseInt(ts)) : new Date();
            const date = isNaN(d.getTime()) ? 'Unknown Date' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(t);
        });

        const sym = this.getCurrencySymbol();
        let html = '';
        for (const [date, dateTrades] of Object.entries(grouped)) {
            const dayPnl = dateTrades.filter(t => t.status === 'closed').reduce((s, t) => s + (t.pnl || 0), 0);
            const dayPnlClass = dayPnl >= 0 ? 'text-green' : 'text-red';

            html += `<div class="trade-date-header">
                <span>${date}</span>
                <span class="${dayPnlClass}">${dateTrades.length} trades | P&L: ${dayPnl >= 0 ? '+' : ''}${sym}${Math.abs(dayPnl).toFixed(2)}</span>
            </div>`;

            dateTrades.forEach((trade, idx) => {
                html += this.renderTradeCard(trade, `${date}-${idx}`);
            });
        }

        container.innerHTML = html;
    },

    renderTradeCard(trade, uniqueId) {
        const notes = this.parseNotes(trade.notes);
        const isOpen = trade.status === 'open';
        const pnlClass = trade.pnl > 0 ? 'text-green' : (trade.pnl < 0 ? 'text-red' : '');
        const sideClass = trade.side === 'buy' ? 'trade-buy' : 'trade-sell';
        const sideIcon = trade.side === 'buy' ? '📈' : '📉';
        const statusIcon = isOpen ? '🔵' : (trade.pnl > 0 ? '🟢' : '🔴');
        const ts = trade.entry_time || trade.created_at || trade.timestamp;
        const tradeDate = ts ? new Date(ts.includes('T') || ts.includes('-') ? ts : parseInt(ts)) : new Date();
        const time = isNaN(tradeDate.getTime()) ? '--:--' : tradeDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        const symbol = this.extractSymbol(trade.symbol);
        const confidence = notes?.confidence || 0;

        // Confidence color
        const confColor = confidence >= 80 ? 'var(--accent-green)' : (confidence >= 60 ? 'var(--accent-yellow)' : 'var(--accent-red)');

        return `
            <div class="trade-card ${sideClass}" onclick="Trades.toggleDetail('${uniqueId}')">
                <div class="trade-card-main">
                    <div class="trade-card-left">
                        <span class="trade-side-icon">${sideIcon}</span>
                        <div>
                            <div class="trade-card-symbol">${symbol}</div>
                            <div class="trade-card-meta">${trade.side?.toUpperCase()} • ${time} • ${trade.strategy || 'N/A'}</div>
                        </div>
                    </div>
                    <div class="trade-card-right">
                        <div class="trade-card-price">${this.getCurrencySymbol()}${parseFloat(trade.price || 0).toFixed(2)}</div>
                        <div class="trade-card-pnl ${pnlClass}">
                            ${isOpen ? `${statusIcon} Open` : `${statusIcon} ${trade.pnl >= 0 ? '+' : ''}${this.getCurrencySymbol()}${Math.abs(trade.pnl || 0).toFixed(2)}`}
                        </div>
                        ${confidence > 0 ? `<div class="trade-card-confidence" style="color:${confColor}">⚡ ${confidence}%</div>` : ''}
                    </div>
                </div>
                <div class="trade-card-expand-icon">▼</div>

                <div class="trade-card-detail" id="tradeDetail-${uniqueId}" style="display:none">
                    ${this.renderTradeDetail(trade, notes)}
                </div>
            </div>`;
    },

    renderTradeDetail(trade, notes) {
        let html = '<div class="trade-detail-grid">';

        // Basic Info
        html += `
            <div class="detail-section">
                <div class="detail-section-title">📋 Trade Info</div>
                <div class="detail-row"><span>Symbol</span><span>${trade.symbol}</span></div>
                <div class="detail-row"><span>Side</span><span class="${trade.side === 'buy' ? 'text-green' : 'text-red'}">${trade.side?.toUpperCase()}</span></div>
                <div class="detail-row"><span>Entry Price</span><span>$${parseFloat(trade.price || 0).toFixed(4)}</span></div>
                <div class="detail-row"><span>Quantity</span><span>${trade.quantity || 'N/A'}</span></div>
                <div class="detail-row"><span>Status</span><span>${trade.status}</span></div>
                ${trade.pnl !== undefined ? `<div class="detail-row"><span>P&L</span><span class="${trade.pnl >= 0 ? 'text-green' : 'text-red'}">${trade.pnl >= 0 ? '+' : ''}$${Math.abs(trade.pnl).toFixed(4)} (₹${Math.abs(trade.pnl * this.exchangeRate).toFixed(2)})</span></div>` : ''}
            </div>`;

        // Strategy & Reasoning
        if (notes) {
            html += `
                <div class="detail-section">
                    <div class="detail-section-title">🧠 Why This Trade?</div>
                    <div class="detail-reason">${notes.reason || notes.humanReason || 'No reason recorded'}</div>
                    ${notes.strategyDescription ? `<div class="detail-row"><span>Strategy Logic</span><span>${notes.strategyDescription}</span></div>` : ''}
                    ${notes.confidence ? `<div class="detail-row"><span>Confidence</span><span>${notes.confidence}%</span></div>` : ''}
                </div>`;

            // Risk Management
            if (notes.takeProfit || notes.stopLoss) {
                html += `
                    <div class="detail-section">
                        <div class="detail-section-title">🛡️ Risk Management</div>
                        ${notes.takeProfit ? `<div class="detail-row"><span>Closing Order</span><span class="text-green">$${parseFloat(notes.takeProfit).toFixed(4)}</span></div>` : ''}
                        ${notes.stopLoss ? `<div class="detail-row"><span>Stop Loss</span><span class="text-red">$${parseFloat(notes.stopLoss).toFixed(4)}</span></div>` : ''}
                        ${notes.closingOrderId ? `<div class="detail-row"><span>Closing Order ID</span><span>${notes.closingOrderId}</span></div>` : ''}
                        ${notes.risk?.leverage ? `<div class="detail-row"><span>Leverage</span><span>${notes.risk.leverage}</span></div>` : ''}
                        ${notes.risk?.estimatedCost ? `<div class="detail-row"><span>Position Value</span><span>$${notes.risk.estimatedCost}</span></div>` : ''}
                    </div>`;
            }

            // Validation Details
            if (notes.validation) {
                const v = notes.validation;
                html += `
                    <div class="detail-section">
                        <div class="detail-section-title">✅ Signal Validation</div>
                        <div class="detail-row"><span>Score</span><span>${v.score || 'N/A'}</span></div>
                        <div class="detail-row"><span>Checks</span><span>${v.checksPassed || 'N/A'}</span></div>
                        ${v.passedChecks?.length ? `<div class="detail-checks passed">${v.passedChecks.map(c => `<span class="check-tag check-pass">✅ ${c}</span>`).join('')}</div>` : ''}
                        ${v.failedChecks?.length ? `<div class="detail-checks failed">${v.failedChecks.map(c => `<span class="check-tag check-fail">❌ ${c}</span>`).join('')}</div>` : ''}
                    </div>`;
            }

            // Market Conditions
            if (notes.marketConditions) {
                const mc = notes.marketConditions;
                html += `
                    <div class="detail-section">
                        <div class="detail-section-title">📊 Market Conditions</div>
                        ${mc.change24h ? `<div class="detail-row"><span>24h Change</span><span>${mc.change24h}</span></div>` : ''}
                        ${mc.spread ? `<div class="detail-row"><span>Spread</span><span>${mc.spread}</span></div>` : ''}
                        ${mc.dataFreshness ? `<div class="detail-row"><span>Data Fetched</span><span>${new Date(mc.dataFreshness).toLocaleTimeString()}</span></div>` : ''}
                    </div>`;
            }

            // Fresh Research Proof
            if (notes.freshResearch) {
                html += `
                    <div class="detail-section">
                        <div class="detail-section-title">🔬 Fresh Research</div>
                        <div class="detail-row"><span>Scan #</span><span>${notes.freshResearch.scanNumber}</span></div>
                        <div class="detail-row"><span>Candles Used</span><span>${notes.freshResearch.candleCount} × ${notes.freshResearch.candleTimeframe}</span></div>
                        <div class="detail-row"><span>Data Fetched At</span><span>${new Date(notes.freshResearch.dataFetchedAt).toLocaleTimeString()}</span></div>
                    </div>`;
            }
        }

        html += '</div>';
        return html;
    },

    parseNotes(notesStr) {
        if (!notesStr) return null;
        try { return typeof notesStr === 'string' ? JSON.parse(notesStr) : notesStr; }
        catch (e) { return { reason: notesStr }; }
    },

    extractSymbol(symbol) {
        return (symbol || '')
            .replace(/USDT$/, '')
            .replace(/USD$/, '')
            .replace(/INR$/, '')
            .replace(/_.*$/, '')
            .replace(/PERP$/, '')
            .toUpperCase();
    },

    toggleDetail(id) {
        const detail = document.getElementById(`tradeDetail-${id}`);
        if (!detail) return;

        const card = detail.closest('.trade-card');
        const expandIcon = card?.querySelector('.trade-card-expand-icon');

        if (detail.style.display === 'none') {
            detail.style.display = 'block';
            card?.classList.add('expanded');
            if (expandIcon) expandIcon.textContent = '▲';
        } else {
            detail.style.display = 'none';
            card?.classList.remove('expanded');
            if (expandIcon) expandIcon.textContent = '▼';
        }
    },

    async clearHistory() {
        if (!confirm('Clear all trade history? This cannot be undone.')) return;
        try {
            await fetch('/api/trades/history', { method: 'DELETE' });
            this.trades = [];
            this.render();
            if (typeof App !== 'undefined') App.showToast('Trade history cleared', 'info');
        } catch (error) {
            if (typeof App !== 'undefined') App.showToast('Failed to clear history', 'error');
        }
    },

    exportCSV() {
        if (this.trades.length === 0) {
            if (typeof App !== 'undefined') App.showToast('No trades to export', 'info');
            return;
        }

        const headers = ['Date', 'Symbol', 'Side', 'Price', 'Quantity', 'Strategy', 'Confidence', 'Status', 'P&L', 'Reason'];
        const rows = this.trades.map(t => {
            const notes = this.parseNotes(t.notes);
            const ts = t.entry_time || t.created_at || t.timestamp;
            const d = ts ? new Date(ts) : new Date();
            return [
                isNaN(d.getTime()) ? 'N/A' : d.toLocaleString(),
                t.symbol, t.side, t.price, t.quantity, t.strategy,
                notes?.confidence || '', t.status, t.pnl || 0,
                (notes?.reason || '').replace(/,/g, ';')
            ];
        });

        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cryptobot_trades_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        if (typeof App !== 'undefined') App.showToast('Trades exported to CSV', 'success');
    }
};
