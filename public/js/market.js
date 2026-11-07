/**
 * Market Module - Real-time crypto market data with Delta Exchange style
 * v2.1: Full ticker display, category tabs, search, auto-refresh, price flash
 */
const Market = {
    tickers: [],
    filteredTickers: [],
    currentFilter: 'all',
    searchQuery: '',
    refreshTimer: null,
    previousPrices: {},

    async init() {
        await this.loadTickers();
        // Auto-refresh every 5 seconds for real-time feel
        this.refreshTimer = setInterval(() => this.loadTickers(true), 5000);
    },

    async loadTickers(silent = false) {
        try {
            const res = await fetch('/api/market/tickers');
            const data = await res.json();
            if (!data || !Array.isArray(data) || data.length === 0) {
                if (!silent) this.showEmpty('No tickers received from Delta Exchange');
                return;
            }

            // Save previous prices for flash animation
            this.tickers.forEach(t => {
                if (t.symbol && t.mark_price) {
                    this.previousPrices[t.symbol] = parseFloat(t.mark_price);
                }
            });

            this.tickers = data.filter(t => {
                const price = parseFloat(t.price || t.mark_price || t.close || 0);
                return price > 0 && t.symbol;
            }).map(t => ({
                symbol: t.symbol,
                name: this.extractName(t.symbol),
                price: parseFloat(t.price || t.mark_price || t.close || 0),
                open: parseFloat(t.open || 0),
                high: parseFloat(t.high || 0),
                low: parseFloat(t.low || 0),
                close: parseFloat(t.close || t.price || t.mark_price || 0),
                volume: parseFloat(t.volume || 0),
                turnover: parseFloat(t.turnover || t.turnover_usd || 0),
                change24h: t.change24h !== undefined ? parseFloat(t.change24h) : this.calcChange(t),
                bid: parseFloat(t.bid || 0),
                ask: parseFloat(t.ask || 0),
                productId: t.product_id || t.id,
                contractType: t.contract_type || 'perpetual'
            }));

            this.applyFilter(this.currentFilter);
        } catch (error) {
            if (!silent) this.showEmpty('Failed to load market data. Check API connection.');
            console.error('Market load error:', error);
        }
    },

    extractName(symbol) {
        return (symbol || '')
            .replace(/USDT$/, '')
            .replace(/USD$/, '')
            .replace(/INR$/, '')
            .replace(/_.*$/, '')
            .replace(/PERP$/, '')
            .toUpperCase();
    },

    calcChange(t) {
        const close = parseFloat(t.close || t.mark_price || 0);
        const open = parseFloat(t.open || 0);
        if (open <= 0) return 0;
        return ((close - open) / open) * 100;
    },

    search(query) {
        this.searchQuery = (query || '').toLowerCase().trim();
        this.applyFilter(this.currentFilter);
    },

    setFilter(filter, btn) {
        this.currentFilter = filter;
        // Update tab active state
        document.querySelectorAll('.market-tab').forEach(t => t.classList.remove('active'));
        if (btn) btn.classList.add('active');
        this.applyFilter(filter);
    },

    applyFilter(filter) {
        let data = [...this.tickers];

        // Text search
        if (this.searchQuery) {
            data = data.filter(t =>
                t.symbol.toLowerCase().includes(this.searchQuery) ||
                t.name.toLowerCase().includes(this.searchQuery)
            );
        }

        switch (filter) {
            case 'trending':
                // Trending = high volume + significant price change
                data = data.filter(t => Math.abs(t.change24h) > 1 && t.volume > 0)
                    .sort((a, b) => (Math.abs(b.change24h) * b.volume) - (Math.abs(a.change24h) * a.volume));
                break;
            case 'gainers':
                data = data.filter(t => t.change24h > 0).sort((a, b) => b.change24h - a.change24h);
                break;
            case 'losers':
                data = data.filter(t => t.change24h < 0).sort((a, b) => a.change24h - b.change24h);
                break;
            case 'volume':
                data.sort((a, b) => b.volume - a.volume);
                break;
            case 'value':
                data.sort((a, b) => b.turnover - a.turnover);
                break;
            case '52high':
                // Approximate: close near high
                data = data.filter(t => t.high > 0 && t.close >= t.high * 0.98)
                    .sort((a, b) => (b.close / b.high) - (a.close / a.high));
                break;
            case '52low':
                // Approximate: close near low
                data = data.filter(t => t.low > 0 && t.close <= t.low * 1.02)
                    .sort((a, b) => (a.close / a.low) - (b.close / b.low));
                break;
            default:
                // All — sort by volume
                data.sort((a, b) => b.volume - a.volume);
        }

        this.filteredTickers = data;
        this.render();
    },

    render() {
        const container = document.getElementById('marketList');
        if (!this.filteredTickers || this.filteredTickers.length === 0) {
            const filterNames = {
                all: 'All', trending: 'Trending', gainers: 'Top Gainers', losers: 'Top Losers',
                volume: 'Active by Volume', value: 'Active by Value', '52high': 'Near high', '52low': 'Near low'
            };
            container.innerHTML = `<div class="empty-state"><div class="empty-symbol">◇</div><div class="title">No Results</div><div class="desc">No cryptos found for "${filterNames[this.currentFilter] || this.currentFilter}"${this.searchQuery ? ` matching "${this.searchQuery}"` : ''}</div></div>`;
            return;
        }

        container.innerHTML = this.filteredTickers.map(t => {
            const changeClass = t.change24h >= 0 ? 'positive' : 'negative';
            const changeSign = t.change24h >= 0 ? '+' : '';
            const arrow = t.change24h >= 0 ? '▲' : '▼';
            const changePercent = Math.abs(t.change24h) > 100 ? t.change24h.toFixed(0) : t.change24h.toFixed(2);

            // Price flash animation
            const prevPrice = this.previousPrices[t.symbol] || 0;
            let flashClass = '';
            if (prevPrice > 0 && prevPrice !== t.price) {
                flashClass = t.price > prevPrice ? 'flash-green' : 'flash-red';
            }

            // Volume formatting
            const volStr = this.formatVolume(t.volume);
            const turnoverStr = this.formatVolume(t.turnover);

            // Mini bar for change visualization  
            const barWidth = Math.min(100, Math.abs(t.change24h) * 10);

            // Icon (first 2 letters)
            const icon = t.name.slice(0, 2);

            return `
                <div class="market-item ${flashClass}" onclick="Market.showDetail('${t.symbol}')" id="market-${t.symbol}">
                    <div class="market-item-left">
                        <div class="market-item-icon">${icon}</div>
                        <div>
                            <div class="market-item-name">${t.name}</div>
                            <div class="market-item-sub">${t.symbol}</div>
                        </div>
                    </div>
                    <div class="market-item-center">
                        <div class="market-mini-bar">
                            <div class="market-mini-bar-fill ${changeClass}" style="width:${barWidth}%"></div>
                        </div>
                        <span class="market-item-volume">Vol: ${volStr}</span>
                    </div>
                    <div class="market-item-right">
                        <div class="market-item-price ${flashClass}">$${this.formatPrice(t.price)}</div>
                        <div class="market-item-change ${changeClass}">
                            <span class="change-arrow">${arrow}</span> ${changeSign}${changePercent}%
                        </div>
                        ${t.turnover > 0 ? `<div class="market-item-volume">Val: $${turnoverStr}</div>` : ''}
                    </div>
                </div>`;
        }).join('');

        // Remove flash classes after animation
        setTimeout(() => {
            document.querySelectorAll('.flash-green, .flash-red').forEach(el => {
                el.classList.remove('flash-green', 'flash-red');
            });
        }, 600);
    },

    showDetail(symbol) {
        const t = this.tickers.find(x => x.symbol === symbol);
        if (!t) return;

        const changeClass = t.change24h >= 0 ? 'positive' : 'negative';
        const changeSign = t.change24h >= 0 ? '+' : '';

        // Create modal overlay
        const existing = document.getElementById('marketDetailModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'marketDetailModal';
        modal.className = 'market-detail-modal';
        modal.innerHTML = `
            <div class="market-detail-content">
                <div class="market-detail-header">
                    <div class="market-item-icon" style="width:48px;height:48px;font-size:20px">${t.name.slice(0, 2)}</div>
                    <div>
                        <h3>${t.name}</h3>
                        <span style="color:var(--text-muted)">${t.symbol}</span>
                    </div>
                    <button class="market-detail-close" onclick="document.getElementById('marketDetailModal').remove()">✕</button>
                </div>
                <div class="market-detail-price">
                    <span class="price">$${this.formatPrice(t.price)}</span>
                    <span class="market-item-change ${changeClass}">${changeSign}${t.change24h.toFixed(2)}%</span>
                </div>
                <div class="market-detail-grid">
                    <div class="detail-item"><span class="label">Open</span><span class="value">$${this.formatPrice(t.open)}</span></div>
                    <div class="detail-item"><span class="label">High</span><span class="value text-green">$${this.formatPrice(t.high)}</span></div>
                    <div class="detail-item"><span class="label">Low</span><span class="value text-red">$${this.formatPrice(t.low)}</span></div>
                    <div class="detail-item"><span class="label">Close</span><span class="value">$${this.formatPrice(t.close)}</span></div>
                    <div class="detail-item"><span class="label">Volume</span><span class="value">${this.formatVolume(t.volume)}</span></div>
                    <div class="detail-item"><span class="label">Turnover</span><span class="value">$${this.formatVolume(t.turnover)}</span></div>
                    <div class="detail-item"><span class="label">Bid</span><span class="value text-green">$${this.formatPrice(t.bid)}</span></div>
                    <div class="detail-item"><span class="label">Ask</span><span class="value text-red">$${this.formatPrice(t.ask)}</span></div>
                </div>
            </div>
        `;
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
        document.body.appendChild(modal);
    },

    formatPrice(p) {
        if (!p || isNaN(p)) return '0.00';
        if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
        if (p >= 1) return p.toFixed(2);
        if (p >= 0.01) return p.toFixed(4);
        return p.toFixed(6);
    },

    formatVolume(v) {
        if (!v || isNaN(v)) return '0';
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
        return v.toFixed(0);
    },

    showEmpty(msg) {
        const container = document.getElementById('marketList');
        container.innerHTML = `<div class="empty-state"><div class="empty-symbol">◇</div><div class="title">No Market Data</div><div class="desc">${msg}</div></div>`;
    },

    destroy() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
    }
};
