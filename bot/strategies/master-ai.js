const { RSI } = require('technicalindicators');

// Three RSI periods on the same 5-minute candles; funding is a decimal rate.
class MasterAI {
    constructor(multi) { this.multi = multi; this.id = 'master-ai'; this.name = 'Master AI'; }
    getInfo() { return { id: this.id, name: this.name, description: 'Multi AI consensus filtered by 7, 14 and 28 period RSI and funding rate.', winRate: 'N/A', timeframe: '5m', riskLevel: 'High', subStrategies: this.multi.strategies.length }; }
    analyze(data) {
        const base = this.multi.analyze(data);
        if (base.signal === 'none') return base;
        const closes = data.closes || [];
        const rsis = [7, 14, 28].map(period => RSI.calculate({ values: closes, period }).at(-1));
        const funding = data.fundingRate;
        if (rsis.some(v => !Number.isFinite(v)) || !Number.isFinite(funding))
            return { ...base, signal: 'none', reason: 'Master AI requires all three RSI layers and a current funding rate.' };
        // Avoid chasing an overextended move or paying unusually high funding.
        const allowed = base.signal === 'buy' ? rsis.every(v => v < 70) && funding <= 0.001 : rsis.every(v => v > 30) && funding >= -0.001;
        if (!allowed) return { ...base, signal: 'none', reason: `Master AI blocked ${base.signal}: RSI ${rsis.map(v => v.toFixed(1)).join('/')} funding ${funding}.` };
        return { ...base, reason: `${base.reason} | Master AI RSI ${rsis.map(v => v.toFixed(1)).join('/')} funding ${funding}`, rsiLayers: rsis, fundingRate: funding };
    }
}
module.exports = MasterAI;
