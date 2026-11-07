/**
 * Core Bot Trading Engine
 * Handles market scanning, strategy execution, order placement, and lifecycle
 * v2.3: Position reconciliation with closing order cleanup, manual refresh, auto-refresh
 */
const deltaApi = require('./delta-api');
const strategyManager = require('./strategies');
const riskManager = require('./risk-manager');
const signalValidator = require('./signal-validator');
const db = require('../database');

class BotEngine {
    constructor() {
        this.running = false;
        this.startGeneration = 0;
        this.starting = false;
        this.scanInFlight = false;
        this.scanTimer = null;
        this.autoRefreshTimer = null;
        this.io = null;
        this.products = [];
        this.scanInterval = 5000;
        this.tradeableProducts = [];
        this.scanCount = 0;
        this.tradesPlacedThisScan = 0;
        // Fresh research: no caching of any market data
        this._lastScanTimestamp = null;
        this._lastRefreshTimestamp = null;
        // Delta Exchange actual position count (updated during sync)
        this._deltaPositionCount = 0;
    }

    setIO(io) {
        this.io = io;
    }

    log(level, message, data = null) {
        const entry = { level, message, data, timestamp: new Date().toISOString() };
        db.addLog(level, message, data);
        if (this.io) this.io.emit('bot:log', entry);
        const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌', trade: '💰', signal: '📊' };
        console.log(`${icons[level] || '📋'} [${level.toUpperCase()}] ${message}`);
    }

    emitStatus() {
        if (this.io) {
            this.io.emit('bot:status', {
                running: this.running,
                activeStrategy: strategyManager.getActiveStrategy()?.getInfo(),
                timestamp: new Date().toISOString()
            });
        }
    }

    // Emit dashboard refresh so trades/stats update in real-time
    emitDashboardRefresh() {
        if (this.io) this.io.emit('bot:refresh', { timestamp: new Date().toISOString() });
    }

    async initialize() {
        try {
            const apiKey = db.getEncryptedSetting('api_key');
            const apiSecret = db.getEncryptedSetting('api_secret');
            if (!apiKey || !apiSecret) {
                this.log('warning', 'API credentials not configured. Go to Settings to add them.');
                return false;
            }
            deltaApi.setCredentials(apiKey, apiSecret);

            const savedStrategy = db.getSetting('active_strategy', 'multi-ai');
            try { strategyManager.setActiveStrategy(savedStrategy); } 
            catch (e) { strategyManager.setActiveStrategy('multi-ai'); }

            const test = await deltaApi.testConnection();
            if (!test.connected) {
                this.log('error', `Delta Exchange connection failed: ${test.error}`);
                return false;
            }
            this.log('success', 'Connected to Delta Exchange India');
            await this.loadProducts();
            return true;
        } catch (error) {
            this.log('error', `Initialization failed: ${error.message}`);
            return false;
        }
    }

    async loadProducts() {
        try {
            this.products = await deltaApi.getProducts();
            this.tradeableProducts = this.products.filter(p =>
                p.contract_type === 'perpetual_futures' && p.state === 'live' && p.is_quanto === false
            );
            this.log('info', `📋 Loaded ${this.tradeableProducts.length} tradeable cryptos`);
        } catch (error) {
            this.log('error', `Failed to load products: ${error.message}`);
        }
    }

    async start() {
        if (this.running || this.starting) { this.log('warning', 'Bot is already running or starting'); return; }
        const generation = ++this.startGeneration;
        this.starting = true;
        this.log('info', '🚀 Starting CryptoBOT...');
        let initialized;
        try { initialized = await this.initialize(); } finally { this.starting = false; }
        if (generation !== this.startGeneration) return;
        if (!initialized) { this.log('error', 'Failed to initialize. Check settings and try again.'); return; }
        this.running = true;
        this.scanCount = 0;
        this.emitStatus();
        const strategy = strategyManager.getActiveStrategy();
        this.log('success', `✅ Bot started | Strategy: ${strategy.name} (${strategy.getInfo().winRate}% win) | Scanning all cryptos...`);
        // Sync Delta positions to DB BEFORE starting scans
        // This ensures manual/external positions are counted toward limits
        await this.syncDeltaPositionsToDb();
        if (!this.running || generation !== this.startGeneration) return;
        this.startAutoRefresh();
        this.scanLoop();
    }

    stop() {
        ++this.startGeneration;
        if (!this.running) { this.log('warning', 'Bot is not running'); return; }
        this.running = false;
        if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
        if (this.autoRefreshTimer) { clearInterval(this.autoRefreshTimer); this.autoRefreshTimer = null; }
        this.emitStatus();
        this.log('info', `🛑 Bot stopped | Total scans: ${this.scanCount}`);
    }

    /**
     * Start auto-refresh timer to periodically reconcile positions
     * Interval is configurable via 'auto_refresh_minutes' setting
     */
    startAutoRefresh() {
        if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
        const minutes = parseInt(db.getSetting('auto_refresh_minutes', '5'));
        if (minutes <= 0) return;
        this.autoRefreshTimer = setInterval(async () => {
            if (!this.running) return;
            this.log('info', `🔄 Auto-refresh: Syncing positions with Delta Exchange...`);
            await this.syncDeltaPositionsToDb();
            await this.checkOpenPositions();
        }, minutes * 60 * 1000);
        this.log('info', `⏰ Auto-refresh set: Every ${minutes} minute(s)`);
    }

    async scanLoop(generation = this.startGeneration) {
        if (!this.running || generation !== this.startGeneration) return;
        if (!this.scanInFlight) {
            this.scanInFlight = true;
            try { await this.scan(generation); }
            catch (error) { this.log('error', `Scan error: ${error.message}`); }
            finally { this.scanInFlight = false; }
        }
        if (!this.running || generation !== this.startGeneration) return;
        const interval = parseInt(db.getSetting('scan_interval', this.scanInterval));
        // Refresh can request a scan while another is in flight: keep one timer only.
        if (this.scanTimer) clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scanLoop(generation); }, interval);
    }

    async scan(generation = this.startGeneration) {
        this.scanCount++;
        this.tradesPlacedThisScan = 0;
        this._lastScanTimestamp = Date.now(); // Fresh research timestamp
        const settings = riskManager.getSettings();
        const sym = settings.currency === 'INR' ? '₹' : (settings.currency === 'BTC' ? '₿' : '$');

        // === RECONCILE FIRST: Sync DB with exchange BEFORE checking limits ===
        // This fixes the bug where stale "open" trades in DB block new orders
        await this.checkOpenPositions();

        // === FRESH RESEARCH: Always fetch fresh balance ===
        let balance;
        try { balance = await deltaApi.getBalance(settings.currency); } 
        catch (error) { this.log('error', `Failed to get balance: ${error.message}`); return; }
        if (this.io) this.io.emit('bot:balance', balance);

        // === FRESH RESEARCH: Always fetch fresh tickers (no cache) ===
        let tickers;
        try { tickers = await deltaApi.getTickers(); } 
        catch (error) { this.log('error', `Failed to get tickers: ${error.message}`); return; }
        if (!tickers || tickers.length === 0) { this.log('warning', '⚠️ No tickers received'); return; }

        // Filter by price range
        const filteredTickers = tickers.filter(t => {
            const price = parseFloat(t.mark_price || t.close || 0);
            return price >= settings.minPrice && price <= settings.maxPrice && price > 0;
        });
        const priceFilteredOut = tickers.length - filteredTickers.length;

        // === SCAN START LOG ===
        this.log('info', `🔍 Scan #${this.scanCount} | Balance: ${sym}${(balance.balance || 0).toFixed(2)} | Cryptos: ${filteredTickers.length} (${priceFilteredOut} out of range) | Strategy: ${strategyManager.getActiveStrategy().name} | Fresh@${new Date().toISOString()}`);

        // Track scan stats
        let stats = { analyzed: 0, riskBlocked: 0, noData: 0, noSignal: 0, signalsFound: 0, fakeRejected: 0, tradesPlaced: 0 };

        // === CHECK GLOBAL LIMITS (after reconciliation) ===
        const globalCheck = this.checkGlobalLimits(settings, balance, sym);
        if (!globalCheck.allowed) {
            this.log('warning', globalCheck.reason);
            return;
        }

        // Analyze ALL tickers
        for (const ticker of filteredTickers) {
            if (!this.running || generation !== this.startGeneration) break;
            try { await this.analyzeTicker(ticker, balance, stats, settings, generation); }
            catch (error) { /* skip individual errors */ }
            await this.sleep(300);
        }

        // === SCAN SUMMARY ===
        const parts = [`Analyzed: ${stats.analyzed}`];
        if (stats.riskBlocked > 0) parts.push(`Risk blocked: ${stats.riskBlocked}`);
        if (stats.noData > 0) parts.push(`No data: ${stats.noData}`);
        if (stats.noSignal > 0) parts.push(`No signal: ${stats.noSignal}`);
        if (stats.signalsFound > 0) parts.push(`Signals: ${stats.signalsFound}`);
        if (stats.fakeRejected > 0) parts.push(`🚫 Fake rejected: ${stats.fakeRejected}`);
        if (stats.tradesPlaced > 0) parts.push(`✅ Trades: ${stats.tradesPlaced}`);
        this.log('info', `📊 Scan #${this.scanCount} done | ${parts.join(' | ')}`);
    }

    checkGlobalLimits(settings, balance, sym) {
        const dailyStats = db.getTodayStats();
        const openTrades = db.getOpenTrades();
        // Use the HIGHER of DB count or actual Delta position count
        // This prevents opening too many trades when Delta has positions not yet in DB
        const effectiveOpen = Math.max(openTrades.length, this._deltaPositionCount || 0);

        if (balance.available <= settings.minBalance) {
            return { allowed: false, reason: `💰 Balance exhausted: ${sym}${balance.available.toFixed(2)} ≤ min ${sym}${settings.minBalance} — Pausing trades` };
        }
        if (dailyStats.total_trades >= settings.maxDailyTrades) {
            return { allowed: false, reason: `📊 Daily trade limit: ${dailyStats.total_trades}/${settings.maxDailyTrades} — Pausing` };
        }
        if (Math.abs(dailyStats.total_loss) >= settings.maxDailyLoss) {
            return { allowed: false, reason: `🔴 Daily loss limit: ${sym}${Math.abs(dailyStats.total_loss).toFixed(2)} ≥ ${sym}${settings.maxDailyLoss} — Pausing` };
        }
        if (effectiveOpen >= settings.maxOpenPositions) {
            return { allowed: false, reason: `📈 Max open positions: ${effectiveOpen}/${settings.maxOpenPositions} (Delta: ${this._deltaPositionCount || 0}, Bot DB: ${openTrades.length}) — Pausing new orders` };
        }
        return { allowed: true };
    }

    async analyzeTicker(ticker, balance, stats, settings, generation = this.startGeneration) {
        const symbol = ticker.symbol;
        const price = parseFloat(ticker.mark_price || ticker.close || 0);
        if (price <= 0) return;
        stats.analyzed++;

        // === RE-CHECK OPEN POSITIONS LIMIT (may change during scan) ===
        const currentOpen = db.getOpenTrades();
        const effectiveOpen = Math.max(currentOpen.length, this._deltaPositionCount || 0);
        if (effectiveOpen >= settings.maxOpenPositions) {
            stats.riskBlocked++;
            return; // Don't spam — already logged at global level
        }

        // Check all risk rules
        const riskCheck = riskManager.canTrade({
            symbol, price, availableBalance: balance.available, side: 'buy'
        });

        if (!riskCheck.allowed) {
            stats.riskBlocked++;
            if (!riskCheck.reason.includes('Cooldown')) {
                this.log('warning', `⛔ ${symbol} @ ${price}: ${riskCheck.reason}`);
            }
            return;
        }

        // === FRESH RESEARCH: Fetch fresh candle data for EVERY analysis ===
        let candles;
        try {
            const end = Math.floor(Date.now() / 1000);
            const start = end - (60 * 60 * 4); // 4 hours of 5m candles
            candles = await deltaApi.getCandles(symbol, '5m', start, end);
        } catch (error) { stats.noData++; return; }
        if (!candles || candles.length < 30) { stats.noData++; return; }

        // Prepare market data — ALWAYS fresh, never cached
        const marketData = {
            symbol,
            closes: candles.map(c => parseFloat(c.close)),
            opens: candles.map(c => parseFloat(c.open)),
            highs: candles.map(c => parseFloat(c.high)),
            lows: candles.map(c => parseFloat(c.low)),
            volumes: candles.map(c => parseFloat(c.volume)),
            bid: parseFloat(ticker.bid || 0),
            ask: parseFloat(ticker.ask || 0),
            currentPrice: price,
            fundingRate: ticker.funding_rate == null || ticker.funding_rate === '' ? null : Number(ticker.funding_rate),
            fetchedAt: new Date().toISOString() // Proof of fresh data
        };

        // Run strategy
        const signal = strategyManager.analyze(marketData);
        if (signal.signal === 'none') { stats.noSignal++; return; }
        if (require('./learning').blocks(signal, { symbol, strategy: strategyManager.getActiveStrategy().id, strategyName: strategyManager.getActiveStrategy().name })) { stats.noSignal++; return; }

        stats.signalsFound++;
        const strategyName = signal.strategy || strategyManager.getActiveStrategy().name;

        this.log('signal', `🔔 ${signal.signal.toUpperCase()} ${symbol} @ ${price} | ${strategyName} | ${signal.confidence}% | ${signal.reason}`);

        // === MULTI-LAYER FAKE SIGNAL DETECTION ===
        const validation = signalValidator.validate(signal, marketData);
        if (!validation.valid) {
            stats.fakeRejected++;
            this.log('warning', `🚫 FAKE SIGNAL: ${symbol} | Score: ${validation.confidence}%/${signalValidator.minConfidence}% | ${validation.passedCount}/${validation.totalChecks} checks | Failed: ${validation.reasons.join(' | ')}`);
            return;
        }

        this.log('success', `✅ VALID: ${symbol} | Score: ${validation.confidence}% | ${validation.passedCount}/${validation.totalChecks} checks passed`);

        // === FINAL PRE-TRADE SAFETY CHECK (uses both DB and Delta counts) ===
        const finalOpen = db.getOpenTrades();
        const finalEffective = Math.max(finalOpen.length, this._deltaPositionCount || 0);
        if (finalEffective >= settings.maxOpenPositions) {
            this.log('warning', `⛔ ${symbol}: Max positions reached just before order (${finalEffective}/${settings.maxOpenPositions} — Delta: ${this._deltaPositionCount || 0}, DB: ${finalOpen.length})`);
            return;
        }

        if (!this.running || generation !== this.startGeneration) return;
        const traded = await this.executeTrade(symbol, signal, price, balance, ticker, strategyName, validation, marketData, generation);
        if (traded) stats.tradesPlaced++;
    }

    async executeTrade(symbol, signal, price, balance, ticker, strategyName, validation, marketData, generation = this.startGeneration) {
        const settings = riskManager.getSettings();
        const sym = settings.currency === 'INR' ? '₹' : (settings.currency === 'BTC' ? '₿' : '$');

        const product = this.products.find(p => p.symbol === symbol);
        if (!product) { this.log('warning', `Product not found: ${symbol}`); return false; }

        const quantity = riskManager.calculateQuantity(price, balance.available);
        if (quantity <= 0) {
            this.log('warning', `Qty=0 for ${symbol} (price: ${price}, balance: ${sym}${balance.available.toFixed(2)})`);
            return false;
        }

        const exits = riskManager.calculateExitPrices(price, signal.side);

        // Set leverage
        try {
            if (settings.leverage > 1) await deltaApi.setLeverage(product.id, settings.leverage);
        } catch (error) { this.log('warning', `Leverage error ${symbol}: ${error.message}`); }

        // === BUILD COMPREHENSIVE TRADE REASONING ===
        const tradeReasoning = {
            // Why this trade was taken
            strategy: strategyName,
            strategyDescription: strategyManager.getActiveStrategy()?.description || '',
            signal: signal.signal,
            side: signal.side,
            confidence: signal.confidence,
            reason: signal.reason,

            // Market conditions at time of trade
            marketConditions: {
                price: price,
                bid: marketData.bid,
                ask: marketData.ask,
                spread: marketData.ask > 0 ? ((marketData.ask - marketData.bid) / marketData.bid * 100).toFixed(4) + '%' : 'N/A',
                volume24h: ticker.volume || 0,
                change24h: ticker.close && ticker.open ? (((parseFloat(ticker.close) - parseFloat(ticker.open)) / parseFloat(ticker.open)) * 100).toFixed(2) + '%' : 'N/A',
                dataFreshness: marketData.fetchedAt
            },

            // Validation results
            validation: {
                score: validation.confidence + '%',
                checksPassed: `${validation.passedCount}/${validation.totalChecks}`,
                passedChecks: validation.passed || [],
                failedChecks: validation.reasons || [],
                details: (validation.details || []).map(d => `${d.name}: ${d.reason} (${d.score}pts)`)
            },

            // Risk parameters
            risk: {
                takeProfit: exits.takeProfit,
                stopLoss: exits.stopLoss,
                tpPercent: settings.profitPercent + '%',
                slPercent: settings.stopLossPercent + '%',
                leverage: settings.leverage + 'x',
                quantity: quantity,
                estimatedCost: (price * quantity).toFixed(2)
            },

            // Fresh research proof
            freshResearch: {
                scanNumber: this.scanCount,
                dataFetchedAt: marketData.fetchedAt,
                candleCount: marketData.closes.length,
                candleTimeframe: '5m',
                lookbackHours: 4
            }
        };

        // Human-readable trade explanation
        const humanReason = this.buildHumanReadableReason(tradeReasoning);

        // === STEP 1: Place OPENING order (market) with SL only (no bracket TP) ===
        if (!this.running || generation !== this.startGeneration) return false;
        try {
            this.log('trade', `📝 OPENING ORDER: ${signal.side.toUpperCase()} ${symbol} | Qty: ${quantity} | ~${price} | SL: ${exits.stopLoss} (-${settings.stopLossPercent}%) | By: ${strategyName} | WHY: ${signal.reason}`);

            const order = await deltaApi.placeBracketOrder({
                product_id: product.id,
                size: quantity,
                side: signal.side,
                order_type: 'market_order',
                // NO take_profit_price — closing order handles that
                stop_loss_price: exits.stopLoss
            });

            // === STEP 2: Place CLOSING order (reduce-only limit at target price) ===
            const closingSide = signal.side === 'buy' ? 'sell' : 'buy';
            let closingOrderId = null;
            try {
                const closingOrder = await deltaApi.placeOrder({
                    product_id: product.id,
                    size: quantity,
                    side: closingSide,
                    order_type: 'limit_order',
                    limit_price: exits.takeProfit,
                    reduce_only: true
                });
                closingOrderId = closingOrder.id || null;
                this.log('trade', `📋 CLOSING ORDER placed: ${closingSide.toUpperCase()} ${quantity}x ${symbol} @ ${exits.takeProfit} (reduce-only limit)`);
            } catch (closeErr) {
                this.log('warning', `⚠️ Closing order failed for ${symbol}: ${closeErr.message} — SL still active as safety`);
            }

            // Record trade in DB with comprehensive reasoning
            db.addTrade({
                trade_id: order.id || `T${Date.now()}`,
                symbol, side: signal.side, order_type: 'market',
                price, quantity, strategy: strategyName, status: 'open',
                notes: JSON.stringify({
                    confidence: signal.confidence,
                    takeProfit: exits.takeProfit,
                    stopLoss: exits.stopLoss,
                    closingOrderId: closingOrderId,
                    closingSide: closingSide,
                    reason: signal.reason,
                    humanReason: humanReason,
                    strategy: strategyName,
                    strategyDescription: tradeReasoning.strategyDescription,
                    marketConditions: tradeReasoning.marketConditions,
                    validation: tradeReasoning.validation,
                    risk: tradeReasoning.risk,
                    freshResearch: tradeReasoning.freshResearch
                })
            });

            // Update daily stats (trade count)
            db.updateDailyTradeCount();

            riskManager.setCooldown(symbol);

            this.log('success', `🎯 FILLED: ${signal.side.toUpperCase()} ${quantity}x ${symbol} @ ~${price} | Closing @ ${exits.takeProfit} | SL: ${exits.stopLoss} | ${strategyName} — ${humanReason}`);

            // Emit trade + refresh events
            if (this.io) {
                this.io.emit('bot:trade', {
                    symbol, side: signal.side, quantity, price,
                    takeProfit: exits.takeProfit, stopLoss: exits.stopLoss,
                    closingOrderId: closingOrderId,
                    strategy: strategyName, reason: humanReason,
                    tradeReasoning,
                    timestamp: new Date().toISOString()
                });
            }
            this.emitDashboardRefresh();
            return true;
        } catch (error) {
            this.log('error', `❌ Order FAILED ${symbol}: ${error.message}`);
            return false;
        }
    }

    /**
     * Build a human-readable explanation of why a trade was taken
     */
    buildHumanReadableReason(reasoning) {
        const parts = [];

        // Main signal reason
        parts.push(reasoning.reason);

        // Strategy context
        parts.push(`Strategy: ${reasoning.strategy}`);

        // Confidence
        parts.push(`Confidence: ${reasoning.confidence}%`);

        // Validation summary
        if (reasoning.validation) {
            parts.push(`Validated: ${reasoning.validation.checksPassed} checks passed (${reasoning.validation.score})`);
        }

        // Market context
        if (reasoning.marketConditions?.change24h && reasoning.marketConditions.change24h !== 'N/A') {
            parts.push(`24h Change: ${reasoning.marketConditions.change24h}`);
        }

        return parts.join(' | ');
    }

    /**
     * Reconcile DB open trades with actual exchange positions.
     * Runs at the START of every scan to ensure DB is in sync
     * before checking limits or placing new orders.
     *
     * Handles:
     * - Closing order filled on exchange → detect position gone, cancel leftover orders
     * - User manually sold on Delta → detect position gone, show P&L
     * - Only tracks trades the BOT placed (DB trades), never touches manual positions
     */
    async checkOpenPositions() {
        try {
            const openTrades = db.getOpenTrades();
            if (openTrades.length === 0) return; // Nothing to reconcile

            // Get product IDs for open trades (Delta API requires product_id)
            const productIds = [];
            for (const trade of openTrades) {
                const product = this.products.find(p => p.symbol === trade.symbol);
                if (product && !productIds.includes(product.id)) {
                    productIds.push(product.id);
                }
            }

            if (productIds.length === 0) {
                this.log('warning', '⚠️ No matching products found for open trades — Products may not be loaded');
                return;
            }

            const positions = await deltaApi.getPositions(productIds);

            this.log('info', `🔄 Reconciling ${openTrades.length} DB open trade(s) with exchange...`);
            let closedCount = 0;

            for (const trade of openTrades) {
                const position = positions.find(p => p.symbol === trade.symbol);
                const hasActivePosition = position && parseFloat(position.size) !== 0;

                if (!hasActivePosition) {
                    // Position is closed on exchange (closing order filled OR manual sell)
                    let pnl = 0;
                    let closedBy = 'unknown';

                    // Try to get realized PnL from the position data
                    if (position && position.realized_pnl) {
                        pnl = parseFloat(position.realized_pnl);
                    }

                    // Try to get better PnL from recent fills
                    const product = this.products.find(p => p.symbol === trade.symbol);
                    try {
                        if (product) {
                            const fills = await deltaApi.getFills({ product_id: product.id });
                            if (fills && fills.length > 0) {
                                const recentFills = fills.filter(f => {
                                    const fillTime = new Date(f.created_at || f.timestamp).getTime();
                                    const tradeTime = new Date(trade.entry_time).getTime();
                                    return fillTime > tradeTime;
                                });
                                if (recentFills.length > 0) {
                                    const fillPnl = recentFills.reduce((sum, f) => sum + parseFloat(f.realized_pnl || 0), 0);
                                    if (fillPnl !== 0) pnl = fillPnl;
                                    // Determine how it was closed
                                    const lastFill = recentFills[recentFills.length - 1];
                                    closedBy = lastFill.meta_data?.reason || lastFill.role || 'filled';
                                }
                            }
                        }
                    } catch (e) { /* use position PnL as fallback */ }

                    // === CANCEL any leftover closing orders for this symbol ===
                    try {
                        const notes = trade.notes ? (typeof trade.notes === 'string' ? JSON.parse(trade.notes) : trade.notes) : {};
                        if (notes.closingOrderId && product) {
                            await deltaApi.cancelOrder(notes.closingOrderId, product.id);
                            this.log('info', `🗑️ Cancelled leftover closing order #${notes.closingOrderId} for ${trade.symbol}`);
                        } else if (product) {
                            // Cancel ALL open orders for this product (safety cleanup)
                            await deltaApi.cancelAllOrders(product.id);
                            this.log('info', `🗑️ Cancelled all open orders for ${trade.symbol}`);
                        }
                    } catch (cancelErr) {
                        // Order may already be filled/cancelled — that's fine
                        this.log('info', `ℹ️ No leftover orders to cancel for ${trade.symbol}`);
                    }

                    db.closeTrade(trade.id, trade.price, pnl);
                    db.updateDailyStats(pnl > 0, pnl);
                    closedCount++;

                    const icon = pnl > 0 ? '🟢' : (pnl < 0 ? '🔴' : '⚪');
                    this.log('trade', `${icon} CLOSED: ${trade.symbol} | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | ${trade.strategy} | Closed by: ${closedBy}`);
                    this.emitDashboardRefresh();
                }
            }

            if (closedCount > 0) {
                const remaining = openTrades.length - closedCount;
                this.log('success', `✅ Reconciled: ${closedCount} trade(s) closed on exchange. ${remaining} still open.`);
            }

            this._lastRefreshTimestamp = Date.now();
        } catch (error) {
            this.log('warning', `⚠️ Position reconciliation failed: ${error.message} — Will retry next scan`);
        }
    }

    /**
     * Sync Delta Exchange positions into Bot DB
     * Ensures manual/external positions on Delta are tracked in the DB
     * so limit checks correctly count ALL open positions.
     *
     * Called at: bot start, auto-refresh, manual refresh
     */
    async syncDeltaPositionsToDb() {
        try {
            if (this.tradeableProducts.length === 0) {
                this.log('info', '📋 No products loaded — skipping Delta sync');
                return;
            }

            const deltaPositions = await deltaApi.getAllPositions(this.tradeableProducts);
            this._deltaPositionCount = deltaPositions.length;

            const openTrades = db.getOpenTrades();
            let syncedCount = 0;

            for (const pos of deltaPositions) {
                const symbol = pos.symbol;
                if (!symbol) continue;

                // Check if this Delta position is already tracked in bot DB
                const inDb = openTrades.find(t => t.symbol === symbol);
                if (!inDb) {
                    // Position exists on Delta but NOT in bot DB → add synced entry
                    const size = parseFloat(pos.size || 0);
                    const side = size > 0 ? 'buy' : 'sell';

                    db.addTrade({
                        trade_id: `SYNC_${Date.now()}_${pos.product_id || Math.random().toString(36).substr(2, 8)}`,
                        symbol: symbol,
                        side: side,
                        order_type: 'synced',
                        price: parseFloat(pos.entry_price || pos.mark_price || 0),
                        quantity: Math.abs(size),
                        strategy: 'manual/synced',
                        status: 'open',
                        notes: JSON.stringify({
                            source: 'delta_sync',
                            synced_at: new Date().toISOString(),
                            product_id: pos.product_id,
                            mark_price: parseFloat(pos.mark_price || 0),
                            unrealized_pnl: parseFloat(pos.unrealized_pnl || 0),
                            margin: parseFloat(pos.margin || 0)
                        })
                    });
                    syncedCount++;
                    this.log('info', `📥 Synced Delta position → DB: ${symbol} (${side.toUpperCase()} × ${Math.abs(size)})`);
                }
            }

            if (syncedCount > 0) {
                this.log('success', `✅ Synced ${syncedCount} Delta position(s) to bot DB. Total open: ${db.getOpenTrades().length}`);
                this.emitDashboardRefresh();
            }

            this.log('info', `📊 Positions — Delta: ${deltaPositions.length} | Bot DB: ${db.getOpenTrades().length}`);
        } catch (error) {
            this.log('warning', `⚠️ Delta position sync failed: ${error.message}`);
        }
    }

    /**
     * Manual refresh — callable from API endpoint
     * Syncs Delta positions to DB, reconciles, then if bot is running
     * and slots opened up, triggers an IMMEDIATE scan.
     */
    async refreshPositions() {
        // Make sure API is ready and products loaded
        if (this.products.length === 0) {
            const apiKey = db.getEncryptedSetting('api_key');
            const apiSecret = db.getEncryptedSetting('api_secret');
            if (apiKey && apiSecret) {
                deltaApi.setCredentials(apiKey, apiSecret);
                await this.loadProducts();
            }
        }

        // === Step 1: Sync Delta positions into DB (add missing ones) ===
        await this.syncDeltaPositionsToDb();

        // === Step 2: Fetch ALL Delta Exchange positions for display ===
        let deltaPositions = [];
        try {
            deltaPositions = await deltaApi.getAllPositions(this.tradeableProducts);
            this._deltaPositionCount = deltaPositions.length;
            this.log('info', `📊 Delta Exchange: ${deltaPositions.length} active position(s) found`);
        } catch (e) {
            this.log('warning', `⚠️ Failed to fetch Delta positions: ${e.message}`);
        }

        // === Step 3: Fetch fresh balance ===
        let balance = null;
        try {
            const settings = riskManager.getSettings();
            balance = await deltaApi.getBalance(settings.currency);
            if (this.io) this.io.emit('bot:balance', balance);
        } catch (e) {
            this.log('warning', `⚠️ Failed to fetch balance: ${e.message}`);
        }

        // === Step 4: Reconcile — close stale DB trades ===
        const beforeOpen = db.getOpenTrades().length;
        this.log('info', '🔄 Manual refresh triggered by user');
        await this.checkOpenPositions();
        const afterOpen = db.getOpenTrades().length;

        const settings = riskManager.getSettings();
        const slotsFreed = beforeOpen - afterOpen;
        const slotsAvailable = settings.maxOpenPositions - afterOpen;
        let scanTriggered = false;

        // If bot is running AND slots freed up, trigger immediate scan
        if (this.running && slotsAvailable > 0 && slotsFreed > 0) {
            this.log('success', `🚀 ${slotsFreed} position(s) freed! ${slotsAvailable} slot(s) available — Triggering immediate scan...`);
            // Clear existing scan timer and start a fresh scan immediately
            if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
            // Don't await — let it run in background so API responds immediately
            this.scanLoop();
            scanTriggered = true;
        } else if (this.running && slotsAvailable > 0) {
            this.log('info', `ℹ️ ${afterOpen}/${settings.maxOpenPositions} positions open. ${slotsAvailable} slot(s) available — Bot will trade on next scan.`);
        } else if (this.running && slotsAvailable <= 0) {
            this.log('warning', `📈 All ${settings.maxOpenPositions} position slot(s) full — Bot waiting for closures.`);
        } else {
            this.log('info', `ℹ️ Bot is stopped. ${afterOpen} open position(s) synced. Start the bot to trade.`);
        }

        const openTrades = db.getOpenTrades();
        const stats = db.getTradeStats();

        // Emit dashboard refresh so all pages update
        this.emitDashboardRefresh();

        return {
            success: true,
            openTrades: openTrades.length,
            maxPositions: settings.maxOpenPositions,
            slotsAvailable,
            slotsFreed,
            scanTriggered,
            botRunning: this.running,
            openTradesList: openTrades.map(t => ({
                id: t.id,
                symbol: t.symbol,
                side: t.side,
                price: t.price,
                quantity: t.quantity,
                strategy: t.strategy,
                entry_time: t.entry_time
            })),
            // Delta Exchange actual positions
            deltaPositions: deltaPositions.map(p => ({
                symbol: p.symbol,
                size: parseFloat(p.size || 0),
                entry_price: parseFloat(p.entry_price || 0),
                mark_price: parseFloat(p.mark_price || 0),
                unrealized_pnl: parseFloat(p.unrealized_pnl || 0),
                realized_pnl: parseFloat(p.realized_pnl || 0),
                side: parseFloat(p.size || 0) > 0 ? 'buy' : 'sell',
                margin: parseFloat(p.margin || 0),
                product_id: p.product_id
            })),
            // Balance info
            balance: balance ? {
                available: balance.available,
                walletBalance: balance.walletBalance,
                equity: balance.equity,
                marginUsed: balance.marginUsed,
                unrealizedPnl: balance.unrealizedPnl,
                assetSymbol: balance.assetSymbol
            } : null,
            totalTrades: stats.totalTrades,
            closedTrades: stats.closedTrades,
            totalPnl: stats.totalPnl,
            winRate: stats.winRate,
            lastRefresh: new Date().toISOString()
        };
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    getStatus() {
        return {
            running: this.running,
            activeStrategy: strategyManager.getActiveStrategy()?.getInfo(),
            productsLoaded: this.tradeableProducts.length,
            openTrades: db.getOpenTrades().length,
            scanCount: this.scanCount,
            lastRefresh: this._lastRefreshTimestamp ? new Date(this._lastRefreshTimestamp).toISOString() : null
        };
    }
}

module.exports = new BotEngine();
