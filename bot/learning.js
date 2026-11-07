// Paper trading is isolated from all authenticated order and position APIs.
const db = require('../database');
const api = require('./delta-api');
const strategies = require('./strategies');
const KEY = 'paper_learning_v1';
const SYMBOL = 'BTCUSD';
const HOLD_MS = 5 * 60 * 1000;

class Learning {
    constructor() { this.running = false; this.generation = 0; this.timer = null; this.error = null; }
    load() { try { return JSON.parse(db.getSetting(KEY, '{}')); } catch (_) { return {}; } }
    state() {
        const s = this.load();
        return { learnings: s.learnings || [], trades: s.trades || [], open: s.open || null, seenReal: s.seenReal || [] };
    }
    save(s) { db.setSetting(KEY, JSON.stringify(s)); }
    matches(rule, signal, context) {
        // Legacy unscoped rules are never applied to real or paper trading.
        return rule.implemented && rule.symbol && rule.strategy && rule.symbol === context.symbol &&
            (rule.strategy === context.strategy || rule.strategy === context.strategyName) &&
            rule.side === signal.signal && Number.isFinite(signal.confidence) && signal.confidence < rule.threshold;
    }
    blocks(signal, context = {}, rules = this.state().learnings) {
        return rules.some(rule => this.matches(rule, signal, context));
    }
    learn(s, trade, source, id) {
        if (!(Number(trade.pnl) < 0) || !['buy', 'sell'].includes(trade.side) ||
            !Number.isFinite(Number(trade.confidence)) || Number(trade.confidence) < 0 || Number(trade.confidence) >= 100 || !trade.symbol || !trade.strategy) return;
        const threshold = Math.min(100, Math.floor(Number(trade.confidence)) + 1);
        s.learnings.push({ id, source, symbol: trade.symbol, strategy: trade.strategy, side: trade.side, threshold,
            evidence: `Loss at confidence ${trade.confidence}; propose blocking ${trade.side} signals below ${threshold}%. One observation, not proof.`,
            implemented: false, createdAt: new Date().toISOString(), verification: [], history: [] });
    }
    collectReal(s) {
        // Synced/manual trades and trades without a signal confidence cannot yield a confidence filter.
        for (const t of db.getTradeHistory(10000)) {
            if (t.status !== 'closed' || s.seenReal.includes(t.id)) continue;
            s.seenReal.push(t.id);
            let notes = {}; try { notes = JSON.parse(t.notes || '{}'); } catch (_) {}
            const confidence = Number(notes.confidence ?? notes.signalConfidence ?? notes.signal?.confidence);
            if (Number.isFinite(confidence) && confidence > 0)
                this.learn(s, { side: t.side, symbol: t.symbol, strategy: t.strategy, pnl: t.pnl, confidence }, 'real', `real-${t.id}`);
        }
    }
    status() {
        const s = this.state();
        return { ...s, running: this.running, error: this.error, symbol: SYMBOL, interval: '5m',
            caveat: 'BTCUSD paper results use five-minute mark-price changes, not executed orders. Fees, funding, slippage and risk controls are excluded. Shadow outcomes compare the same signals with and without filters, not profitability or causation. Real-trade P&L uses recorded reconciliation data.' };
    }
    start() {
        if (this.running) return;
        this.running = true; this.error = null;
        this.loop(++this.generation);
    }
    stop() { this.running = false; ++this.generation; clearTimeout(this.timer); this.timer = null; }
    async loop(generation) {
        try { await this.tick(generation); if (this.running && generation === this.generation) this.error = null; }
        catch (e) { if (this.running && generation === this.generation) this.error = e.message; }
        if (this.running && generation === this.generation) this.timer = setTimeout(() => this.loop(generation), 60000);
    }
    async tick(generation) {
        if (!this.running || generation !== this.generation) return;
        // Real-trade observations do not depend on paper market-data availability.
        const realState = this.state();
        this.collectReal(realState);
        this.save(realState);
        const ticker = await api.getTickerBySymbol(SYMBOL);
        if (!this.running || generation !== this.generation) return;
        const end = Math.floor(Date.now() / 1000);
        const candles = await api.getCandles(SYMBOL, '5m', end - 60 * 60 * 8, end);
        if (!this.running || generation !== this.generation) return;
        const price = Number(ticker?.mark_price || ticker?.close);
        if (!Number.isFinite(price) || price <= 0 || !Array.isArray(candles) || candles.length < 30)
            throw new Error('Insufficient current BTCUSD market data');
        candles.sort((a, b) => Number(a.time) - Number(b.time));
        const latest = Number(candles[candles.length - 1].time);
        if (!Number.isFinite(latest) || latest < end - 900 || latest > end + 60)
            throw new Error('BTCUSD candles are stale or have invalid timestamps');
        if (candles.some(c => !['close', 'open', 'high', 'low', 'volume'].every(k => c[k] != null && Number.isFinite(Number(c[k])))))
            throw new Error('Invalid BTCUSD candle data');
        const s = this.state();
        if (s.open && Date.now() - s.open.openedAt >= HOLD_MS) {
            const t = { ...s.open, exit: price, closedAt: Date.now(), pnl: (price - s.open.entry) / s.open.entry * (s.open.side === 'buy' ? 1 : -1) * 100 };
            s.trades.push(t); s.open = null;
            // Shadow-blocked signals are not trades taken by the implemented paper strategy.
            if (!t.blocked) this.learn(s, t, 'demo', `demo-${t.id}`);
            for (const id of t.appliedIds || []) {
                const rule = s.learnings.find(r => r.id === id);
                if (rule) (rule.verification ||= []).push({ tradeId: t.id, pnlPercent: t.pnl, closedAt: t.closedAt,
                    blockedByRule: (t.blockingIds || []).includes(id), blockedByAny: !!t.blocked });
            }
        }
        if (!s.open) {
            const data = { symbol: SYMBOL, closes: candles.map(c => Number(c.close)), opens: candles.map(c => Number(c.open)),
                highs: candles.map(c => Number(c.high)), lows: candles.map(c => Number(c.low)), volumes: candles.map(c => Number(c.volume)),
                bid: Number(ticker.bid || 0), ask: Number(ticker.ask || 0), currentPrice: price,
                fundingRate: ticker.funding_rate == null || ticker.funding_rate === '' ? null : Number(ticker.funding_rate) };
            const strategy = strategies.getActiveStrategy();
            const signal = strategy.analyze(data);
            if (['buy', 'sell'].includes(signal.signal) && Number.isFinite(signal.confidence)) {
                const context = { symbol: SYMBOL, strategy: strategy.id, strategyName: strategy.name };
                const applied = s.learnings.filter(r => r.implemented && r.symbol === SYMBOL &&
                    (r.strategy === strategy.id || r.strategy === strategy.name));
                const blocking = applied.filter(r => this.matches(r, signal, context));
                // Observe the baseline even if a rule blocks the signal, so the outcome is comparable.
                s.open = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, symbol: SYMBOL,
                    side: signal.signal, confidence: signal.confidence, strategy: strategy.id, entry: price,
                    openedAt: Date.now(), appliedIds: applied.map(r => r.id), blockingIds: blocking.map(r => r.id), blocked: blocking.length > 0 };
            }
        }
        this.save(s);
    }
    update(ids, action) {
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Select at least one learning');
        if (!['implement', 'delete'].includes(action)) throw new Error('Invalid action');
        const s = this.state();
        if (ids.some(id => !s.learnings.some(r => r.id === id))) throw new Error('Unknown learning');
        const selected = s.learnings.filter(r => ids.includes(r.id));
        if (action === 'implement' && selected.some(r => !r.symbol || !r.strategy)) throw new Error('Unscoped legacy learnings cannot be implemented safely');
        if (action === 'delete' && selected.some(r => !r.implemented)) throw new Error('Only implemented learnings can be removed');
        const now = new Date().toISOString();
        for (const rule of selected) {
            if (action === 'implement' && !rule.implemented) {
                rule.implemented = true; rule.implementedAt = now; rule.removedAt = null;
                (rule.history ||= []).push({ action: 'implemented', at: now });
            } else if (action === 'delete') {
                rule.implemented = false; rule.removedAt = now;
                (rule.history ||= []).push({ action: 'removed', at: now });
            }
        }
        this.save(s); return this.status();
    }
}
module.exports = new Learning();
