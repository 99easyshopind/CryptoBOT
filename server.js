const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const os = require('os');
const axios = require('axios');

const config = require('./config.json');
const db = require('./database');

// Cache public IPv6
let cachedPublicIpv6 = null;
let ipv6LastFetch = 0;

async function getPublicIPv6() {
    if (cachedPublicIpv6 && (Date.now() - ipv6LastFetch) < 300000) {
        return cachedPublicIpv6;
    }

    const services = [
        'https://api6.ipify.org?format=text',
        'https://v6.ident.me',
        'https://ipv6.icanhazip.com'
    ];

    for (const url of services) {
        try {
            const res = await axios.get(url, { timeout: 5000, family: 6 });
            const ip = (res.data || '').toString().trim();
            if (ip && ip.includes(':')) {
                cachedPublicIpv6 = ip;
                ipv6LastFetch = Date.now();
                return ip;
            }
        } catch (e) { }
    }

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv6' && !iface.internal && !iface.address.startsWith('fe80')) {
                return iface.address;
            }
        }
    }

    return 'Not available';
}

// ============ ASYNC STARTUP ============
async function startServer() {
    // Initialize database (sql.js requires async init)
    await db.init();
    console.log('💾 Database initialized (sql.js)');

    // Now require modules that depend on database
    const botEngine = require('./bot/engine');
    const deltaApi = require('./bot/delta-api');
    const strategyManager = require('./bot/strategies');
    const riskManager = require('./bot/risk-manager');
    const learning = require('./bot/learning');
    try { strategyManager.setActiveStrategy(db.getSetting('active_strategy', 'multi-ai')); } catch (_) { strategyManager.setActiveStrategy('multi-ai'); }

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { cors: { origin: '*' } });

    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // Connect Socket.IO to bot engine
    botEngine.setIO(io);

    // ============ REST API ============

    // --- Health Check (for Render/monitoring) ---
    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
    });

    // --- Bot Control ---
    app.post('/api/bot/start', async (req, res) => {
        try {
            if (req.body?.confirmLiveTrading !== true) return res.status(400).json({ success: false, error: 'Explicit live trading acknowledgement required.' });
            await botEngine.start();
            res.json({ success: botEngine.running, status: botEngine.getStatus(), error: botEngine.running ? undefined : 'Bot did not start; check logs and settings.' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/bot/stop', (req, res) => {
        botEngine.stop();
        res.json({ success: true, status: botEngine.getStatus() });
    });

    app.get('/api/bot/status', (req, res) => {
        res.json(botEngine.getStatus());
    });

    // Paper learning never places exchange orders.
    app.get('/api/learning', (req, res) => res.json(learning.status()));
    app.post('/api/learning/start', (req, res) => { learning.start(); res.json(learning.status()); });
    app.post('/api/learning/stop', (req, res) => { learning.stop(); res.json(learning.status()); });
    app.post('/api/learning/:action', (req, res) => {
        try { learning.update(req.body.ids, req.params.action); if (req.params.action === 'implement') learning.start(); res.json(learning.status()); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Manual position refresh — reconcile DB with Delta Exchange
    app.post('/api/bot/refresh-positions', async (req, res) => {
        try {
            const result = await botEngine.refreshPositions();
            res.json(result);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // --- Dashboard Data ---
    app.get('/api/dashboard', async (req, res) => {
        try {
            const stats = db.getTradeStats();
            const dailyStats = db.getTodayStats();
            const settings = riskManager.getSettings();
            const openTrades = db.getOpenTrades();

            let balanceAvailable = false;
            let balance = { available: 0, balance: 0, walletBalance: 0, totalBalance: 0, marginUsed: 0, locked: 0, unrealizedPnl: 0 };
            try {
                const apiKey = db.getEncryptedSetting('api_key');
                const apiSecret = db.getEncryptedSetting('api_secret');
                if (apiKey && apiSecret) {
                    deltaApi.setCredentials(apiKey, apiSecret);
                    balance = await deltaApi.getBalance(settings.currency);
                    balanceAvailable = true;
                }
            } catch (e) { }

            // Fetch exchange rates
            let exchangeRates = deltaApi.getExchangeRates();
            try { exchangeRates = await deltaApi.fetchExchangeRate(); } catch (e) { }

            const budgetInfo = riskManager.getBudgetInfo(balance.walletBalance || balance.available);

            res.json({
                balance,
                balanceAvailable,
                stats,
                dailyStats,
                budgetInfo,
                openTrades,
                exchangeRates,
                settings: {
                    minBalance: settings.minBalance,
                    minPrice: settings.minPrice,
                    maxPrice: settings.maxPrice,
                    currency: settings.currency
                },
                botStatus: botEngine.getStatus()
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- Exchange Rate ---
    app.get('/api/exchange-rate', async (req, res) => {
        try {
            const rates = await deltaApi.fetchExchangeRate();
            res.json(rates);
        } catch (error) {
            res.json({ USD_INR: 94 });
        }
    });

    // --- Strategies ---
    app.get('/api/strategies', (req, res) => {
        res.json(strategyManager.getAllStrategies());
    });

    app.post('/api/strategies/select', (req, res) => {
        try {
            const { strategyId } = req.body;
            const info = strategyManager.setActiveStrategy(strategyId);
            db.setSetting('active_strategy', strategyId);
            io.emit('bot:strategy', info);
            res.json({ success: true, strategy: info });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // --- Market Data (PUBLIC - no auth needed) ---
    app.get('/api/market/tickers', async (req, res) => {
        try {
            // Tickers are PUBLIC — no API key needed
            const tickers = await deltaApi.getTickers();
            let products = [];
            try { products = await deltaApi.getProducts(); } catch (e) { }

            const enriched = tickers.map(t => {
                const product = products.find(p => p.symbol === t.symbol);
                const price = parseFloat(t.mark_price || t.close || 0);
                const open = parseFloat(t.open || 0);
                const high = parseFloat(t.high || 0);
                const low = parseFloat(t.low || 0);
                const close = parseFloat(t.close || 0);

                return {
                    symbol: t.symbol,
                    price,
                    open,
                    high,
                    low,
                    close,
                    volume: parseFloat(t.volume || 0),
                    turnover: parseFloat(t.turnover || 0),
                    change24h: open > 0 ? ((close - open) / open) * 100 : 0,
                    product_id: product?.id,
                    contract_type: product?.contract_type,
                    description: product?.description,
                    quoting_asset: product?.quoting_asset?.symbol,
                    settling_asset: product?.settling_asset?.symbol,
                    // For 52-week high/low approximation
                    nearHigh: high > 0 ? ((price / high) * 100).toFixed(1) : 0,
                    nearLow: low > 0 ? ((price / low) * 100).toFixed(1) : 0
                };
            }).filter(t => t.price > 0);

            res.json(enriched);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- Trades ---
    app.get('/api/trades', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        const trades = db.getTradeHistory(limit);
        const stats = db.getTradeStats();
        res.json({ trades, stats });
    });

    app.delete('/api/trades/history', (req, res) => {
        db.clearTradeHistory();
        res.json({ success: true, message: 'Trade history cleared' });
    });

    // --- Logs ---
    app.get('/api/logs', (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        const logs = db.getLogs(limit);
        res.json(logs);
    });

    app.delete('/api/logs', (req, res) => {
        db.clearLogs();
        res.json({ success: true });
    });

    // --- Settings ---
    app.get('/api/settings', async (req, res) => {
        const settings = db.getAllSettings();
        const strategies = strategyManager.getAllStrategies();

        const ipv6 = await getPublicIPv6();

        const apiKey = db.getEncryptedSetting('api_key');
        const hasApi = !!apiKey;

        // Get exchange rate
        let exchangeRates = deltaApi.getExchangeRates();
        try { exchangeRates = await deltaApi.fetchExchangeRate(); } catch (e) { }

        res.json({
            ...settings,
            ipv6,
            exchangeRates,
            apiConnected: hasApi,
            botVersion: config.bot.version,
            strategyCount: strategies.length,
            strategies
        });
    });

    app.post('/api/settings', (req, res) => {
        const { key, value } = req.body;
        const encryptedKeys = ['api_key', 'api_secret'];

        if (encryptedKeys.includes(key)) {
            db.setEncryptedSetting(key, value);
        } else {
            db.setSetting(key, value.toString());
        }

        res.json({ success: true });
    });

    app.post('/api/settings/bulk', (req, res) => {
        const settings = req.body;
        const encryptedKeys = ['api_key', 'api_secret'];

        for (const [key, value] of Object.entries(settings)) {
            if (value === undefined || value === null) continue;
            if (encryptedKeys.includes(key) && value !== '••••••••') {
                const trimmed = value.toString().trim();
                db.setEncryptedSetting(key, trimmed);
            } else if (!encryptedKeys.includes(key)) {
                db.setSetting(key, value.toString());
            }
        }

        res.json({ success: true });
    });

    app.post('/api/settings/test-connection', async (req, res) => {
        try {
            const apiKey = db.getEncryptedSetting('api_key');
            const apiSecret = db.getEncryptedSetting('api_secret');

            if (!apiKey || !apiSecret) {
                return res.json({ connected: false, error: 'API credentials not configured. Please save your API Key and Secret first.' });
            }

            deltaApi.setCredentials(apiKey, apiSecret);
            const result = await deltaApi.testConnection();
            res.json(result);
        } catch (error) {
            res.json({ connected: false, error: error.message });
        }
    });

    // --- Balance for Settings Page ---
    app.get('/api/balance', async (req, res) => {
        try {
            const apiKey = db.getEncryptedSetting('api_key');
            const apiSecret = db.getEncryptedSetting('api_secret');
            if (!apiKey || !apiSecret) {
                return res.json({ available: 0, balance: 0, walletBalance: 0, locked: 0, unrealizedPnl: 0, assetSymbol: '' });
            }
            deltaApi.setCredentials(apiKey, apiSecret);
            const currency = req.query.currency || db.getSetting('currency', 'INR');
            const balance = await deltaApi.getBalance(currency);
            const budgetInfo = riskManager.getBudgetInfo(balance.walletBalance || balance.available);

            // Get exchange rate
            let exchangeRates = deltaApi.getExchangeRates();
            try { exchangeRates = await deltaApi.fetchExchangeRate(); } catch (e) { }

            res.json({ ...balance, budgetInfo, exchangeRates });
        } catch (error) {
            res.json({ available: 0, balance: 0, walletBalance: 0, locked: 0, unrealizedPnl: 0, assetSymbol: '', error: error.message });
        }
    });

    // --- Save All Settings ---
    app.post('/api/settings/save-all', (req, res) => {
        const settings = req.body;
        const encryptedKeys = ['api_key', 'api_secret'];
        let saved = 0;

        for (const [key, value] of Object.entries(settings)) {
            if (value === undefined || value === null || value === '') continue;
            if (encryptedKeys.includes(key) && value !== '••••••••') {
                const trimmed = value.toString().trim();
                db.setEncryptedSetting(key, trimmed);
                saved++;
            } else if (!encryptedKeys.includes(key)) {
                db.setSetting(key, value.toString());
                saved++;
            }
        }

        res.json({ success: true, saved });
    });

    // --- System Info ---
    app.get('/api/system/ipv6', async (req, res) => {
        const ipv6 = await getPublicIPv6();
        res.json({ ipv6 });
    });

    // Fallback to index.html for SPA
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // ============ WebSocket ============
    io.on('connection', (socket) => {
        console.log('🔌 Client connected:', socket.id);

        socket.emit('bot:status', botEngine.getStatus());

        const logs = db.getLogs(20);
        socket.emit('bot:logs', logs);

        socket.on('disconnect', () => {
            console.log('🔌 Client disconnected:', socket.id);
        });
    });

    // ============ Start Server ============
    const PORT = process.env.PORT || config.server.port || 3000;
    const HOST = config.server.host || '0.0.0.0';

    server.listen(PORT, HOST, () => {
        console.log('');
        console.log('  ╔══════════════════════════════════════════╗');
        console.log('  ║                                          ║');
        console.log('  ║   🤖 CryptoBOT Delta v2.0.0              ║');
        console.log('  ║   Delta Exchange India Trading Bot        ║');
        console.log('  ║                                          ║');
        console.log(`  ║   🌐 http://localhost:${PORT}               ║`);
        console.log('  ║                                          ║');
        console.log('  ╚══════════════════════════════════════════╝');
        console.log('');
        console.log(`  📊 Strategies: ${strategyManager.getCount()}`);
        console.log(`  💾 Database: Ready (sql.js)`);
        console.log(`  🔌 WebSocket: Ready`);
        console.log(`  ☁️  Cloud: ${process.env.RENDER ? 'Render.com' : 'Local'}`);
        console.log('');
    });

    // ============ Self-Pinger (keeps Render free tier awake) ============
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
        console.log(`  🏓 Self-pinger active: ${RENDER_URL}`);
        setInterval(async () => {
            try {
                await axios.get(`${RENDER_URL}/api/health`, { timeout: 10000 });
                console.log('🏓 Self-ping OK');
            } catch (e) {
                console.log('🏓 Self-ping failed (will retry)');
            }
        }, 14 * 60 * 1000); // Every 14 minutes (Render sleeps at 15 min)
    }

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🛑 Shutting down...');
        botEngine.stop();
        db.close();
        server.close();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        botEngine.stop();
        db.close();
        server.close();
        process.exit(0);
    });
}

// ============ LAUNCH ============
startServer().catch(err => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
});
