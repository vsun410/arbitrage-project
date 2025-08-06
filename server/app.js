// 김프 아비트라지 서버 v3.1 - Vultr Cloud 최적화 버전
// 업데이트: 거래 제어, 포지션 설정, 전략 설정 기능 추가
// 작성일: 2025-08-06 v3.1

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const axios = require('axios');
require('dotenv').config();

// ============================================================================
// 설정 및 전역 변수
// ============================================================================

const CONFIG = {
    port: process.env.PORT || 8080,
    upbit: {
        accessKey: process.env.UPBIT_ACCESS_KEY,
        secretKey: process.env.UPBIT_SECRET_KEY
    },
    binance: {
        apiKey: process.env.BINANCE_API_KEY,
        secretKey: process.env.BINANCE_SECRET_KEY
    },
    discord: {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL
    },
    trading: {
        enabled: false,
        dryRun: process.env.DRY_RUN !== 'false',
        positionSize: parseInt(process.env.POSITION_SIZE) || 100000,
        strategy: {
            zScoreThreshold: parseFloat(process.env.Z_SCORE_THRESHOLD) || 2.0,
            minProfitRate: parseFloat(process.env.MIN_PROFIT_RATE) || 0.4
        }
    },
    symbols: ['BTC', 'ETH', 'XRP'],
    updateInterval: 15000, // 15초
    exchangeRateInterval: 5 * 60 * 1000 // 5분
};

// 전역 상태 관리
const globalState = {
    marketData: {},
    usdKrwRate: 1380,
    lastDataUpdate: null,
    isCollecting: true,
    trading: {
        enabled: false,
        positions: {},
        stats: {
            totalTrades: 0,
            successfulTrades: 0,
            totalProfit: 0,
            averageProfit: 0,
            winRate: 0
        }
    },
    server: {
        startTime: Date.now(),
        requestCount: 0,
        errorCount: 0
    }
};

// 로그 시스템
const logLevels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLogLevel = logLevels.INFO;

function log(message, level = 'INFO') {
    if (logLevels[level] <= currentLogLevel) {
        const timestamp = new Date().toLocaleTimeString('ko-KR', { 
            hour12: false, 
            timeZone: 'Asia/Seoul' 
        });
        console.log(`[${timestamp}] ${level}: ${message}`);
    }
}

// ============================================================================
// Discord 알림 시스템
// ============================================================================

async function sendDiscordNotification(options) {
    if (!CONFIG.discord.webhookUrl) return false;
    
    try {
        const payload = {
            embeds: [{
                title: options.title || '김프 아비트라지 알림',
                description: options.description || '',
                color: options.color || 0x00ff00,
                timestamp: new Date().toISOString(),
                fields: options.fields || [],
                footer: {
                    text: 'Vultr Cloud Server | 김프 아비트라지 v3.1'
                }
            }]
        };

        const response = await axios.post(CONFIG.discord.webhookUrl, payload, {
            timeout: 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        return response.status === 204;
    } catch (error) {
        log(`Discord 알림 실패: ${error.message}`, 'WARN');
        return false;
    }
}

// ============================================================================
// 환율 및 시장 데이터 수집
// ============================================================================

async function fetchUsdKrwRate() {
    try {
        const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', {
            timeout: 5000
        });
        
        if (response.data && response.data.rates && response.data.rates.KRW) {
            globalState.usdKrwRate = response.data.rates.KRW;
            log(`환율 업데이트: ${globalState.usdKrwRate.toFixed(2)} KRW/USD`, 'INFO');
            return true;
        }
    } catch (error) {
        log(`환율 조회 실패: ${error.message}`, 'WARN');
    }
    return false;
}

async function fetchMarketData() {
    if (!globalState.isCollecting) return;

    try {
        const binance = new ccxt.binance({
            apiKey: CONFIG.binance.apiKey,
            secret: CONFIG.binance.secretKey,
            sandbox: false,
            timeout: 10000
        });

        const promises = CONFIG.symbols.map(async (symbol) => {
            try {
                // 업비트 KRW 가격 조회
                const upbitResponse = await axios.get(
                    `https://api.upbit.com/v1/ticker?markets=KRW-${symbol}`, 
                    { timeout: 5000 }
                );
                const upbitPrice = upbitResponse.data[0]?.trade_price;

                // 바이낸스 USDT 가격 조회
                const binanceTicker = await binance.fetchTicker(`${symbol}/USDT`);
                const binancePrice = binanceTicker.last;

                if (upbitPrice && binancePrice && globalState.usdKrwRate) {
                    // 김프 계산
                    const binancePriceKrw = binancePrice * globalState.usdKrwRate;
                    const kimp = ((upbitPrice - binancePriceKrw) / binancePriceKrw);

                    return {
                        symbol,
                        timestamp: new Date().toISOString(),
                        upbitPrice,
                        binancePrice,
                        usdKrw: globalState.usdKrwRate,
                        kimp: kimp
                    };
                }
            } catch (error) {
                log(`${symbol} 데이터 수집 실패: ${error.message}`, 'WARN');
            }
            return null;
        });

        const results = await Promise.all(promises);
        const validResults = results.filter(r => r !== null);

        if (validResults.length > 0) {
            validResults.forEach(data => {
                globalState.marketData[data.symbol] = data;
            });
            globalState.lastDataUpdate = new Date().toISOString();
            
            // 거래 신호 확인
            if (CONFIG.trading.enabled) {
                checkTradingSignals();
            }
        }

    } catch (error) {
        globalState.server.errorCount++;
        log(`시장 데이터 수집 실패: ${error.message}`, 'ERROR');
    }
}

// ============================================================================
// 거래 신호 및 실행 시스템
// ============================================================================

function checkTradingSignals() {
    if (!CONFIG.trading.enabled) return;

    Object.values(globalState.marketData).forEach(data => {
        if (!data || !data.kimp) return;

        const { symbol, kimp } = data;
        const threshold = CONFIG.trading.strategy.zScoreThreshold / 100; // 백분율로 변환
        
        // 극단값 진입 신호 확인
        if (Math.abs(kimp) > threshold) {
            const signal = kimp > 0 ? 'BUY_UPBIT_SELL_BINANCE' : 'BUY_BINANCE_SELL_UPBIT';
            executeTrade(symbol, signal, data);
        }
    });
}

async function executeTrade(symbol, signal, marketData) {
    if (!CONFIG.trading.enabled) return;

    try {
        const tradeInfo = {
            symbol,
            signal,
            timestamp: new Date().toISOString(),
            marketData,
            positionSize: CONFIG.trading.positionSize,
            dryRun: CONFIG.trading.dryRun
        };

        if (CONFIG.trading.dryRun) {
            // 모의거래 실행
            await executeSimulatedTrade(tradeInfo);
        } else {
            // 실제거래 실행 (추후 구현)
            log(`실제거래 실행: ${symbol} ${signal}`, 'INFO');
        }

        // 거래 통계 업데이트
        globalState.trading.stats.totalTrades++;
        
        // Discord 알림
        await sendDiscordNotification({
            title: `${CONFIG.trading.dryRun ? '모의' : '실제'}거래 신호`,
            description: `**${symbol}** ${signal}`,
            color: CONFIG.trading.dryRun ? 0x0099ff : 0xff9900,
            fields: [
                { name: '김프', value: `${(marketData.kimp * 100).toFixed(2)}%`, inline: true },
                { name: '포지션 크기', value: `${CONFIG.trading.positionSize.toLocaleString()}원`, inline: true },
                { name: '모드', value: CONFIG.trading.dryRun ? '모의거래' : '실거래', inline: true }
            ]
        });

    } catch (error) {
        log(`거래 실행 실패: ${error.message}`, 'ERROR');
    }
}

async function executeSimulatedTrade(tradeInfo) {
    const { symbol, signal, marketData, positionSize } = tradeInfo;
    
    // 시뮬레이션된 수익 계산
    const profitRate = Math.abs(marketData.kimp);
    const simulatedProfit = positionSize * profitRate;
    
    // 통계 업데이트
    globalState.trading.stats.totalProfit += simulatedProfit;
    globalState.trading.stats.successfulTrades++;
    globalState.trading.stats.averageProfit = globalState.trading.stats.totalProfit / globalState.trading.stats.totalTrades;
    globalState.trading.stats.winRate = (globalState.trading.stats.successfulTrades / globalState.trading.stats.totalTrades) * 100;

    log(`모의거래 완료: ${symbol} 예상수익 ${simulatedProfit.toFixed(0)}원 (${(profitRate * 100).toFixed(2)}%)`, 'INFO');
}

// ============================================================================
// API 핸들러 시스템
// ============================================================================

const apiHandlers = {
    // 거래 제어 API
    async toggleTrading(req, res) {
        try {
            CONFIG.trading.enabled = !CONFIG.trading.enabled;
            globalState.trading.enabled = CONFIG.trading.enabled;
            
            const status = CONFIG.trading.enabled ? '시작됨' : '중지됨';
            log(`자동매매 ${status}`, 'INFO');
            
            // Discord 알림
            await sendDiscordNotification({
                title: '자동매매 상태 변경',
                description: `자동매매가 **${status}**되었습니다.`,
                color: CONFIG.trading.enabled ? 0x00ff00 : 0xff0000
            });
            
            res.json({
                success: true,
                enabled: CONFIG.trading.enabled,
                message: `자동매매가 ${status}되었습니다.`
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    },

    async toggleDryRun(req, res) {
        try {
            CONFIG.trading.dryRun = !CONFIG.trading.dryRun;
            
            const mode = CONFIG.trading.dryRun ? '모의거래' : '실거래';
            log(`거래 모드 변경: ${mode}`, 'INFO');
            
            // .env 파일 업데이트
            updateEnvVariable('DRY_RUN', CONFIG.trading.dryRun.toString());
            
            res.json({
                success: true,
                dryRun: CONFIG.trading.dryRun,
                message: `${mode} 모드로 변경되었습니다.`,
                warning: !CONFIG.trading.dryRun ? '⚠️ 실거래 모드입니다. 실제 자금이 사용됩니다!' : null
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    },

    async setPositionSize(req, res) {
        try {
            const { positionSize } = req.body;
            const size = parseInt(positionSize);
            
            if (isNaN(size) || size < 10000 || size > 10000000) {
                return res.json({
                    success: false,
                    error: '포지션 크기는 1만원에서 1천만원 사이여야 합니다.'
                });
            }
            
            CONFIG.trading.positionSize = size;
            updateEnvVariable('POSITION_SIZE', size.toString());
            
            log(`포지션 크기 변경: ${size.toLocaleString()}원`, 'INFO');
            
            res.json({
                success: true,
                positionSize: size,
                message: `포지션 크기가 ${size.toLocaleString()}원으로 설정되었습니다.`
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    },

    async setStrategy(req, res) {
        try {
            const { zScoreThreshold, minProfitRate } = req.body;
            
            const zScore = parseFloat(zScoreThreshold);
            const minProfit = parseFloat(minProfitRate);
            
            if (isNaN(zScore) || zScore < 1.0 || zScore > 5.0) {
                return res.json({
                    success: false,
                    error: 'Z-Score 임계값은 1.0에서 5.0 사이여야 합니다.'
                });
            }
            
            if (isNaN(minProfit) || minProfit < 0.1 || minProfit > 5.0) {
                return res.json({
                    success: false,
                    error: '최소 수익률은 0.1%에서 5.0% 사이여야 합니다.'
                });
            }
            
            CONFIG.trading.strategy.zScoreThreshold = zScore;
            CONFIG.trading.strategy.minProfitRate = minProfit;
            
            updateEnvVariable('Z_SCORE_THRESHOLD', zScore.toString());
            updateEnvVariable('MIN_PROFIT_RATE', minProfit.toString());
            
            log(`전략 설정 변경: Z-Score ±${zScore}, 최소수익률 ${minProfit}%`, 'INFO');
            
            res.json({
                success: true,
                strategy: CONFIG.trading.strategy,
                message: '전략 설정이 업데이트되었습니다.'
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    },

    async getTradingConfig(req, res) {
        try {
            res.json({
                success: true,
                config: {
                    enabled: CONFIG.trading.enabled,
                    dryRun: CONFIG.trading.dryRun,
                    positionSize: CONFIG.trading.positionSize,
                    strategy: CONFIG.trading.strategy
                },
                stats: globalState.trading.stats,
                marketData: globalState.marketData
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    },

    // 기존 API들
    async getMarketData(req, res) {
        const data = {
            timestamp: globalState.lastDataUpdate,
            data: globalState.marketData,
            usdKrwRate: globalState.usdKrwRate,
            dataAge: globalState.lastDataUpdate ? 
                Math.floor((Date.now() - new Date(globalState.lastDataUpdate).getTime()) / 1000) : null
        };
        res.json(data);
    },

    async getSystemStatus(req, res) {
        const uptime = Math.floor((Date.now() - globalState.server.startTime) / 1000);
        const memUsage = process.memoryUsage();
        
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime,
            memory: {
                used: Math.round(memUsage.heapUsed / 1024 / 1024),
                total: Math.round(memUsage.heapTotal / 1024 / 1024)
            },
            trading: {
                enabled: CONFIG.trading.enabled,
                dryRun: CONFIG.trading.dryRun,
                stats: globalState.trading.stats
            },
            dataCollection: globalState.isCollecting,
            lastUpdate: globalState.lastDataUpdate
        });
    },

    async getStats(req, res) {
        const uptime = Math.floor((Date.now() - globalState.server.startTime) / 1000);
        res.json({
            uptime,
            requestCount: globalState.server.requestCount,
            errorCount: globalState.server.errorCount,
            memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            tradingStats: globalState.trading.stats,
            isCollecting: globalState.isCollecting
        });
    }
};

// ============================================================================
// .env 파일 업데이트 함수
// ============================================================================

function updateEnvVariable(key, value) {
    try {
        const envPath = path.join(__dirname, '..', '.env');
        let envContent = '';
        
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        const lines = envContent.split('\n');
        const keyIndex = lines.findIndex(line => line.startsWith(`${key}=`));
        
        if (keyIndex !== -1) {
            lines[keyIndex] = `${key}=${value}`;
        } else {
            lines.push(`${key}=${value}`);
        }
        
        fs.writeFileSync(envPath, lines.join('\n'));
        return true;
    } catch (error) {
        log(`환경변수 업데이트 실패: ${error.message}`, 'ERROR');
        return false;
    }
}

// ============================================================================
// 관리자 패널 HTML 생성
// ============================================================================

function generateAdminPanel() {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>김프 아비트라지 관리자 패널 v3.1 | Vultr Cloud</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333; min-height: 100vh; padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { 
            background: rgba(255,255,255,0.95); border-radius: 15px;
            padding: 30px; margin-bottom: 30px; text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        .header h1 { color: #667eea; font-size: 2.5em; margin-bottom: 10px; }
        .header p { color: #666; font-size: 1.2em; }
        .vultr-badge { 
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white; padding: 4px 12px; border-radius: 12px;
            font-size: 0.9em; margin-left: 10px; animation: pulse 2s infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        
        .tabs {
            display: flex; background: rgba(255,255,255,0.95); border-radius: 15px;
            margin-bottom: 20px; padding: 10px; box-shadow: 0 5px 20px rgba(0,0,0,0.1);
            flex-wrap: wrap; gap: 5px;
        }
        .tab-button {
            flex: 1; padding: 15px 10px; background: none; border: none;
            border-radius: 10px; cursor: pointer; font-weight: 600;
            transition: all 0.3s ease; color: #666; font-size: 14px;
            min-width: 120px;
        }
        .tab-button.active {
            background: #667eea; color: white;
            box-shadow: 0 5px 15px rgba(102,126,234,0.3);
        }
        .tab-button:hover:not(.active) {
            background: rgba(102,126,234,0.1); color: #667eea;
        }
        
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; }
        .card {
            background: rgba(255,255,255,0.95); border-radius: 15px; padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1); backdrop-filter: blur(10px);
        }
        .card h2 { color: #667eea; margin-bottom: 20px; font-size: 1.5em; }
        .card h3 { color: #555; margin-bottom: 15px; font-size: 1.2em; }
        
        .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
        .status-item { 
            background: rgba(102,126,234,0.05); border-radius: 10px; padding: 15px;
            border-left: 4px solid #667eea;
        }
        .status-label { display: block; color: #666; font-size: 0.9em; margin-bottom: 5px; }
        .status-value { display: block; color: #333; font-weight: 600; font-size: 1.1em; }
        .status-success { color: #28a745; }
        .status-warning { color: #ffc107; }
        .status-danger { color: #dc3545; }
        
        .form-group { margin: 15px 0; }
        .input-group { margin-bottom: 15px; }
        .input-label { display: block; color: #555; font-weight: 600; margin-bottom: 8px; }
        .input-field {
            width: 100%; padding: 12px; border: 2px solid #e1e5e9;
            border-radius: 8px; font-size: 14px; transition: border-color 0.3s;
        }
        .input-field:focus { border-color: #667eea; outline: none; }
        .input-help { color: #666; font-size: 0.85em; margin-top: 5px; }
        
        .btn { 
            padding: 12px 24px; border: none; border-radius: 8px; 
            font-weight: 600; cursor: pointer; transition: all 0.3s;
            font-size: 14px; min-width: 120px;
        }
        .btn-primary { background: #667eea; color: white; }
        .btn-primary:hover { background: #5a6fd8; transform: translateY(-2px); }
        .btn-success { background: #28a745; color: white; }
        .btn-success:hover { background: #218838; }
        .btn-warning { background: #ffc107; color: #333; }
        .btn-warning:hover { background: #e0a800; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-danger:hover { background: #c82333; }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #5a6268; }
        
        .alert {
            padding: 15px; border-radius: 8px; margin: 15px 0;
            border-left: 4px solid #667eea;
        }
        .alert-success { background: rgba(40, 167, 69, 0.1); border-left-color: #28a745; color: #155724; }
        .alert-error { background: rgba(220, 53, 69, 0.1); border-left-color: #dc3545; color: #721c24; }
        .alert-warning { background: rgba(255, 193, 7, 0.1); border-left-color: #ffc107; color: #856404; }
        .alert-info { background: rgba(102, 126, 234, 0.1); border-left-color: #667eea; color: #004085; }
        
        .flex-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .flex-col { display: flex; flex-direction: column; gap: 10px; }
        
        .trading-status { 
            padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 0.9em;
            display: inline-block; margin: 5px 0;
        }
        .trading-enabled { background: #d4edda; color: #155724; }
        .trading-disabled { background: #f8d7da; color: #721c24; }
        .dry-run { background: #cce7ff; color: #004085; }
        .real-trading { background: #fff3cd; color: #856404; }
        
        @media (max-width: 768px) {
            .header h1 { font-size: 1.8em; }
            .tabs { flex-direction: column; }
            .tab-button { min-width: auto; }
            .grid { grid-template-columns: 1fr; }
            .flex-row { flex-direction: column; align-items: stretch; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 김프 아비트라지 관리자 v3.1</h1>
            <p>Vultr Cloud 서버 관리 시스템<span class="vultr-badge">LIVE</span></p>
        </div>
        
        <div class="tabs">
            <button class="tab-button active" onclick="showTab('overview')">📊 개요</button>
            <button class="tab-button" onclick="showTab('apikeys')">🔑 API키</button>
            <button class="tab-button" onclick="showTab('domain')">🌐 도메인</button>
            <button class="tab-button" onclick="showTab('server')">🔄 서버</button>
            <button class="tab-button" onclick="showTab('control')">🎮 제어</button>
            <button class="tab-button" onclick="showTab('logs')">📋 로그</button>
        </div>
        
        <!-- 제어 탭 (v3.1 업데이트) -->
        <div id="control" class="tab-content">
            <div class="grid">
                <!-- 거래 제어 카드 -->
                <div class="card">
                    <h2>🎮 거래 제어</h2>
                    <div class="status-grid">
                        <div class="status-item">
                            <span class="status-label">자동매매 상태</span>
                            <span class="status-value" id="trading-status">확인 중...</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">거래 모드</span>
                            <span class="status-value" id="dry-run-status">확인 중...</span>
                        </div>
                    </div>
                    
                    <div class="flex-row">
                        <button id="toggle-trading-btn" class="btn btn-primary" onclick="toggleTrading()">
                            자동매매 시작
                        </button>
                        <button id="toggle-dry-run-btn" class="btn btn-secondary" onclick="toggleDryRun()">
                            실거래 전환
                        </button>
                    </div>
                    <div id="trading-alert"></div>
                </div>
                
                <!-- 포지션 설정 카드 -->
                <div class="card">
                    <h2>💰 포지션 크기 설정</h2>
                    <div class="form-group">
                        <label class="input-label">거래 금액 (원)</label>
                        <div class="flex-row">
                            <input type="number" id="position-size-input" class="input-field" 
                                   placeholder="100000" min="10000" max="10000000" style="flex: 1;">
                            <button class="btn btn-success" onclick="setPositionSize()">저장</button>
                        </div>
                        <div class="input-help">최소 1만원, 최대 1천만원까지 설정 가능</div>
                    </div>
                    
                    <div class="status-item">
                        <span class="status-label">현재 포지션 크기</span>
                        <span class="status-value" id="current-position-size">확인 중...</span>
                    </div>
                    <div id="position-alert"></div>
                </div>
                
                <!-- 전략 설정 카드 -->
                <div class="card">
                    <h2>⚙️ 전략 설정</h2>
                    <div class="form-group">
                        <label class="input-label">Z-Score 임계값 (±)</label>
                        <div class="flex-row">
                            <input type="number" id="z-score-input" class="input-field" 
                                   placeholder="2.0" min="1.0" max="5.0" step="0.1" style="flex: 1;">
                            <span style="margin: 0 10px;">%</span>
                        </div>
                        <div class="input-help">1.0% ~ 5.0% 범위에서 설정 (기본값: 2.0%)</div>
                    </div>
                    
                    <div class="form-group">
                        <label class="input-label">최소 수익률 (%)</label>
                        <div class="flex-row">
                            <input type="number" id="min-profit-input" class="input-field" 
                                   placeholder="0.4" min="0.1" max="5.0" step="0.1" style="flex: 1;">
                            <span style="margin: 0 10px;">%</span>
                        </div>
                        <div class="input-help">0.1% ~ 5.0% 범위에서 설정 (기본값: 0.4%)</div>
                    </div>
                    
                    <button class="btn btn-primary" onclick="setStrategy()">전략 설정 저장</button>
                    <div id="strategy-alert"></div>
                </div>
                
                <!-- 시스템 모니터링 카드 -->
                <div class="card">
                    <h2>📊 시스템 모니터링</h2>
                    <div class="flex-row">
                        <button class="btn btn-secondary" onclick="loadSystemInfo()">설정 정보보기</button>
                        <button class="btn btn-secondary" onclick="loadDetailedStats()">상세 통계보기</button>
                    </div>
                    <div id="system-info"></div>
                </div>
            </div>
        </div>
        
        <!-- 다른 탭들은 기존과 동일 (생략) -->
        <div id="overview" class="tab-content active">
            <div class="grid">
                <div class="card">
                    <h2>📊 시스템 상태</h2>
                    <div id="system-status">
                        <div class="status-grid">
                            <div class="status-item">
                                <span class="status-label">서버 상태</span>
                                <span class="status-value status-success">정상 운영</span>
                            </div>
                            <div class="status-item">
                                <span class="status-label">데이터 수집</span>
                                <span class="status-value status-success">활성</span>
                            </div>
                            <div class="status-item">
                                <span class="status-label">마지막 업데이트</span>
                                <span class="status-value" id="last-update">로딩 중...</span>
                            </div>
                            <div class="status-item">
                                <span class="status-label">API 요청 수</span>
                                <span class="status-value" id="api-requests">0</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <h2>💰 김프 현황</h2>
                    <div id="kimp-status">
                        <div class="status-grid">
                            <div class="status-item">
                                <span class="status-label">BTC 김프</span>
                                <span class="status-value" id="btc-kimp">로딩 중...</span>
                            </div>
                            <div class="status-item">
                                <span class="status-label">ETH 김프</span>
                                <span class="status-value" id="eth-kimp">로딩 중...</span>
                            </div>
                            <div class="status-item">
                                <span class="status-label">XRP 김프</span>
                                <span class="status-value" id="xrp-kimp">로딩 중...</span>
                            </div>
                            <div class="status-item">
                                <span class="status-label">USD/KRW</span>
                                <span class="status-value" id="exchange-rate">로딩 중...</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- API 키 관리 탭 -->
        <div id="apikeys" class="tab-content">
            <div class="grid">
                <div class="card">
                    <h2>🔑 업비트 API 키</h2>
                    <div class="form-group">
                        <label class="input-label">Access Key</label>
                        <input type="password" id="upbit-access-key" class="input-field" placeholder="업비트 Access Key">
                        <div class="input-help">업비트에서 발급받은 Access Key를 입력하세요</div>
                    </div>
                    <div class="form-group">
                        <label class="input-label">Secret Key</label>
                        <input type="password" id="upbit-secret-key" class="input-field" placeholder="업비트 Secret Key">
                        <div class="input-help">업비트에서 발급받은 Secret Key를 입력하세요</div>
                    </div>
                    <div class="flex-row">
                        <button onclick="saveUpbitKeys()" class="btn btn-primary">저장</button>
                        <button onclick="testUpbitConnection()" class="btn btn-secondary">연결 테스트</button>
                    </div>
                    <div id="upbit-status"></div>
                </div>
                <div class="card">
                    <h2>🔄 바이낸스 API 키</h2>
                    <div class="form-group">
                        <label class="input-label">API Key</label>
                        <input type="password" id="binance-api-key" class="input-field" placeholder="바이낸스 API Key">
                        <div class="input-help">바이낸스에서 발급받은 API Key를 입력하세요</div>
                    </div>
                    <div class="form-group">
                        <label class="input-label">Secret Key</label>
                        <input type="password" id="binance-secret-key" class="input-field" placeholder="바이낸스 Secret Key">
                        <div class="input-help">바이낸스에서 발급받은 Secret Key를 입력하세요</div>
                    </div>
                    <div class="flex-row">
                        <button onclick="saveBinanceKeys()" class="btn btn-primary">저장</button>
                        <button onclick="testBinanceConnection()" class="btn btn-secondary">연결 테스트</button>
                    </div>
                    <div id="binance-status"></div>
                </div>
            </div>
        </div>

        <!-- 도메인 관리 탭 -->
        <div id="domain" class="tab-content">
            <div class="grid">
                <div class="card">
                    <h2>🌐 도메인 상태</h2>
                    <div class="status-grid">
                        <div class="status-item">
                            <span class="status-label">현재 도메인</span>
                            <span class="status-value" id="current-domain">vsun410.pe.kr</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">DNS 상태</span>
                            <span class="status-value status-success">정상</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">Nginx 상태</span>
                            <span class="status-value status-success">활성</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">SSL 상태</span>
                            <span class="status-value">비활성</span>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <h2>📋 도메인 설정 가이드</h2>
                    <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; font-size: 13px; line-height: 1.6;">
                        <p><strong>현재 도메인:</strong> vsun410.pe.kr</p>
                        <p><strong>서버 IP:</strong> 141.164.55.221</p>
                        <p><strong>접속 URL:</strong></p>
                        <ul style="margin: 10px 0 10px 20px;">
                            <li>http://vsun410.pe.kr - 메인 대시보드</li>
                            <li>http://vsun410.pe.kr/admin - 관리자 패널</li>
                            <li>http://141.164.55.221:8080 - 직접 접속</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>

        <!-- 서버 관리 탭 -->
        <div id="server" class="tab-content">
            <div class="grid">
                <div class="card">
                    <h2>🔄 서버 제어</h2>
                    <div class="form-group">
                        <button onclick="restartServer()" class="btn btn-warning" style="width: 100%; margin-bottom: 10px;">
                            🔄 서버 재시작
                        </button>
                        <button onclick="refreshConfig()" class="btn btn-primary" style="width: 100%; margin-bottom: 10px;">
                            ⚡ 설정 새로고침
                        </button>
                        <button onclick="updateFromGithub()" class="btn btn-success" style="width: 100%;">
                            📥 GitHub 업데이트
                        </button>
                    </div>
                    <div id="server-status"></div>
                </div>
                <div class="card">
                    <h2>📊 서버 정보</h2>
                    <div class="status-grid">
                        <div class="status-item">
                            <span class="status-label">서버 시간</span>
                            <span class="status-value" id="server-time">로딩 중...</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">업타임</span>
                            <span class="status-value" id="uptime">로딩 중...</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">메모리 사용</span>
                            <span class="status-value" id="memory-usage">로딩 중...</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">버전</span>
                            <span class="status-value">v3.1</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 로그 탭 -->
        <div id="logs" class="tab-content">
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h2>📋 시스템 로그</h2>
                    <div>
                        <button onclick="clearLogs()" class="btn btn-warning">로그 지우기</button>
                        <button onclick="refreshLogs()" class="btn btn-primary">새로고침</button>
                    </div>
                </div>
                <div id="admin-logs" style="background: #f8f9fa; border-radius: 8px; padding: 15px; max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 13px; line-height: 1.4;">
                    <div class="log-entry">시스템 로그가 여기에 표시됩니다...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let tradingConfig = {};
        let adminLogs = [];
        
        // 페이지 로드 시 거래 설정 로드
        document.addEventListener('DOMContentLoaded', function() {
            loadTradingConfig();
            loadSystemStatus();
            updateRealTimeData();
            // 30초마다 실시간 데이터 업데이트
            setInterval(updateRealTimeData, 30000);
        });
        
        // 실시간 데이터 업데이트
        async function updateRealTimeData() {
            try {
                const response = await fetch('/api/market-data');
                const data = await response.json();
                
                if (data.success) {
                    // 김프 현황 업데이트
                    if (data.BTC) {
                        document.getElementById('btc-kimp').textContent = '+' + data.BTC.premium.toFixed(2) + '%';
                        document.getElementById('btc-kimp').className = 'status-value ' + getKimpStatusClass(data.BTC.premium);
                    }
                    if (data.ETH) {
                        document.getElementById('eth-kimp').textContent = '+' + data.ETH.premium.toFixed(2) + '%';
                        document.getElementById('eth-kimp').className = 'status-value ' + getKimpStatusClass(data.ETH.premium);
                    }
                    if (data.XRP) {
                        document.getElementById('xrp-kimp').textContent = '+' + data.XRP.premium.toFixed(2) + '%';
                        document.getElementById('xrp-kimp').className = 'status-value ' + getKimpStatusClass(data.XRP.premium);
                    }
                    
                    // 환율 업데이트
                    if (data.exchangeRate) {
                        document.getElementById('exchange-rate').textContent = data.exchangeRate.toFixed(2) + ' KRW/USD';
                    }
                    
                    // 마지막 업데이트 시간
                    document.getElementById('last-update').textContent = new Date().toLocaleString('ko-KR');
                }
            } catch (error) {
                console.error('실시간 데이터 업데이트 실패:', error);
            }
        }
        
        // 김프 상태에 따른 클래스 반환
        function getKimpStatusClass(premium) {
            if (premium > 3) return 'status-danger';
            if (premium > 1.5) return 'status-warning';
            return 'status-success';
        }
        
        // 시스템 상태 로드
        async function loadSystemStatus() {
            try {
                const response = await fetch('/api/system-status');
                const data = await response.json();
                
                if (data.success) {
                    document.getElementById('api-requests').textContent = data.stats?.requestCount || '0';
                    document.getElementById('server-time').textContent = new Date().toLocaleString('ko-KR');
                    document.getElementById('uptime').textContent = data.uptime || '알 수 없음';
                    
                    const memUsage = data.stats?.memoryUsage;
                    if (memUsage) {
                        document.getElementById('memory-usage').textContent = (memUsage.used / 1024 / 1024).toFixed(1) + 'MB';
                    }
                }
            } catch (error) {
                console.error('시스템 상태 로드 실패:', error);
            }
        }
        
        // API 키 관리 함수들
        async function saveUpbitKeys() {
            const accessKey = document.getElementById('upbit-access-key').value.trim();
            const secretKey = document.getElementById('upbit-secret-key').value.trim();
            
            if (!accessKey || !secretKey) {
                showAlert('upbit-status', '모든 필드를 입력해주세요.', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/save-upbit-keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accessKey, secretKey })
                });
                
                const result = await response.json();
                if (result.success) {
                    showAlert('upbit-status', '✅ 업비트 API 키가 저장되었습니다.', 'success');
                    addAdminLog('업비트 API 키 저장 완료');
                    
                    // 입력 필드 초기화
                    document.getElementById('upbit-access-key').value = '';
                    document.getElementById('upbit-secret-key').value = '';
                } else {
                    showAlert('upbit-status', '❌ 저장 실패: ' + result.error, 'error');
                }
            } catch (error) {
                showAlert('upbit-status', '오류 발생: ' + error.message, 'error');
            }
        }
        
        async function saveBinanceKeys() {
            const apiKey = document.getElementById('binance-api-key').value.trim();
            const secretKey = document.getElementById('binance-secret-key').value.trim();
            
            if (!apiKey || !secretKey) {
                showAlert('binance-status', '모든 필드를 입력해주세요.', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/save-binance-keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey, secretKey })
                });
                
                const result = await response.json();
                if (result.success) {
                    showAlert('binance-status', '✅ 바이낸스 API 키가 저장되었습니다.', 'success');
                    addAdminLog('바이낸스 API 키 저장 완료');
                    
                    // 입력 필드 초기화
                    document.getElementById('binance-api-key').value = '';
                    document.getElementById('binance-secret-key').value = '';
                } else {
                    showAlert('binance-status', '❌ 저장 실패: ' + result.error, 'error');
                }
            } catch (error) {
                showAlert('binance-status', '오류 발생: ' + error.message, 'error');
            }
        }
        
        // API 연결 테스트 함수들
        async function testUpbitConnection() {
            showAlert('upbit-status', '⏳ 업비트 연결을 테스트하고 있습니다...', 'info');
            
            try {
                const response = await fetch('/api/test-upbit-connection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                if (result.success) {
                    showAlert('upbit-status', '✅ 업비트 연결 성공! 계정: ' + (result.data?.account || '확인됨'), 'success');
                } else {
                    showAlert('upbit-status', '❌ 업비트 연결 실패: ' + result.error, 'error');
                }
            } catch (error) {
                showAlert('upbit-status', '연결 테스트 중 오류 발생: ' + error.message, 'error');
            }
        }
        
        async function testBinanceConnection() {
            showAlert('binance-status', '⏳ 바이낸스 연결을 테스트하고 있습니다...', 'info');
            
            try {
                const response = await fetch('/api/test-binance-connection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                if (result.success) {
                    showAlert('binance-status', '✅ 바이낸스 연결 성공! 계정: ' + (result.data?.account || '확인됨'), 'success');
                } else {
                    showAlert('binance-status', '❌ 바이낸스 연결 실패: ' + result.error, 'error');
                }
            } catch (error) {
                showAlert('binance-status', '연결 테스트 중 오류 발생: ' + error.message, 'error');
            }
        }
        
        // 서버 관리 함수들
        async function restartServer() {
            if (!confirm('서버를 재시작하시겠습니까? 잠시 동안 서비스가 중단됩니다.')) return;
            
            showAlert('server-status', '🔄 서버를 재시작하고 있습니다...', 'info');
            addAdminLog('서버 재시작 요청');
            
            try {
                const response = await fetch('/api/restart-server', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                showAlert('server-status', result.message || '서버 재시작이 요청되었습니다.', result.success ? 'success' : 'error');
                
                if (result.success) {
                    setTimeout(() => {
                        showAlert('server-status', '⏳ 서버 재시작 중... 30초 후 자동 새로고침됩니다.', 'info');
                        setTimeout(() => window.location.reload(), 30000);
                    }, 2000);
                }
            } catch (error) {
                showAlert('server-status', '서버 재시작 실패: ' + error.message, 'error');
            }
        }
        
        async function refreshConfig() {
            showAlert('server-status', '⚡ 설정을 새로고침하고 있습니다...', 'info');
            addAdminLog('설정 새로고침 요청');
            
            try {
                const response = await fetch('/api/refresh-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                showAlert('server-status', result.message || '설정이 새로고침되었습니다.', result.success ? 'success' : 'error');
                
                if (result.success) {
                    loadTradingConfig();
                    loadSystemStatus();
                }
            } catch (error) {
                showAlert('server-status', '설정 새로고침 실패: ' + error.message, 'error');
            }
        }
        
        async function updateFromGithub() {
            if (!confirm('GitHub에서 최신 코드를 가져와 업데이트하시겠습니까?')) return;
            
            showAlert('server-status', '📥 GitHub에서 업데이트를 가져오고 있습니다...', 'info');
            addAdminLog('GitHub 업데이트 요청');
            
            try {
                const response = await fetch('/api/github-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                showAlert('server-status', result.message || 'GitHub 업데이트가 완료되었습니다.', result.success ? 'success' : 'error');
                
                if (result.success) {
                    setTimeout(() => {
                        showAlert('server-status', '⏳ 서버 재시작 중... 잠시 후 새로고침됩니다.', 'info');
                        setTimeout(() => window.location.reload(), 15000);
                    }, 3000);
                }
            } catch (error) {
                showAlert('server-status', 'GitHub 업데이트 실패: ' + error.message, 'error');
            }
        }
        
        // 로그 관리 함수들
        function addAdminLog(message) {
            const timestamp = new Date().toLocaleString('ko-KR');
            const logEntry = '[' + timestamp + '] ' + message;
            adminLogs.push(logEntry);
            
            // 최대 100개 로그만 유지
            if (adminLogs.length > 100) {
                adminLogs = adminLogs.slice(-100);
            }
            
            updateLogDisplay();
        }
        
        function updateLogDisplay() {
            const logContainer = document.getElementById('admin-logs');
            if (logContainer && adminLogs.length > 0) {
                logContainer.innerHTML = adminLogs.map(log => 
                    '<div class="log-entry">' + log + '</div>'
                ).join('');
                logContainer.scrollTop = logContainer.scrollHeight;
            }
        }
        
        function clearLogs() {
            if (confirm('모든 로그를 지우시겠습니까?')) {
                adminLogs = [];
                updateLogDisplay();
                document.getElementById('admin-logs').innerHTML = '<div class="log-entry">로그가 지워졌습니다.</div>';
            }
        }
        
        function refreshLogs() {
            addAdminLog('로그 새로고침');
        }
        
        // 유틸리티 함수들
        function showAlert(elementId, message, type) {
            const element = document.getElementById(elementId);
            if (!element) return;
            
            const alertClass = type === 'success' ? 'alert-success' : 
                             type === 'error' ? 'alert-error' : 
                             type === 'warning' ? 'alert-warning' : 'alert-info';
            
            element.innerHTML = '<div class="alert ' + alertClass + '" style="margin-top: 15px;">' + message + '</div>';
            setTimeout(() => { element.innerHTML = ''; }, 8000);
        }
        
        function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.querySelectorAll('.tab-button').forEach(button => {
                button.classList.remove('active');
            });
            
            document.getElementById(tabName).classList.add('active');
            event.target.classList.add('active');
            
            if (tabName === 'control') {
                loadTradingConfig();
            }
        }
        
        // 거래 설정 로드
        async function loadTradingConfig() {
            try {
                const response = await fetch('/api/trading-config');
                const data = await response.json();
                
                if (data.success) {
                    tradingConfig = data.config;
                    updateUI();
                }
            } catch (error) {
                console.error('거래 설정 로드 실패:', error);
            }
        }
        
        // UI 업데이트
        function updateUI() {
            // 거래 상태 업데이트
            const tradingStatus = document.getElementById('trading-status');
            const tradingBtn = document.getElementById('toggle-trading-btn');
            
            if (tradingConfig.enabled) {
                tradingStatus.textContent = '실행 중';
                tradingStatus.className = 'status-value status-success';
                tradingBtn.textContent = '자동매매 중지';
                tradingBtn.className = 'btn btn-danger';
            } else {
                tradingStatus.textContent = '중지됨';
                tradingStatus.className = 'status-value status-danger';
                tradingBtn.textContent = '자동매매 시작';
                tradingBtn.className = 'btn btn-success';
            }
            
            // 모드 상태 업데이트
            const dryRunStatus = document.getElementById('dry-run-status');
            const dryRunBtn = document.getElementById('toggle-dry-run-btn');
            
            if (tradingConfig.dryRun) {
                dryRunStatus.textContent = '모의거래';
                dryRunStatus.className = 'status-value' + ' ' + 'dry-run';
                dryRunBtn.textContent = '실거래 전환';
                dryRunBtn.className = 'btn btn-warning';
            } else {
                dryRunStatus.textContent = '실거래';
                dryRunStatus.className = 'status-value' + ' ' + 'real-trading';
                dryRunBtn.textContent = '모의거래 전환';
                dryRunBtn.className = 'btn btn-secondary';
            }
            
            // 포지션 크기 업데이트
            const positionSize = document.getElementById('current-position-size');
            if (tradingConfig.positionSize) {
                positionSize.textContent = tradingConfig.positionSize.toLocaleString() + '원';
                document.getElementById('position-size-input').value = tradingConfig.positionSize;
            }
            
            // 전략 설정 업데이트
            if (tradingConfig.strategy) {
                document.getElementById('z-score-input').value = tradingConfig.strategy.zScoreThreshold;
                document.getElementById('min-profit-input').value = tradingConfig.strategy.minProfitRate;
            }
        }
        
        // 자동매매 토글
        async function toggleTrading() {
            try {
                const response = await fetch('/api/toggle-trading', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    showTradingAlert(result.message, 'success');
                    tradingConfig.enabled = result.enabled;
                    updateUI();
                } else {
                    showTradingAlert(result.error, 'error');
                }
            } catch (error) {
                showTradingAlert('자동매매 토글 실패: ' + error.message, 'error');
            }
        }
        
        // 모의거래/실거래 토글
        async function toggleDryRun() {
            if (!tradingConfig.dryRun && !confirm('⚠️ 실거래 모드로 전환하시겠습니까?\\n실제 자금이 사용됩니다!')) {
                return;
            }
            
            try {
                const response = await fetch('/api/toggle-dry-run', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    showTradingAlert(result.message + (result.warning ? '\\n' + result.warning : ''), 
                                   result.warning ? 'warning' : 'success');
                    tradingConfig.dryRun = result.dryRun;
                    updateUI();
                } else {
                    showTradingAlert(result.error, 'error');
                }
            } catch (error) {
                showTradingAlert('모드 전환 실패: ' + error.message, 'error');
            }
        }
        
        // 포지션 크기 설정
        async function setPositionSize() {
            try {
                const positionSize = document.getElementById('position-size-input').value;
                
                const response = await fetch('/api/set-position-size', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ positionSize })
                });
                const result = await response.json();
                
                if (result.success) {
                    showPositionAlert(result.message, 'success');
                    tradingConfig.positionSize = result.positionSize;
                    updateUI();
                } else {
                    showPositionAlert(result.error, 'error');
                }
            } catch (error) {
                showPositionAlert('포지션 설정 실패: ' + error.message, 'error');
            }
        }
        
        // 전략 설정
        async function setStrategy() {
            try {
                const zScoreThreshold = document.getElementById('z-score-input').value;
                const minProfitRate = document.getElementById('min-profit-input').value;
                
                const response = await fetch('/api/set-strategy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ zScoreThreshold, minProfitRate })
                });
                const result = await response.json();
                
                if (result.success) {
                    showStrategyAlert(result.message, 'success');
                    tradingConfig.strategy = result.strategy;
                } else {
                    showStrategyAlert(result.error, 'error');
                }
            } catch (error) {
                showStrategyAlert('전략 설정 실패: ' + error.message, 'error');
            }
        }
        
        // 알림 함수들
        function showTradingAlert(message, type) {
            showAlert('trading-alert', message, type);
        }
        
        function showPositionAlert(message, type) {
            showAlert('position-alert', message, type);
        }
        
        function showStrategyAlert(message, type) {
            showAlert('strategy-alert', message, type);
        }
        
        function showAlert(elementId, message, type) {
            const alertDiv = document.getElementById(elementId);
            const alertClass = type === 'success' ? 'alert-success' : 
                              type === 'error' ? 'alert-error' : 
                              type === 'warning' ? 'alert-warning' : 'alert-info';
            alertDiv.innerHTML = \`<div class="alert \${alertClass}">\${message}</div>\`;
            setTimeout(() => { alertDiv.innerHTML = ''; }, 5000);
        }
        
        // 기존 함수들
        async function loadSystemInfo() {
            const response = await fetch('/api/system-status');
            const data = await response.json();
            document.getElementById('system-info').innerHTML = \`<pre>\${JSON.stringify(data, null, 2)}</pre>\`;
        }
        
        async function loadDetailedStats() {
            const response = await fetch('/api/stats');
            const data = await response.json();
            document.getElementById('system-info').innerHTML = \`<pre>\${JSON.stringify(data, null, 2)}</pre>\`;
        }
    </script>
</body>
</html>`;
}

// ============================================================================
// HTTP 서버 및 라우팅
// ============================================================================

const server = http.createServer((req, res) => {
    globalState.server.requestCount++;
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // res.json 메서드 추가
    res.json = function(data) {
        this.writeHead(200, { 'Content-Type': 'application/json' });
        this.end(JSON.stringify(data));
    };
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // API 라우팅
    if (url.pathname.startsWith('/api/')) {
        handleApiRequest(req, res, url);
        return;
    }
    
    // 정적 파일 및 페이지 라우팅
    switch (url.pathname) {
        case '/':
        case '/admin':
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateAdminPanel());
            break;
            
        case '/health':
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: Math.floor((Date.now() - globalState.server.startTime) / 1000),
                version: '3.1.0'
            }));
            break;
            
        default:
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
    }
});

function handleApiRequest(req, res, url) {
    res.setHeader('Content-Type', 'application/json');
    
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            req.body = body ? JSON.parse(body) : {};
        } catch {
            req.body = {};
        }
        
        // API 엔드포인트 라우팅
        const endpoint = url.pathname.substring(5); // '/api/' 제거
        
        if (apiHandlers[endpoint]) {
            await apiHandlers[endpoint](req, res);
        } else {
            // 기존 API 엔드포인트들
            switch (endpoint) {
                case 'market-data':
                    await apiHandlers.getMarketData(req, res);
                    break;
                case 'system-status':
                    await apiHandlers.getSystemStatus(req, res);
                    break;
                case 'stats':
                    await apiHandlers.getStats(req, res);
                    break;
                case 'trading-config':
                    await apiHandlers.getTradingConfig(req, res);
                    break;
                case 'toggle-trading':
                    await apiHandlers.toggleTrading(req, res);
                    break;
                case 'toggle-dry-run':
                    await apiHandlers.toggleDryRun(req, res);
                    break;
                case 'set-position-size':
                    await apiHandlers.setPositionSize(req, res);
                    break;
                case 'set-strategy':
                    await apiHandlers.setStrategy(req, res);
                    break;
                default:
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'API endpoint not found' }));
            }
        }
    });
}

// ============================================================================
// 서버 시작 및 초기화
// ============================================================================

async function startServer() {
    try {
        // Discord 시작 알림
        await sendDiscordNotification({
            title: '🚀 김프 아비트라지 서버 v3.1 시작',
            description: '**Vultr Cloud** 서버가 성공적으로 시작되었습니다.',
            color: 0x00ff00,
            fields: [
                { name: '서버 포트', value: CONFIG.port.toString(), inline: true },
                { name: '거래 모드', value: CONFIG.trading.dryRun ? '모의거래' : '실거래', inline: true },
                { name: '대상 종목', value: CONFIG.symbols.join(', '), inline: true },
                { name: '업데이트 간격', value: `${CONFIG.updateInterval/1000}초`, inline: true }
            ]
        });

        // 환율 초기 조회
        await fetchUsdKrwRate();
        
        // 데이터 수집 시작
        fetchMarketData();
        setInterval(fetchMarketData, CONFIG.updateInterval);
        setInterval(fetchUsdKrwRate, CONFIG.exchangeRateInterval);
        
        // 서버 시작
        server.listen(CONFIG.port, () => {
            log(`♦ Vultr ♦ ♦ ♦ ♦ ♦ ♦ ♦ ♦ ♦ ♦`, 'INFO');
            log(`♦ ♦ ♦ ♦ ♦ [${CONFIG.symbols.join(', ')}] / ♦ ♦ ♦ ♦ ♦ ${CONFIG.updateInterval/1000}♦`, 'INFO');
            log(`♦ ♦ ♦ : ${globalState.usdKrwRate} KRW/USD`, 'INFO');
            log(`서버가 포트 ${CONFIG.port}에서 실행 중입니다.`, 'INFO');
        });

    } catch (error) {
        log(`서버 시작 실패: ${error.message}`, 'ERROR');
        process.exit(1);
    }
}

// 프로세스 종료 처리
process.on('SIGINT', async () => {
    log('서버 종료 신호 수신...', 'INFO');
    
    await sendDiscordNotification({
        title: '⏹️ 김프 아비트라지 서버 종료',
        description: '서버가 안전하게 종료되었습니다.',
        color: 0xff0000
    });
    
    process.exit(0);
});

process.on('uncaughtException', async (error) => {
    log(`처리되지 않은 예외: ${error.message}`, 'ERROR');
    
    await sendDiscordNotification({
        title: '❌ 서버 오류',
        description: `처리되지 않은 예외가 발생했습니다: ${error.message}`,
        color: 0xff0000
    });
});

// 서버 시작
startServer();