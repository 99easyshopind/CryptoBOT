const test = require('node:test');
const assert = require('node:assert/strict');
const MasterAI = require('../bot/strategies/master-ai');
const manager = require('../bot/strategies');
const db = require('../database');
const api = require('../bot/delta-api');
const learning = require('../bot/learning');
const engine = require('../bot/engine');
const risk = require('../bot/risk-manager');

test('Master AI preserves Multi AI votes and fails closed on missing or adverse RSI/funding', () => {
    let signal = 'buy';
    const master = new MasterAI({ strategies: [1, 2], analyze: () => ({ signal, confidence: 70, details: ['vote'] }) });
    const closes = Array.from({length: 50}, (_, i) => 100 + Math.sin(i) * 2);
    assert.equal(master.analyze({closes}).signal, 'none');
    assert.equal(master.analyze({closes: [1, 2], fundingRate: 0}).signal, 'none');
    assert.equal(master.analyze({closes, fundingRate: 0.002}).signal, 'none');
    const result = master.analyze({closes, fundingRate: 0});
    assert.equal(result.signal, 'buy'); assert.deepEqual(result.details, ['vote']); assert.equal(result.rsiLayers.length, 3);
    signal = 'sell'; assert.equal(master.analyze({closes, fundingRate: -0.002}).signal, 'none');
    assert.equal(master.analyze({closes, fundingRate: 0}).signal, 'sell');
    signal = 'none'; assert.equal(master.analyze({}).signal, 'none');
    assert.ok(manager.getStrategy('master-ai'));
});

test('paper observes blocked and retained signals, audits removal and never places an order', async (t) => {
    let store = '{}'; let price = 100; let confidence = 60;
    t.mock.method(db, 'getSetting', () => store);
    t.mock.method(db, 'setSetting', (_, v) => { store = v; });
    t.mock.method(db, 'getTradeHistory', () => [{id: 12, status: 'closed', pnl: -2, side: 'buy', symbol: 'BTCUSD', strategy: 'Test', notes: '{"confidence":60}'}]);
    t.mock.method(api, 'getTickerBySymbol', async () => ({ mark_price: price, funding_rate: 0 }));
    t.mock.method(api, 'getCandles', async () => Array.from({ length: 50 }, (_, i) => ({time: Math.floor(Date.now() / 1000) - (49 - i) * 300, close:100, open:100, high:101, low:99, volume:1})));
    t.mock.method(api, 'placeOrder', () => { throw Error('paper must not place orders'); });
    t.mock.method(api, 'placeBracketOrder', () => { throw Error('paper must not place orders'); });
    t.mock.method(manager, 'getActiveStrategy', () => ({ id: 'test', name: 'Test', analyze: () => ({signal:'buy', confidence}) }));
    learning.running = true; learning.generation = 5;
    await learning.tick(5);
    let state = learning.status(); assert.equal(state.learnings.length, 1); assert.equal(state.learnings[0].source, 'real'); assert.ok(state.open);
    learning.update(['real-12'], 'implement');
    const context = {symbol:'BTCUSD', strategy:'test', strategyName:'Test'};
    assert.equal(learning.blocks({signal:'buy', confidence:60}, context), true);
    assert.equal(learning.blocks({signal:'buy', confidence:60}, {...context, symbol:'ETHUSD'}), false);
    let raw = JSON.parse(store); raw.open.openedAt -= 300001; store = JSON.stringify(raw); price = 99;
    await learning.tick(5); state = learning.status(); assert.equal(state.trades.length, 1); assert.equal(state.learnings.length, 2); assert.equal(state.open.blocked, true);
    raw = JSON.parse(store); raw.open.openedAt -= 300001; store = JSON.stringify(raw); price = 101; confidence = 80;
    await learning.tick(5); state = learning.status();
    let result = state.learnings.find(x => x.id === 'real-12').verification;
    assert.equal(result.length, 1); assert.equal(result[0].blockedByRule, true); assert.ok(result[0].pnlPercent > 0);
    raw = JSON.parse(store); raw.open.openedAt -= 300001; store = JSON.stringify(raw); price = 102;
    await learning.tick(5); state = learning.status(); result = state.learnings.find(x => x.id === 'real-12').verification;
    assert.equal(result.length, 2); assert.equal(result[1].blockedByAny, false);
    learning.update(['real-12'], 'delete'); assert.equal(learning.blocks({signal:'buy', confidence:60}, context), false);
    const rule = learning.status().learnings.find(x => x.id === 'real-12');
    assert.equal(rule.implemented, false); assert.deepEqual(rule.history.map(x => x.action), ['implemented','removed']); assert.equal(rule.verification.length, 2);
    assert.throws(() => learning.update(['real-12'], 'delete')); assert.throws(() => learning.update(['missing'], 'implement'));
    learning.stop(); const before = store; await learning.tick(5); assert.equal(store, before);
});

test('stopping during market fetch prevents post-stop paper mutation', async (t) => {
    let store = '{}'; let resolveTicker;
    t.mock.method(db, 'getSetting', () => store); t.mock.method(db, 'setSetting', (_, v) => { store = v; });
    t.mock.method(db, 'getTradeHistory', () => []);
    t.mock.method(api, 'getTickerBySymbol', () => new Promise(resolve => { resolveTicker = resolve; }));
    t.mock.method(api, 'getCandles', async () => []);
    learning.running = true; learning.generation = 9;
    const pending = learning.tick(9); const before = store;
    learning.stop(); resolveTicker({mark_price: 100}); await pending;
    assert.equal(store, before);
});

test('real outcomes are collected even when market data is unavailable', async (t) => {
    let store = '{}';
    t.mock.method(db, 'getSetting', () => store); t.mock.method(db, 'setSetting', (_, v) => { store = v; });
    t.mock.method(db, 'getTradeHistory', () => [{ id: 7, status: 'closed', pnl: -5, side: 'sell', symbol: 'ETHUSD', strategy: 'Test', notes: '{"confidence":65}' }]);
    t.mock.method(api, 'getTickerBySymbol', async () => { throw Error('market unavailable'); });
    learning.running = true; learning.generation = 11;
    await assert.rejects(learning.tick(11), /market unavailable/);
    assert.equal(learning.status().learnings[0].source, 'real'); learning.stop();
});

test('a stopped and restarted live session cannot submit an old in-flight entry', async (t) => {
    t.mock.method(risk, 'getSettings', () => ({currency:'USD', leverage:2, profitPercent:2, stopLossPercent:1}));
    t.mock.method(risk, 'calculateQuantity', () => 1);
    t.mock.method(risk, 'calculateExitPrices', () => ({stopLoss:90, takeProfit:110}));
    let resume; t.mock.method(api, 'setLeverage', () => new Promise(resolve => { resume = resolve; }));
    let orders = 0; t.mock.method(api, 'placeBracketOrder', async () => { orders++; return {}; });
    t.mock.method(engine, 'log', () => {});
    engine.products = [{symbol:'BTCUSD', id:1}]; engine.running = true; engine.startGeneration = 20;
    const pending = engine.executeTrade('BTCUSD', {side:'buy', signal:'buy', confidence:70, reason:'test'}, 100, {available:100}, {}, 'Test', {}, {bid:99, ask:101, closes:[], fetchedAt:'now'}, 20);
    engine.stop(); engine.running = true; engine.startGeneration++; resume();
    assert.equal(await pending, false); assert.equal(orders, 0); engine.running = false;
});
