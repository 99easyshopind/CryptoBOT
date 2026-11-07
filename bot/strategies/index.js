/**
 * Strategy Manager - Loads and manages all 20 trading strategies
 * v2.1: Added Order Flow, Multi-TF Momentum, Wyckoff, Volume Profile, Elliott Wave
 */
const RSIReversalStrategy = require('./rsi-reversal');
const EMACrossoverStrategy = require('./ema-crossover');
const MACDMomentumStrategy = require('./macd-momentum');
const BollingerBreakoutStrategy = require('./bollinger-breakout');
const VWAPStrategy = require('./vwap-strategy');
const ScalpingStrategy = require('./scalping');
const SmartMoneyStrategy = require('./smart-money');
const IchimokuStrategy = require('./ichimoku');
const SupertrendStrategy = require('./supertrend');
const FibonacciStrategy = require('./fibonacci');
const ADXTrendStrategy = require('./adx-trend');
const StochasticRSIStrategy = require('./stochastic-rsi');
const MeanReversionStrategy = require('./mean-reversion');
const BreakoutVolumeStrategy = require('./breakout-volume');
// New advanced strategies
const OrderFlowStrategy = require('./order-flow');
const MultiTFMomentumStrategy = require('./multi-tf-momentum');
const WyckoffStrategy = require('./wyckoff');
const VolumeProfileStrategy = require('./volume-profile');
const ElliottWaveStrategy = require('./elliott-wave');
// Multi AI (must be loaded last — uses all other strategies)
const MultiAIStrategy = require('./multi-ai');
const MasterAI = require('./master-ai');

class StrategyManager {
    constructor() {
        this.strategies = new Map();
        this.activeStrategy = null;
        this.loadStrategies();
    }

    loadStrategies() {
        const rsi = new RSIReversalStrategy();
        const ema = new EMACrossoverStrategy();
        const macd = new MACDMomentumStrategy();
        const bollinger = new BollingerBreakoutStrategy();
        const vwap = new VWAPStrategy();
        const scalping = new ScalpingStrategy();
        const smartMoney = new SmartMoneyStrategy();
        const ichimoku = new IchimokuStrategy();
        const supertrend = new SupertrendStrategy();
        const fibonacci = new FibonacciStrategy();
        const adxTrend = new ADXTrendStrategy();
        const stochRsi = new StochasticRSIStrategy();
        const meanReversion = new MeanReversionStrategy();
        const breakoutVolume = new BreakoutVolumeStrategy();
        // New advanced strategies
        const orderFlow = new OrderFlowStrategy();
        const multiTF = new MultiTFMomentumStrategy();
        const wyckoff = new WyckoffStrategy();
        const volumeProfile = new VolumeProfileStrategy();
        const elliottWave = new ElliottWaveStrategy();

        // Register all strategies
        this.strategies.set(rsi.id, rsi);
        this.strategies.set(ema.id, ema);
        this.strategies.set(macd.id, macd);
        this.strategies.set(bollinger.id, bollinger);
        this.strategies.set(vwap.id, vwap);
        this.strategies.set(scalping.id, scalping);
        this.strategies.set(smartMoney.id, smartMoney);
        this.strategies.set(ichimoku.id, ichimoku);
        this.strategies.set(supertrend.id, supertrend);
        this.strategies.set(fibonacci.id, fibonacci);
        this.strategies.set(adxTrend.id, adxTrend);
        this.strategies.set(stochRsi.id, stochRsi);
        this.strategies.set(meanReversion.id, meanReversion);
        this.strategies.set(breakoutVolume.id, breakoutVolume);
        // Register new strategies
        this.strategies.set(orderFlow.id, orderFlow);
        this.strategies.set(multiTF.id, multiTF);
        this.strategies.set(wyckoff.id, wyckoff);
        this.strategies.set(volumeProfile.id, volumeProfile);
        this.strategies.set(elliottWave.id, elliottWave);

        // Multi AI strategy (combine ALL 19 strategies)
        const allStrategies = [rsi, ema, macd, bollinger, vwap, scalping, smartMoney, ichimoku,
            supertrend, fibonacci, adxTrend, stochRsi, meanReversion, breakoutVolume,
            orderFlow, multiTF, wyckoff, volumeProfile, elliottWave];
        const multiAI = new MultiAIStrategy(allStrategies);
        this.strategies.set(multiAI.id, multiAI);
        this.strategies.set('master-ai', new MasterAI(multiAI));

        // Default to Multi AI
        this.activeStrategy = multiAI;
    }

    getStrategy(id) {
        return this.strategies.get(id) || null;
    }

    setActiveStrategy(id) {
        const strategy = this.strategies.get(id);
        if (!strategy) throw new Error(`Strategy '${id}' not found`);
        this.activeStrategy = strategy;
        return strategy.getInfo();
    }

    getActiveStrategy() {
        return this.activeStrategy;
    }

    getAllStrategies() {
        const list = [];
        for (const [id, strategy] of this.strategies) {
            list.push({
                ...strategy.getInfo(),
                active: this.activeStrategy && this.activeStrategy.id === id
            });
        }
        return list;
    }

    analyze(marketData) {
        if (!this.activeStrategy) {
            throw new Error('No active strategy selected');
        }
        return this.activeStrategy.analyze(marketData);
    }

    getCount() {
        return this.strategies.size;
    }
}

module.exports = new StrategyManager();
