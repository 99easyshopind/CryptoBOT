const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

test('workspace keeps the original dashboard, market, trading and settings controls', () => {
    const required = ['btnBotToggle','apiStatus','statBalance','statPnl','statWinRate','statTradeCount','statTotalTrades','statMinBalance','statPriceRange','strategyList','activeStrategyBadge','logContainer','marketSearch','marketTabs','marketList','tradesSummary','tradeTotal','tradeWins','tradeLosses','tradeWinRate','tradePnl','tradeList','btnClearHistory','settingApiKey','settingApiSecret','settingApiStatus','settingCurrency','settingBudget','settingMinBalance','settingMinPrice','settingMaxPrice','settingStopLoss','settingProfit','settingMaxDailyTrades','settingMaxDailyLoss','settingMaxPositions','settingQtyMode','manualQtyRow','settingManualQty','settingLeverage','settingCooldown','syncDeltaCount','syncDeltaPositions','syncOpenCount','syncTradesList','syncBalanceInfo','syncBalanceDetails','syncLastRefresh','settingAutoRefresh','btnRefreshPositions','syncResult','infoBotVersion','infoStrategyCount','infoApiStatus','infoIpv6','btnCopyIpv6','learningStatus','learningList','paperTrades'];
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    for (const id of required) assert.ok(ids.includes(id), `missing ${id}`);
    assert.equal(new Set(ids).size, ids.length, 'duplicate element IDs');
    for (const page of ['dashboard','market','strategies','learning','trades','settings']) {
        assert.ok(ids.includes(`page-${page}`));
        assert.match(html, new RegExp(`data-page="${page}"`));
    }
    for (const handler of ['App.toggleBot()', 'Dashboard.clearLogs()', 'Trades.exportCSV()', 'Trades.clearHistory()', 'Settings.saveApi()', 'Settings.testConnection()', 'Settings.saveAllSettings()', 'Settings.refreshPositions()', "LearningUI.action('start')", "LearningUI.action('stop')", "LearningUI.update('implement', false)", "LearningUI.update('implement', true)", "LearningUI.update('delete', false)"])
        assert.ok(html.includes(handler), `missing ${handler}`);
});
