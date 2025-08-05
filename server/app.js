const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Vultr 클라우드 최적화된 김프 아비트라지 서버 v2.1
 * 
 * 특징:
 * - 메모리 사용량 최소화 (1GB 서버 최적화)
 * - API 호출 효율화 및 에러 처리
 * - 자동 정리 및 로그 관리
 * - 실시간 김프 모니터링
 * - 완전한 관리자 패널 (POA-main 스타일)
 * - 실시간 제어 및 설정 변경
 * - 환경 변수 파일 자동 관리
 */

// 환경 설정
const CONFIG = {
    port: process.env.PORT || 8080,
    symbols: process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : ['BTC', 'ETH', 'XRP'],
    
    // 타이밍 설정
    dataCollectionInterval: parseInt(process.env.DATA_INTERVAL) || 15000,  // 15초
    exchangeRateUpdateInterval: parseInt(process.env.RATE_INTERVAL) || 60000, // 1분 (환율은 자주 업데이트)
    cleanupInterval: 3600000, // 1시간
    
    // 메모리 최적화
    maxDataPoints: 50,
    maxLogLines: 1000,
    
    // API 설정
    maxRetries: 3,
    requestTimeout: 5000,
    
    // Discord 알림 설정
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "https://discordapp.com/api/webhooks/1221348685519257671/SBJ67q6oZAyJELAw6wFcZA1R8VAvdpKQmi3ruDnknzYxdhHyXcXH3cmNsT4kJBul90i-",
    alertThresholds: {
        extremeKimp: 5.0,      // 5% 이상 김프 시 알림
        highMemory: 512,       // 512MB 이상 메모리 사용 시 알림
        errorCount: 10         // 10회 이상 에러 시 알림
    }
};

// 글로벌 상태 (메모리 효율적)
let globalState = {
    isRunning: false,
    startTime: null,
    usdKrwRate: 1384.29,
    
    // 실시간 데이터
    latestData: {},
    marketStates: {},
    
    // API 키 설정 (POA-main 스타일)
    apiKeys: {
        upbit: {
            key: process.env.UPBIT_ACCESS_KEY || '',
            secret: process.env.UPBIT_SECRET_KEY || '',
            connected: false,
            lastTest: null
        },
        binance: {
            key: process.env.BINANCE_API_KEY || '',
            secret: process.env.BINANCE_SECRET_KEY || '',
            connected: false,
            lastTest: null
        }
    },
    
    // 통계
    stats: {
        apiCalls: 0,
        dataPoints: 0,
        errors: 0,
        uptime: 0
    },
    
    // Discord 알림 제한 (스팸 방지)
    lastNotifications: {},
    lastDiscordTest: null,
    
    // 로그 (메모리 제한)
    logBuffer: []
};

// 최적화된 로깅 시스템
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString().substr(11, 8);
    const logLine = `[${timestamp}] ${level}: ${message}`;
    
    console.log(logLine);
    
    // 메모리 버퍼 관리
    globalState.logBuffer.push(logLine);
    if (globalState.logBuffer.length > CONFIG.maxLogLines) {
        globalState.logBuffer = globalState.logBuffer.slice(-CONFIG.maxLogLines / 2);
    }
    
    // Discord 알림 (ERROR 레벨일 때)
    if (level === 'ERROR' && CONFIG.discordWebhookUrl) {
        sendDiscordAlert('🚨 시스템 오류', message, 0xFF0000);
    }
}

// Discord 웹훅 알림 전송 (스마트 필터링)
async function sendDiscordAlert(title, description, color = 0x0099FF, fields = []) {
    if (!CONFIG.discordWebhookUrl) return;
    
    // 스마트 알림 필터링 (중요한 알림만)
    const importantKeywords = ['주문', '거래', '시스템 시작', '시스템 종료', '업비트', '바이낸스'];
    const isImportant = importantKeywords.some(keyword => title.includes(keyword) || description.includes(keyword));
    
    // 환율 관련 알림은 1시간에 1번만
    if (title.includes('환율') || description.includes('환율')) {
        const rateFailureKey = 'rate_failure_notification';
        const now = Date.now();
        const lastNotification = globalState.lastNotifications[rateFailureKey] || 0;
        const oneHour = 60 * 60 * 1000;
        
        if (now - lastNotification < oneHour) {
            log(`Discord 환율 알림 생략 (1시간 제한): ${title}`, 'INFO');
            return;
        }
        globalState.lastNotifications[rateFailureKey] = now;
    }
    
    // 중요하지 않은 알림은 로그만
    if (!isImportant) {
        log(`Discord 알림 (필터됨): ${title} - ${description}`, 'INFO');
        return;
    }
    
    try {
        const embed = {
            title: title,
            description: description,
            color: color,
            timestamp: new Date().toISOString(),
            fields: fields,
            footer: {
                text: "김프 아비트라지 모니터 | Vultr Cloud"
            }
        };
        
        const payload = {
            embeds: [embed]
        };
        
        const response = await fetch(CONFIG.discordWebhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            console.error('Discord 웹훅 전송 실패:', response.status, response.statusText);
        }
        
    } catch (error) {
        console.error('Discord 알림 오류:', error.message);
    }
}

// 극단적 김프 알림
async function checkExtremeKimp(symbol, kimp, upbitPrice, binancePrice) {
    if (Math.abs(kimp) >= CONFIG.alertThresholds.extremeKimp) {
        const title = `🚨 극단적 김프 발생: ${symbol}`;
        const description = `김치 프리미엄이 ${kimp > 0 ? '+' : ''}${kimp.toFixed(2)}%에 도달했습니다!`;
        const fields = [
            { name: '업비트 가격', value: `${upbitPrice.toLocaleString()}원`, inline: true },
            { name: '바이낸스 가격', value: `$${binancePrice.toFixed(2)}`, inline: true },
            { name: '김프', value: `${kimp > 0 ? '+' : ''}${kimp.toFixed(2)}%`, inline: true }
        ];
        
        await sendDiscordAlert(title, description, 0xFF4500, fields);
        log(`극단적 김프 알림 전송: ${symbol} ${kimp.toFixed(2)}%`);
    }
}

// 주문 완료 알림
async function sendOrderAlert(orderType, orderData) {
    const { symbol, side, quantity, price, exchange, timestamp, orderId } = orderData;
    
    const sideKorean = {
        'buy': '매수',
        'sell': '매도',
        'long': '롱 진입',
        'short': '숏 진입',
        'close_long': '롱 청산',
        'close_short': '숏 청산'
    };
    
    const exchangeKorean = {
        'upbit': '업비트',
        'binance': '바이낸스'
    };
    
    const color = side.includes('buy') || side.includes('long') ? 0x00FF00 : 0xFF0000;
    
    const title = `📈 주문 완료: ${symbol}`;
    const description = `${exchangeKorean[exchange] || exchange} ${sideKorean[side] || side} 주문이 체결되었습니다`;
    
    const fields = [
        { name: '종목', value: symbol, inline: true },
        { name: '거래소', value: exchangeKorean[exchange] || exchange, inline: true },
        { name: '구분', value: sideKorean[side] || side, inline: true },
        { name: '수량', value: quantity.toLocaleString(), inline: true },
        { name: '체결가', value: `${price.toLocaleString()}${exchange === 'upbit' ? '원' : ' USDT'}`, inline: true },
        { name: '총 금액', value: `${(quantity * price).toLocaleString()}${exchange === 'upbit' ? '원' : ' USDT'}`, inline: true },
        { name: '체결 시간', value: new Date(timestamp).toLocaleString('ko-KR'), inline: false },
        { name: '주문 ID', value: orderId || 'N/A', inline: false }
    ];
    
    await sendDiscordAlert(title, description, color, fields);
    log(`주문 완료 알림 전송: ${exchange} ${symbol} ${side} ${quantity}개`);
}

// 연결 실패 상세 알림
async function sendConnectionFailureAlert(type, error, details = {}) {
    const failureTypes = {
        'upbit_api': {
            title: '🔴 업비트 API 연결 실패',
            description: '업비트 거래소 API 연결에 문제가 발생했습니다',
            color: 0xFF0000
        },
        'binance_api': {
            title: '🟠 바이낸스 API 연결 실패', 
            description: '바이낸스 거래소 API 연결에 문제가 발생했습니다',
            color: 0xFF4500
        },
        'exchange_rate': {
            title: '🟡 환율 API 연결 실패',
            description: 'USD/KRW 환율 조회 API 연결에 문제가 발생했습니다',
            color: 0xFFA500
        },
        'order_execution': {
            title: '🚨 주문 실행 실패',
            description: '거래 주문 실행 중 오류가 발생했습니다',
            color: 0x8B0000
        },
        'balance_check': {
            title: '💰 잔고 조회 실패',
            description: '거래소 잔고 확인 중 오류가 발생했습니다',
            color: 0xFF6B35
        }
    };
    
    const alertInfo = failureTypes[type] || {
        title: '❌ 시스템 오류',
        description: '알 수 없는 오류가 발생했습니다',
        color: 0xFF0000
    };
    
    const fields = [
        { name: '오류 메시지', value: error.message || error.toString(), inline: false },
        { name: '발생 시간', value: new Date().toLocaleString('ko-KR'), inline: true },
        { name: '서버', value: 'Vultr Cloud', inline: true }
    ];
    
    // 추가 상세 정보 
    if (details.url) {
        fields.push({ name: 'API URL', value: details.url, inline: false });
    }
    if (details.statusCode) {
        fields.push({ name: 'HTTP 상태', value: details.statusCode.toString(), inline: true });
    }
    if (details.responseTime) {
        fields.push({ name: '응답 시간', value: `${details.responseTime}ms`, inline: true });
    }
    if (details.retryCount) {
        fields.push({ name: '재시도 횟수', value: details.retryCount.toString(), inline: true });
    }
    if (details.symbol) {
        fields.push({ name: '관련 종목', value: details.symbol, inline: true });
    }
    if (details.stackTrace) {
        // 스택 트레이스는 처음 3줄만 포함 (Discord 제한)
        const shortStack = details.stackTrace.split('\n').slice(0, 3).join('\n');
        fields.push({ name: '스택 트레이스', value: `\`\`\`${shortStack}\`\`\``, inline: false });
    }
    
    await sendDiscordAlert(alertInfo.title, alertInfo.description, alertInfo.color, fields);
    log(`연결 실패 알림 전송: ${type} - ${error.message}`);
}

// 시스템 상태 알림
async function sendSystemAlert(type, data) {
    const alerts = {
        startup: {
            title: '🚀 시스템 시작',
            description: '김프 아비트라지 모니터가 시작되었습니다',
            color: 0x00FF00,
            fields: [
                { name: '서버', value: 'Vultr Cloud', inline: true },
                { name: '포트', value: CONFIG.port.toString(), inline: true },
                { name: '심볼', value: CONFIG.symbols.join(', '), inline: true },
                { name: '시작 시간', value: new Date().toLocaleString('ko-KR'), inline: false }
            ]
        },
        shutdown: {
            title: '🛑 시스템 종료',
            description: '김프 아비트라지 모니터가 종료되었습니다',
            color: 0xFF4500,
            fields: [
                { name: '종료 시간', value: new Date().toLocaleString('ko-KR'), inline: true },
                { name: '총 가동시간', value: data.totalUptime || 'N/A', inline: true },
                { name: '처리된 주문', value: `${data.totalOrders || 0}건`, inline: true }
            ]
        },
        highMemory: {
            title: '⚠️ 메모리 사용량 경고',
            description: `메모리 사용량이 ${Math.round(data.memory)}MB에 도달했습니다`,
            color: 0xFFA500,
            fields: [
                { name: '현재 사용량', value: `${Math.round(data.memory)}MB`, inline: true },
                { name: '임계값', value: `${CONFIG.alertThresholds.highMemory}MB`, inline: true },
                { name: '사용률', value: `${((data.memory / CONFIG.alertThresholds.highMemory) * 100).toFixed(1)}%`, inline: true }
            ]
        },
        dailyReport: {
            title: '📊 일일 리포트',
            description: '김프 아비트라지 시스템 일일 요약',
            color: 0x0099FF,
            fields: [
                { name: 'API 호출', value: `${data.apiCalls}회`, inline: true },
                { name: '데이터 수집', value: `${data.dataPoints}개`, inline: true },
                { name: '오류', value: `${data.errors}회`, inline: true },
                { name: '가동시간', value: data.uptime, inline: true },
                { name: '메모리 평균', value: `${data.avgMemory}MB`, inline: true },
                { name: '성공률', value: `${data.successRate}%`, inline: true }
            ]
        }
    };
    
    const alert = alerts[type];
    if (alert) {
        await sendDiscordAlert(alert.title, alert.description, alert.color, alert.fields);
    }
}

// 김프 계산 (정확도 최적화)
function calculateKimp(upbitPrice, binancePrice, usdKrw) {
    const binanceKrw = binancePrice * usdKrw;
    return Number(((upbitPrice - binanceKrw) / binanceKrw * 100).toFixed(3));
}

// API 호출 최적화 (재시도 + 타임아웃)
async function fetchWithRetry(url, options = {}) {
    const { maxRetries = CONFIG.maxRetries, timeout = CONFIG.requestTimeout, silent = false } = options;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'KimpArbitrage/1.0'
                }
            });
            
            clearTimeout(timeoutId);
            
            if (response.ok) {
                globalState.stats.apiCalls++;
                const data = await response.json();
                return data;
            } else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
        } catch (error) {
            if (attempt === maxRetries) {
                globalState.stats.errors++;
                
                if (!silent) {
                    log(`API 호출 최종 실패 (${attempt}/${maxRetries}): ${url} - ${error.message}`, 'ERROR');
                    
                    // 중요한 API만 Discord 알림 (업비트, 바이낸스)
                    if (url.includes('upbit') || url.includes('binance')) {
                        const apiType = url.includes('upbit') ? 'upbit_api' : 'binance_api';
                        await sendConnectionFailureAlert(apiType, error, {
                            url: url,
                            retryCount: maxRetries,
                            stackTrace: error.stack
                        });
                    }
                } else {
                    log(`API 호출 최종 실패 (${attempt}/${maxRetries}): ${url} - ${error.message}`, 'WARN');
                }
                
                return null;
            }
            
            if (!silent) {
                log(`API 호출 재시도 (${attempt}/${maxRetries}): ${url} - ${error.message}`, 'WARN');
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
    
    return null;
}

// 업비트 가격 조회
async function fetchUpbitPrice(symbol) {
    const data = await fetchWithRetry(`https://api.upbit.com/v1/ticker?markets=KRW-${symbol}`);
    return data && Array.isArray(data) && data.length > 0 ? data[0].trade_price : null;
}

// 바이낸스 가격 조회 (개선된 버전)
async function fetchBinancePrice(symbol) {
    try {
        // 24시간 통계 API 사용 (더 정확한 가격 정보)
        const data = await fetchWithRetry(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
        
        if (data && data.lastPrice) {
            const price = parseFloat(data.lastPrice);
            log(`바이낸스 ${symbol} 가격: $${price} (24h 변화: ${data.priceChangePercent}%)`);
            return price;
        }
        
        // 폴백: 기본 가격 API
        const fallbackData = await fetchWithRetry(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        return fallbackData && fallbackData.price ? parseFloat(fallbackData.price) : null;
        
    } catch (error) {
        log(`바이낸스 가격 조회 오류 (${symbol}): ${error.message}`, 'ERROR');
        return null;
    }
}

// API 키 연결 테스트 (POA-main 스타일)
async function testApiConnection(exchange, apiKey, secretKey) {
    try {
        if (exchange === 'upbit') {
            if (!apiKey || !secretKey) {
                return { success: false, error: 'API 키 또는 시크릿 키가 비어있습니다' };
            }
            
            // 업비트 계정 정보 조회 테스트
            const jwt = require('jsonwebtoken');
            const crypto = require('crypto');
            const querystring = require('querystring');
            
            const payload = {
                access_key: apiKey,
                nonce: Date.now(),
            };
            
            const token = jwt.sign(payload, secretKey);
            
            const response = await fetch('https://api.upbit.com/v1/accounts', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                }
            });
            
            if (response.ok) {
                const accounts = await response.json();
                globalState.apiKeys.upbit.connected = true;
                globalState.apiKeys.upbit.lastTest = new Date().toISOString();
                return { 
                    success: true, 
                    message: `업비트 연결 성공 (${accounts.length}개 계정 확인됨)`,
                    accounts: accounts.length
                };
            } else {
                const error = await response.text();
                return { success: false, error: `업비트 API 인증 실패: ${error}` };
            }
            
        } else if (exchange === 'binance') {
            if (!apiKey || !secretKey) {
                return { success: false, error: 'API 키 또는 시크릿 키가 비어있습니다' };
            }
            
            // 바이낸스 계정 정보 조회 테스트
            const crypto = require('crypto');
            const timestamp = Date.now();
            const queryString = `timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
            
            const response = await fetch(`https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`, {
                method: 'GET',
                headers: {
                    'X-MBX-APIKEY': apiKey,
                }
            });
            
            if (response.ok) {
                const account = await response.json();
                globalState.apiKeys.binance.connected = true;
                globalState.apiKeys.binance.lastTest = new Date().toISOString();
                return { 
                    success: true, 
                    message: `바이낸스 연결 성공 (권한: ${account.permissions?.join(', ') || 'SPOT'})`,
                    permissions: account.permissions || ['SPOT']
                };
            } else {
                const error = await response.text();
                return { success: false, error: `바이낸스 API 인증 실패: ${error}` };
            }
        }
        
        return { success: false, error: '지원하지 않는 거래소입니다' };
        
    } catch (error) {
        log(`${exchange} API 연결 테스트 오류: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }
}

// 환율 업데이트 (한국 금융 데이터 우선)
async function updateUsdKrwRate() {
    try {
        // 안정적인 환율 API들 (신뢰도 순서)
        const exchangeRateApis = [
            {
                name: '야후 파이낸스',
                url: 'https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X',
                parser: (data) => {
                    if (data && data.chart && data.chart.result && data.chart.result.length > 0) {
                        const result = data.chart.result[0];
                        if (result.meta && result.meta.regularMarketPrice) {
                            return parseFloat(result.meta.regularMarketPrice);
                        }
                    }
                    return null;
                }
            },
            {
                name: 'ExchangeRate API',
                url: 'https://api.exchangerate-api.com/v4/latest/USD',
                parser: (data) => {
                    if (data && data.rates && data.rates.KRW) {
                        return parseFloat(data.rates.KRW);
                    }
                    return null;
                }
            },
            {
                name: 'Fixer.io (Free)',
                url: 'https://api.fixer.io/latest?base=USD&symbols=KRW',
                parser: (data) => {
                    if (data && data.rates && data.rates.KRW) {
                        return parseFloat(data.rates.KRW);
                    }
                    return null;
                }
            }
        ];
        
        for (const api of exchangeRateApis) {
            try {
                log(`환율 조회 시도: ${api.name}`, 'INFO');
                const data = await fetchWithRetry(api.url, { maxRetries: 2, timeout: 3000, silent: true });
                
                if (data) {
                    const newRate = api.parser(data);
                    
                    if (newRate && newRate > 1000 && newRate < 2000) { // 합리적인 환율 범위
                        const oldRate = globalState.usdKrwRate;
                        const rateDiff = Math.abs(newRate - oldRate);
                        
                        if (rateDiff > 1) { // 1원 이상 차이날 때만 업데이트
                            globalState.usdKrwRate = newRate;
                            log(`환율 업데이트 성공 (${api.name}): ${oldRate.toFixed(2)} → ${newRate.toFixed(2)} (차이: ${rateDiff.toFixed(2)}원)`, 'INFO');
                        } else {
                            log(`환율 확인 (${api.name}): ${newRate.toFixed(2)} (변화 없음)`, 'INFO');
                        }
                        return; // 성공하면 루프 종료
                    } else {
                        log(`${api.name}에서 비정상적인 환율 수신: ${newRate}`, 'WARN');
                    }
                } else {
                    log(`${api.name} 환율 데이터 없음 (다음 API 시도)`, 'WARN');
                }
            } catch (error) {
                log(`${api.name} 환율 조회 실패: ${error.message}`, 'WARN');
                continue; // 다음 API 시도
            }
        }
        
        // 모든 API 실패 시 (1시간에 1번만 알림)
        const lastFailureKey = 'exchange_rate_failure';
        const now = Date.now();
        
        if (!globalState.lastNotifications) {
            globalState.lastNotifications = {};
        }
        
        const lastNotification = globalState.lastNotifications[lastFailureKey] || 0;
        const oneHour = 60 * 60 * 1000; // 1시간
        
        if (now - lastNotification > oneHour) {
            log('모든 환율 API 조회 실패 - Discord 알림 전송', 'ERROR');
            await sendConnectionFailureAlert('exchange_rate', 
                new Error('모든 환율 API에서 데이터 수집 실패'), 
                { currentRate: globalState.usdKrwRate }
            );
            globalState.lastNotifications[lastFailureKey] = now;
        } else {
            log('모든 환율 API 조회 실패 - 기본값 유지 (알림 생략)', 'WARN');
        }
        
    } catch (error) {
        log(`환율 업데이트 전체 오류: ${error.message}`, 'ERROR');
        await sendConnectionFailureAlert('exchange_rate', error, {
            currentRate: globalState.usdKrwRate,
            stackTrace: error.stack
        });
    }
}

// .env 파일 관리 함수들
function loadEnvFile() {
    const envPath = path.join(process.cwd(), '.env');
    let envData = {};
    
    try {
        if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            envContent.split('\n').forEach(line => {
                line = line.trim();
                if (line && !line.startsWith('#') && line.includes('=')) {
                    const [key, ...values] = line.split('=');
                    envData[key.trim()] = values.join('=').trim();
                }
            });
        }
    } catch (error) {
        log(`.env 파일 로드 실패: ${error.message}`, 'WARN');
    }
    
    return envData;
}

// Discord 웹훅 테스트 함수
async function testDiscordWebhookConnection(webhookUrl) {
    try {
        const testEmbed = {
            title: "🧪 웹훅 연결 테스트",
            description: "관리자 패널에서 Discord 웹훅 연결을 테스트하고 있습니다",
            color: 0x00ff00,
            fields: [
                {
                    name: "테스트 시간",
                    value: new Date().toLocaleString('ko-KR'),
                    inline: true
                },
                {
                    name: "서버 상태",
                    value: "정상 작동",
                    inline: true
                },
                {
                    name: "시스템",
                    value: "김프 아비트라지 v2.1",
                    inline: true
                }
            ],
            timestamp: new Date().toISOString(),
            footer: {
                text: "웹훅 테스트 성공 - 설정이 완료되었습니다!"
            }
        };

        const response = await fetchWithRetry(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [testEmbed] })
        });

        if (response.ok) {
            globalState.lastDiscordTest = new Date().toISOString();
            log('Discord 웹훅 테스트 성공');
            return { success: true, message: 'Discord 웹훅 연결 테스트 성공' };
        } else {
            const errorText = await response.text();
            log(`Discord 웹훅 테스트 실패: ${response.status} - ${errorText}`, 'WARN');
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }
    } catch (error) {
        log(`Discord 웹훅 테스트 오류: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }
}

function saveEnvFile(envData) {
    const envPath = path.join(process.cwd(), '.env');
    
    try {
        let envContent = `# 김프 아비트라지 서버 환경 설정
# 자동 생성됨 - ${new Date().toLocaleString('ko-KR')}

# 서버 설정
PORT=${envData.PORT || '8080'}
NODE_ENV=${envData.NODE_ENV || 'production'}

# 거래 종목 (쉼표로 구분)
SYMBOLS=${envData.SYMBOLS || 'BTC,ETH,XRP'}

# 타이밍 설정 (밀리초)
DATA_INTERVAL=${envData.DATA_INTERVAL || '15000'}
RATE_INTERVAL=${envData.RATE_INTERVAL || '60000'}

# API 키 - 관리자 패널에서 설정됨
UPBIT_ACCESS_KEY=${envData.UPBIT_ACCESS_KEY || ''}
UPBIT_SECRET_KEY=${envData.UPBIT_SECRET_KEY || ''}
BINANCE_API_KEY=${envData.BINANCE_API_KEY || ''}
BINANCE_SECRET_KEY=${envData.BINANCE_SECRET_KEY || ''}

# Discord 웹훅 URL (알림용)
DISCORD_WEBHOOK_URL=${envData.DISCORD_WEBHOOK_URL || ''}
`;

        fs.writeFileSync(envPath, envContent, 'utf8');
        log('.env 파일 저장 완료', 'INFO');
        return true;
    } catch (error) {
        log(`.env 파일 저장 실패: ${error.message}`, 'ERROR');
        return false;
    }
}

function updateEnvVariable(key, value) {
    try {
        const envData = loadEnvFile();
        envData[key] = value;
        
        // 글로벌 상태도 업데이트
        if (key === 'UPBIT_ACCESS_KEY') globalState.apiKeys.upbit.key = value;
        if (key === 'UPBIT_SECRET_KEY') globalState.apiKeys.upbit.secret = value;
        if (key === 'BINANCE_API_KEY') globalState.apiKeys.binance.key = value;
        if (key === 'BINANCE_SECRET_KEY') globalState.apiKeys.binance.secret = value;
        if (key === 'DISCORD_WEBHOOK_URL') CONFIG.discordWebhookUrl = value;
        
        return saveEnvFile(envData);
    } catch (error) {
        log(`환경 변수 업데이트 실패 (${key}): ${error.message}`, 'ERROR');
        return false;
    }
}

// 병렬 데이터 수집 (성능 최적화)
async function collectMarketData() {
    const startTime = Date.now();
    
    try {
        // 모든 심볼을 병렬로 처리
        const dataPromises = CONFIG.symbols.map(async (symbol) => {
            try {
                const [upbitPrice, binancePrice] = await Promise.all([
                    fetchUpbitPrice(symbol),
                    fetchBinancePrice(symbol)
                ]);
                
                if (upbitPrice && binancePrice) {
                    const kimp = calculateKimp(upbitPrice, binancePrice, globalState.usdKrwRate);
                    
                    const marketData = {
                        timestamp: new Date().toISOString(),
                        symbol,
                        upbitPrice,
                        binancePrice,
                        usdKrw: globalState.usdKrwRate,
                        kimp
                    };
                    
                    // 최신 데이터 저장
                    globalState.latestData[symbol] = marketData;
                    globalState.stats.dataPoints++;
                    
                    return { symbol, kimp, success: true };
                }
                
                return { symbol, success: false, error: 'Price fetch failed' };
                
            } catch (error) {
                return { symbol, success: false, error: error.message };
            }
        });
        
        const results = await Promise.all(dataPromises);
        const successCount = results.filter(r => r.success).length;
        
        // 결과 로깅
        if (successCount === CONFIG.symbols.length) {
            const kimps = results.filter(r => r.success).map(r => `${r.symbol}:${r.kimp.toFixed(2)}%`).join(' ');
            log(`김프 업데이트: ${kimps}`);
        } else {
            const failed = results.filter(r => !r.success).map(r => r.symbol).join(',');
            log(`일부 데이터 수집 실패: [${failed}] (${successCount}/${CONFIG.symbols.length} 성공)`, 'WARN');
        }
        
        const duration = Date.now() - startTime;
        if (duration > 5000) {
            log(`데이터 수집 느림: ${duration}ms`, 'WARN');
        }
        
    } catch (error) {
        log(`데이터 수집 전체 실패: ${error.message}`, 'ERROR');
        globalState.stats.errors++;
    }
}

// 자동 시스템 정리
function performMaintenance() {
    try {
        const beforeMemory = process.memoryUsage().heapUsed;
        
        // 통계 리셋 (일일 한계 도달시)
        if (globalState.stats.dataPoints > 50000) {
            const oldStats = { ...globalState.stats };
            globalState.stats = {
                apiCalls: 0,
                dataPoints: 0,
                errors: 0,
                uptime: Math.floor((Date.now() - globalState.startTime) / 1000)
            };
            log(`통계 리셋: API ${oldStats.apiCalls}, 데이터 ${oldStats.dataPoints}, 오류 ${oldStats.errors}`);
        }
        
        // 로그 버퍼 정리
        if (globalState.logBuffer.length > CONFIG.maxLogLines * 0.8) {
            const removed = globalState.logBuffer.length - Math.floor(CONFIG.maxLogLines / 2);
            globalState.logBuffer = globalState.logBuffer.slice(-Math.floor(CONFIG.maxLogLines / 2));
            log(`로그 정리: ${removed}줄 삭제`);
        }
        
        // 가비지 컬렉션 (가능한 경우)
        if (global.gc) {
            global.gc();
            const afterMemory = process.memoryUsage().heapUsed;
            const freed = Math.floor((beforeMemory - afterMemory) / 1024 / 1024);
            if (freed > 0) {
                log(`메모리 정리: ${freed}MB 해제`);
            }
        }
        
        // 시스템 상태 요약
        const memUsage = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
        const uptime = Math.floor((Date.now() - globalState.startTime) / 1000 / 60);
        log(`시스템 점검: 메모리 ${memUsage}MB, 가동시간 ${uptime}분, API ${globalState.stats.apiCalls}회`);
        
    } catch (error) {
        log(`시스템 정리 오류: ${error.message}`, 'ERROR');
    }
}

// HTTP 서버 (경량화)
const server = http.createServer((req, res) => {
    // CORS 헤더
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = req.url;
    const startTime = Date.now();
    
    // POST 요청 처리
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                if (url === '/api/update-api-keys') {
                    const data = JSON.parse(body);
                    const { exchange, apiKey, secretKey } = data;
                    
                    let success = false;
                    let message = '';
                    
                    if (exchange === 'upbit') {
                        globalState.apiKeys.upbit.key = apiKey;
                        globalState.apiKeys.upbit.secret = secretKey;
                        
                        // .env 파일에 저장
                        const keySuccess = updateEnvVariable('UPBIT_ACCESS_KEY', apiKey);
                        const secretSuccess = updateEnvVariable('UPBIT_SECRET_KEY', secretKey);
                        
                        if (keySuccess && secretSuccess) {
                            success = true;
                            message = '업비트 API 키가 저장되었습니다';
                            log(`업비트 API 키 업데이트 및 .env 저장 완료`);
                        } else {
                            message = 'API 키는 설정되었으나 .env 저장에 실패했습니다';
                            log(`업비트 API 키 .env 저장 실패`, 'WARN');
                        }
                        
                    } else if (exchange === 'binance') {
                        globalState.apiKeys.binance.key = apiKey;
                        globalState.apiKeys.binance.secret = secretKey;
                        
                        // .env 파일에 저장
                        const keySuccess = updateEnvVariable('BINANCE_API_KEY', apiKey);
                        const secretSuccess = updateEnvVariable('BINANCE_SECRET_KEY', secretKey);
                        
                        if (keySuccess && secretSuccess) {
                            success = true;
                            message = '바이낸스 API 키가 저장되었습니다';
                            log(`바이낸스 API 키 업데이트 및 .env 저장 완료`);
                        } else {
                            message = 'API 키는 설정되었으나 .env 저장에 실패했습니다';
                            log(`바이낸스 API 키 .env 저장 실패`, 'WARN');
                        }
                    } else {
                        message = '지원하지 않는 거래소입니다';
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success, message }));
                    
                } else if (url === '/api/test-api-connection') {
                    const data = JSON.parse(body);
                    const { exchange, apiKey, secretKey } = data;
                    
                    const result = await testApiConnection(exchange, apiKey, secretKey);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                    
                } else if (url === '/api/update-discord-webhook') {
                    const data = JSON.parse(body);
                    const { webhookUrl } = data;
                    
                    const success = updateEnvVariable('DISCORD_WEBHOOK_URL', webhookUrl);
                    
                    if (success) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: true, 
                            message: 'Discord 웹훅 URL이 저장되었습니다' 
                        }));
                        log(`Discord 웹훅 URL 업데이트 및 .env 저장 완료`);
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: false, 
                            error: '.env 파일 저장에 실패했습니다' 
                        }));
                    }
                    
                } else if (url === '/api/test-discord-webhook') {
                    const data = JSON.parse(body);
                    const { webhookUrl } = data;
                    
                    const result = await testDiscordWebhookConnection(webhookUrl);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                    
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Not Found' }));
                }
            } catch (error) {
                log(`POST 요청 처리 오류: ${error.message}`, 'ERROR');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
        });
        
        return;
    }
    
    try {
        if (url === '/health' || url === '/health/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: globalState.startTime ? Math.floor((Date.now() - globalState.startTime) / 1000) : 0,
                memory: {
                    used: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
                    total: Math.floor(process.memoryUsage().heapTotal / 1024 / 1024)
                },
                stats: globalState.stats,
                version: '1.0.0'
            }));
        }
        
        else if (url === '/api/market-data' || url === '/api/market-data/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                timestamp: new Date().toISOString(),
                data: globalState.latestData,
                usdKrwRate: globalState.usdKrwRate,
                dataAge: Object.keys(globalState.latestData).length > 0 ? 
                    Math.floor((Date.now() - new Date(Object.values(globalState.latestData)[0].timestamp).getTime()) / 1000) : 0
            }));
        }
        
        else if (url === '/api/stats' || url === '/api/stats/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...globalState.stats,
                uptime: globalState.startTime ? Math.floor((Date.now() - globalState.startTime) / 1000) : 0,
                memory: process.memoryUsage(),
                logLines: globalState.logBuffer.length,
                symbols: CONFIG.symbols,
                intervals: {
                    dataCollection: CONFIG.dataCollectionInterval,
                    exchangeRate: CONFIG.exchangeRateUpdateInterval
                }
            }));
        }
        
        else if (url === '/api/logs' || url === '/api/logs/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                logs: globalState.logBuffer.slice(-100),
                totalLines: globalState.logBuffer.length
            }));
        }
        
        else if (url === '/api/api-keys' || url === '/api/api-keys/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                upbit: {
                    hasKey: !!globalState.apiKeys.upbit.key,
                    hasSecret: !!globalState.apiKeys.upbit.secret,
                    connected: globalState.apiKeys.upbit.connected,
                    lastTest: globalState.apiKeys.upbit.lastTest
                },
                binance: {
                    hasKey: !!globalState.apiKeys.binance.key,
                    hasSecret: !!globalState.apiKeys.binance.secret,
                    connected: globalState.apiKeys.binance.connected,
                    lastTest: globalState.apiKeys.binance.lastTest
                }
            }));
        }
        
        else if (url === '/api/discord-webhook-status' || url === '/api/discord-webhook-status/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                configured: !!CONFIG.discordWebhookUrl && CONFIG.discordWebhookUrl.includes('discord.com/api/webhooks/'),
                lastTest: globalState.lastDiscordTest || null
            }));
        }
        
        else if (url === '/api/exchange-rate' || url === '/api/exchange-rate/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                usdKrw: globalState.usdKrwRate,
                lastUpdate: globalState.startTime ? new Date().toISOString() : null,
                source: '네이버 금융/야후 파이낸스',
                updateInterval: '1분'
            }));
        }
        
        else if (url === '/' || url === '/dashboard' || url === '/dashboard/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getDashboardHTML());
        }
        
        else if (url === '/admin' || url === '/admin/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getAdminHTML());
        }
        
        else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found', path: url }));
        }
        
    } catch (error) {
        log(`HTTP 요청 처리 오류 [${url}]: ${error.message}`, 'ERROR');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
    
    // 응답 시간 로깅 (느린 요청만)
    const duration = Date.now() - startTime;
    if (duration > 1000) {
        log(`느린 요청: ${url} (${duration}ms)`, 'WARN');
    }
});

// 대시보드 HTML (최적화된)
function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>김프 아비트라지 모니터 | Vultr Cloud</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #ffffff;
            min-height: 100vh;
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; color: #4CAF50; }
        .header p { color: #aaa; font-size: 1.1em; }
        .status-bar { 
            background: rgba(255,255,255,0.1); 
            padding: 15px; 
            border-radius: 10px; 
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            flex-wrap: wrap;
            backdrop-filter: blur(10px);
        }
        .status-item { text-align: center; min-width: 120px; }
        .status-value { font-size: 1.3em; font-weight: bold; color: #4CAF50; }
        .status-label { font-size: 0.9em; color: #bbb; }
        .grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 20px; 
            margin-bottom: 30px;
        }
        .card { 
            background: rgba(255,255,255,0.1); 
            border-radius: 15px; 
            padding: 20px; 
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
            transition: transform 0.2s ease;
        }
        .card:hover { transform: translateY(-2px); }
        .card h3 { margin-bottom: 15px; color: #fff; font-size: 1.3em; }
        .kimp-display { 
            font-size: 2.2em; 
            font-weight: bold; 
            margin: 15px 0; 
            text-align: center;
        }
        .positive { color: #ff6b6b; }
        .negative { color: #4ecdc4; }
        .neutral { color: #ffd93d; }
        .price-info { 
            display: flex; 
            justify-content: space-between; 
            margin-top: 15px;
            font-size: 0.9em;
            color: #ccc;
        }
        .log-container { 
            background: rgba(0,0,0,0.3); 
            border-radius: 10px; 
            padding: 15px; 
            max-height: 300px; 
            overflow-y: auto;
            font-family: 'Courier New', monospace;
            font-size: 0.85em;
        }
        .log-line { margin: 2px 0; }
        .log-error { color: #ff6b6b; }
        .log-warn { color: #ffd93d; }
        .log-info { color: #4ecdc4; }
        .footer { 
            text-align: center; 
            margin-top: 40px; 
            padding: 20px; 
            color: #666; 
            font-size: 0.9em;
        }
        @media (max-width: 768px) {
            .container { padding: 10px; }
            .header h1 { font-size: 2em; }
            .status-bar { flex-direction: column; gap: 10px; }
            .grid { grid-template-columns: 1fr; gap: 15px; }
        }
        .loading { opacity: 0.6; }
        .online-indicator { 
            display: inline-block; 
            width: 8px; 
            height: 8px; 
            background: #4CAF50; 
            border-radius: 50%; 
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 김프 아비트라지 모니터</h1>
            <p><span class="online-indicator"></span>Vultr Cloud • 실시간 김치프리미엄 추적</p>
        </div>
        
        <div class="status-bar">
            <div class="status-item">
                <div class="status-value" id="uptime">-</div>
                <div class="status-label">가동시간</div>
            </div>
            <div class="status-item">
                <div class="status-value" id="memory">-</div>
                <div class="status-label">메모리</div>
            </div>
            <div class="status-item">
                <div class="status-value" id="apiCalls">-</div>
                <div class="status-label">API 호출</div>
            </div>
            <div class="status-item">
                <div class="status-value" id="dataPoints">-</div>
                <div class="status-label">데이터 수집</div>
            </div>
            <div class="status-item">
                <div class="status-value" id="usdKrw">-</div>
                <div class="status-label">USD/KRW</div>
            </div>
        </div>
        
        <div class="grid" id="symbolGrid">
            <!-- 심볼 카드들이 여기에 동적으로 생성 -->
        </div>
        
        <div class="card">
            <h3>📊 시스템 로그</h3>
            <div class="log-container" id="logContainer">
                <div class="log-line">시스템 로딩 중...</div>
            </div>
        </div>
        
        <div class="footer">
            <p>김프 아비트라지 모니터 v1.0 | Vultr Cloud Computing</p>
            <p>실시간 업데이트: 15초 간격 | 환율 업데이트: 5분 간격</p>
        </div>
    </div>
    
    <script>
        let isLoading = false;
        let lastUpdateTime = 0;
        
        function formatTime(seconds) {
            if (seconds < 60) return seconds + '초';
            if (seconds < 3600) return Math.floor(seconds/60) + '분';
            return Math.floor(seconds/3600) + '시간 ' + Math.floor((seconds%3600)/60) + '분';
        }
        
        function formatNumber(num) {
            return num.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
        }
        
        function getKimpClass(kimp) {
            if (kimp > 0.5) return 'positive';
            if (kimp < -0.5) return 'negative';
            return 'neutral';
        }
        
        async function updateDashboard() {
            if (isLoading) return;
            isLoading = true;
            
            try {
                // 병렬로 데이터 가져오기
                const [marketResponse, statsResponse, logsResponse] = await Promise.all([
                    fetch('/api/market-data'),
                    fetch('/api/stats'),
                    fetch('/api/logs')
                ]);
                
                if (!marketResponse.ok || !statsResponse.ok) {
                    throw new Error('API 응답 오류');
                }
                
                const marketData = await marketResponse.json();
                const stats = await statsResponse.json();
                const logs = logsResponse.ok ? await logsResponse.json() : { logs: [] };
                
                // 상태 바 업데이트
                document.getElementById('uptime').textContent = formatTime(stats.uptime);
                document.getElementById('memory').textContent = Math.floor(stats.memory.heapUsed / 1024 / 1024) + 'MB';
                document.getElementById('apiCalls').textContent = formatNumber(stats.apiCalls);
                document.getElementById('dataPoints').textContent = formatNumber(stats.dataPoints);
                document.getElementById('usdKrw').textContent = marketData.usdKrwRate.toFixed(2);
                
                // 심볼 카드 업데이트
                updateSymbolCards(marketData.data);
                
                // 로그 업데이트
                updateLogs(logs.logs);
                
                lastUpdateTime = Date.now();
                
            } catch (error) {
                console.error('대시보드 업데이트 오류:', error);
                document.getElementById('logContainer').innerHTML = 
                    '<div class="log-line log-error">연결 오류: ' + error.message + '</div>';
            } finally {
                isLoading = false;
            }
        }
        
        function updateSymbolCards(data) {
            const grid = document.getElementById('symbolGrid');
            const symbols = ['BTC', 'ETH', 'XRP'];
            
            grid.innerHTML = '';
            
            symbols.forEach(symbol => {
                const item = data[symbol];
                const card = document.createElement('div');
                card.className = 'card';
                
                if (item) {
                    const kimpClass = getKimpClass(item.kimp);
                    const dataAge = Math.floor((Date.now() - new Date(item.timestamp).getTime()) / 1000);
                    
                    card.innerHTML = \`
                        <h3>\${symbol} <small style="color:#888;">(\${dataAge}초 전)</small></h3>
                        <div class="kimp-display \${kimpClass}">
                            \${item.kimp > 0 ? '+' : ''}\${item.kimp.toFixed(2)}%
                        </div>
                        <div class="price-info">
                            <div>
                                <div>업비트</div>
                                <div><strong>\${formatNumber(item.upbitPrice)}원</strong></div>
                            </div>
                            <div>
                                <div>바이낸스</div>
                                <div><strong>$\${item.binancePrice.toFixed(2)}</strong></div>
                            </div>
                        </div>
                    \`;
                } else {
                    card.innerHTML = \`
                        <h3>\${symbol}</h3>
                        <div class="kimp-display neutral">데이터 없음</div>
                        <div class="price-info">
                            <div style="text-align: center; color: #888;">
                                데이터 수집 중...
                            </div>
                        </div>
                    \`;
                }
                
                grid.appendChild(card);
            });
        }
        
        function updateLogs(logs) {
            const container = document.getElementById('logContainer');
            
            if (logs && logs.length > 0) {
                container.innerHTML = logs.slice(-20).map(log => {
                    let className = 'log-info';
                    if (log.includes('ERROR')) className = 'log-error';
                    else if (log.includes('WARN')) className = 'log-warn';
                    
                    return \`<div class="log-line \${className}">\${log}</div>\`;
                }).join('');
                
                container.scrollTop = container.scrollHeight;
            }
        }
        
        // 자동 업데이트 (3초마다)
        setInterval(updateDashboard, 3000);
        
        // 초기 로드
        updateDashboard();
        
        // 페이지 가시성 변경 시 업데이트 주기 조정
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                console.log('페이지 숨김 - 업데이트 일시정지');
            } else {
                console.log('페이지 활성화 - 즉시 업데이트');
                updateDashboard();
            }
        });
    </script>
</body>
</html>`;
}

// 관리자 패널 HTML (POA-main 스타일)
function getAdminHTML() {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>김프 아비트라지 관리자 패널 | Vultr Cloud</title>
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
        .tabs {
            display: flex; background: rgba(255,255,255,0.95); border-radius: 15px;
            margin-bottom: 20px; padding: 10px; box-shadow: 0 5px 20px rgba(0,0,0,0.1);
        }
        .tab-button {
            flex: 1; padding: 15px; background: none; border: none;
            border-radius: 10px; cursor: pointer; font-weight: 600;
            transition: all 0.3s ease; color: #666;
        }
        .tab-button.active {
            background: #667eea; color: white;
            box-shadow: 0 5px 15px rgba(102,126,234,0.3);
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; }
        .card {
            background: rgba(255,255,255,0.95); border-radius: 15px; padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1); backdrop-filter: blur(10px);
        }
        .card h2 { color: #667eea; margin-bottom: 20px; font-size: 1.4em; }
        .status-item { 
            display: flex; justify-content: space-between; align-items: center;
            padding: 12px 0; border-bottom: 1px solid #eee;
        }
        .status-item:last-child { border-bottom: none; }
        .status-label { font-weight: 600; color: #555; }
        .status-value { 
            padding: 6px 12px; border-radius: 20px; font-weight: 600;
            background: #f0f8ff; color: #667eea;
        }
        .status-success { background: #d4edda; color: #155724; }
        .status-danger { background: #f8d7da; color: #721c24; }
        .btn {
            background: #667eea; color: white; border: none; padding: 12px 24px;
            border-radius: 25px; cursor: pointer; font-weight: 600;
            transition: all 0.3s ease; margin: 5px;
        }
        .btn:hover { background: #5a6fd8; transform: translateY(-2px); }
        .btn-success { background: #28a745; }
        .btn-warning { background: #ffc107; color: #212529; }
        .btn-danger { background: #dc3545; }
        .market-data { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
        .market-item {
            background: linear-gradient(135deg, #667eea, #764ba2); color: white;
            padding: 20px; border-radius: 12px; text-align: center;
        }
        .market-symbol { font-size: 1.5em; font-weight: bold; margin-bottom: 10px; }
        .market-kimp { font-size: 1.2em; margin-bottom: 5px; }
        .market-zscore { font-size: 0.9em; opacity: 0.9; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #555; }
        .form-group input, .form-group select {
            width: 100%; padding: 12px; border: 2px solid #e1e5e9;
            border-radius: 8px; font-size: 14px;
        }
        .alert { padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .alert-success { background: #d4edda; color: #155724; }
        .alert-error { background: #f8d7da; color: #721c24; }
        .loading { opacity: 0.6; }
        .vultr-badge { 
            background: #007BFC; color: white; padding: 4px 8px; 
            border-radius: 12px; font-size: 0.8em; margin-left: 10px; 
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 김프 아비트라지 관리자</h1>
            <p>Vultr Cloud 서버 관리 시스템<span class="vultr-badge">LIVE</span></p>
        </div>
        
        <div class="tabs">
            <button class="tab-button active" onclick="showTab('overview')">📊 개요</button>
            <button class="tab-button" onclick="showTab('apikeys')">🔑 API 키</button>
            <button class="tab-button" onclick="showTab('control')">🎮 제어</button>
            <button class="tab-button" onclick="showTab('logs')">📋 로그</button>
        </div>
        
        <!-- 개요 탭 -->
        <div id="overview" class="tab-content active">
            <div class="grid">
                <div class="card">
                    <h2>📊 시스템 상태</h2>
                    <div id="system-status">
                        <div class="status-item">
                            <span class="status-label">서버 상태</span>
                            <span class="status-value status-success" id="status-running">🟢 실행중</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">가동시간</span>
                            <span class="status-value" id="status-uptime">-</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">메모리 사용량</span>
                            <span class="status-value" id="status-memory">-</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">API 호출 수</span>
                            <span class="status-value" id="status-api-calls">-</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">데이터 포인트</span>
                            <span class="status-value" id="status-data-points">-</span>
                        </div>
                    </div>
                </div>
                
                <div class="card">
                    <h2>💹 실시간 시장 데이터</h2>
                    <div class="market-data" id="market-data">
                        <div class="market-item">
                            <div class="market-symbol">로딩중...</div>
                        </div>
                    </div>
                </div>
                
                <div class="card">
                    <h2>⚡ 빠른 작업</h2>
                    <button class="btn" onclick="refreshData()">📊 새로고침</button>
                    <button class="btn btn-success" onclick="testHealth()">🔧 헬스 체크</button>
                    <button class="btn btn-warning" onclick="viewLogs()">📋 로그 보기</button>
                    <button class="btn" onclick="goToDashboard()">📱 대시보드</button>
                    
                    <div style="margin-top: 20px;">
                        <label>
                            <input type="checkbox" id="auto-refresh" checked> 자동 새로고침 (10초)
                        </label>
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
                        <label>Access Key</label>
                        <input type="password" id="upbit-api-key" placeholder="업비트 API 키를 입력하세요" />
                    </div>
                    <div class="form-group">
                        <label>Secret Key</label>
                        <input type="password" id="upbit-secret-key" placeholder="업비트 시크릿 키를 입력하세요" />
                    </div>
                    <div class="form-group">
                        <button class="btn" onclick="updateApiKeys('upbit')">💾 저장</button>
                        <button class="btn btn-success" onclick="testConnection('upbit')">🔧 연결 테스트</button>
                    </div>
                    <div id="upbit-status" class="status-item">
                        <span class="status-label">연결 상태</span>
                        <span class="status-value" id="upbit-connection-status">미확인</span>
                    </div>
                    <div id="upbit-alert"></div>
                </div>
                
                <div class="card">
                    <h2>🔑 바이낸스 API 키</h2>
                    <div class="form-group">
                        <label>API Key</label>
                        <input type="password" id="binance-api-key" placeholder="바이낸스 API 키를 입력하세요" />
                    </div>
                    <div class="form-group">
                        <label>Secret Key</label>
                        <input type="password" id="binance-secret-key" placeholder="바이낸스 시크릿 키를 입력하세요" />
                    </div>
                    <div class="form-group">
                        <button class="btn" onclick="updateApiKeys('binance')">💾 저장</button>
                        <button class="btn btn-success" onclick="testConnection('binance')">🔧 연결 테스트</button>
                    </div>
                    <div id="binance-status" class="status-item">
                        <span class="status-label">연결 상태</span>
                        <span class="status-value" id="binance-connection-status">미확인</span>
                    </div>
                    <div id="binance-alert"></div>
                </div>
                
                <div class="card">
                    <h2>🔔 Discord 알림 설정</h2>
                    <div class="form-group">
                        <label>Discord 웹훅 URL</label>
                        <input type="password" id="discord-webhook-url" placeholder="Discord 웹훅 URL을 입력하세요" />
                    </div>
                    <div class="form-group">
                        <button class="btn" onclick="updateDiscordWebhook()">💾 저장</button>
                        <button class="btn btn-success" onclick="testDiscordWebhook()">📤 테스트 전송</button>
                    </div>
                    <div id="discord-status" class="status-item">
                        <span class="status-label">웹훅 상태</span>
                        <span class="status-value" id="discord-webhook-status">미확인</span>
                    </div>
                    <div id="discord-alert"></div>
                    
                    <div style="background: #e7f3ff; padding: 15px; border-radius: 8px; margin-top: 15px; color: #666; font-size: 14px;">
                        <strong>📋 Discord 웹훅 발급 방법:</strong><br>
                        1. Discord 서버 → 채널 설정 → 연동<br>
                        2. 웹후크 → 웹후크 생성<br>
                        3. 웹후크 URL 복사<br>
                        4. 위 입력란에 붙여넣기 → 저장
                    </div>
                </div>
                
                <div class="card">
                    <h2>ℹ️ API 키 설정 가이드</h2>
                    <div style="color: #666; line-height: 1.6;">
                        <h3 style="color: #667eea; margin-bottom: 10px;">업비트 API 키 발급</h3>
                        <ol style="margin-left: 20px;">
                            <li>업비트 웹사이트 로그인</li>
                            <li>마이페이지 → Open API 관리</li>
                            <li>API 키 발급 (조회 권한 필요)</li>
                            <li>Access Key, Secret Key 복사</li>
                        </ol>
                        
                        <h3 style="color: #667eea; margin: 20px 0 10px 0;">바이낸스 API 키 발급</h3>
                        <ol style="margin-left: 20px;">
                            <li>바이낸스 웹사이트 로그인</li>
                            <li>API 관리 → 새 키 생성</li>
                            <li>Spot Trading 권한 활성화</li>
                            <li>API Key, Secret Key 복사</li>
                        </ol>
                        
                        <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-top: 20px;">
                            <strong>⚠️ 보안 주의사항:</strong><br>
                            • API 키는 읽기 전용 권한만 부여하세요<br>
                            • 출금 권한은 절대 활성화하지 마세요<br>
                            • IP 제한을 설정하는 것을 권장합니다
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 제어 탭 -->
        <div id="control" class="tab-content">
            <div class="grid">
                <div class="card">
                    <h2>🎮 시스템 제어</h2>
                    <p style="color: #666; margin-bottom: 20px;">
                        Vultr 클라우드 서버에서 실행 중인 시스템의 상태를 모니터링할 수 있습니다.
                    </p>
                    
                    <div class="form-group">
                        <label>현재 설정 확인</label>
                        <button class="btn" onclick="showCurrentConfig()">설정 정보 보기</button>
                    </div>
                    
                    <div class="form-group">
                        <label>시스템 통계</label>
                        <button class="btn btn-success" onclick="showSystemStats()">상세 통계 보기</button>
                    </div>
                    
                    <div id="control-info" style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-top: 20px;">
                        <strong>📌 참고사항:</strong><br>
                        • 설정 변경은 서버 재시작이 필요합니다<br>
                        • 모든 데이터는 실시간으로 업데이트됩니다<br>
                        • 로그는 자동으로 순환 관리됩니다
                    </div>
                    
                    <div id="control-alert"></div>
                </div>
            </div>
        </div>
        
        <!-- 로그 탭 -->
        <div id="logs" class="tab-content">
            <div class="card">
                <h2>📋 시스템 로그</h2>
                <div style="margin-bottom: 15px;">
                    <button class="btn" onclick="loadLogs()">로그 새로고침</button>
                    <button class="btn btn-warning" onclick="downloadLogs()">로그 다운로드</button>
                </div>
                <div id="log-container" style="height: 500px; overflow-y: auto; background: #f8f9fa; padding: 15px; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 13px; border: 1px solid #dee2e6;">
                    로그 로딩 중...
                </div>
            </div>
        </div>
    </div>

    <script>
        let autoRefreshInterval;
        let adminLogs = [];
        
        function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.querySelectorAll('.tab-button').forEach(button => {
                button.classList.remove('active');
            });
            
            document.getElementById(tabName).classList.add('active');
            event.target.classList.add('active');
            
            if (tabName === 'logs') {
                loadLogs();
            }
        }
        
        async function refreshData() {
            document.body.classList.add('loading');
            
            try {
                // 시스템 통계 업데이트
                const statsResponse = await fetch('/api/stats');
                const stats = await statsResponse.json();
                
                document.getElementById('status-uptime').textContent = formatUptime(stats.uptime);
                document.getElementById('status-memory').textContent = Math.round(stats.memory.heapUsed / 1024 / 1024) + 'MB';
                document.getElementById('status-api-calls').textContent = stats.apiCalls + '회';
                document.getElementById('status-data-points').textContent = stats.dataPoints + '개';
                
                // 시장 데이터 업데이트
                const marketResponse = await fetch('/api/market-data');
                const marketResult = await marketResponse.json();
                const marketData = marketResult.data;
                
                const marketContainer = document.getElementById('market-data');
                marketContainer.innerHTML = '';
                
                for (const [symbol, info] of Object.entries(marketData)) {
                    const marketItem = document.createElement('div');
                    marketItem.className = 'market-item';
                    marketItem.innerHTML = \`
                        <div class="market-symbol">\${symbol}</div>
                        <div class="market-kimp">김프: \${info.kimp ? info.kimp.toFixed(2) : '-.--'}%</div>
                        <div class="market-zscore">업데이트: \${new Date(info.timestamp).toLocaleTimeString()}</div>
                    \`;
                    marketContainer.appendChild(marketItem);
                }
                
                addAdminLog('데이터 새로고침 완료');
                
            } catch (error) {
                addAdminLog('오류: ' + error.message, 'error');
                console.error('새로고침 오류:', error);
            }
            
            document.body.classList.remove('loading');
        }
        
        async function testHealth() {
            try {
                const response = await fetch('/health');
                const health = await response.json();
                
                if (health.status === 'healthy') {
                    addAdminLog('헬스 체크 성공: 서버 정상 동작', 'success');
                    showAlert('서버가 정상적으로 작동하고 있습니다!', 'success');
                } else {
                    addAdminLog('헬스 체크 경고: ' + JSON.stringify(health), 'warning');
                    showAlert('서버 상태를 확인해주세요', 'error');
                }
            } catch (error) {
                addAdminLog('헬스 체크 실패: ' + error.message, 'error');
                showAlert('서버 연결에 실패했습니다: ' + error.message, 'error');
            }
        }
        
        async function loadLogs() {
            try {
                const response = await fetch('/api/logs');
                const result = await response.json();
                
                const logContainer = document.getElementById('log-container');
                logContainer.innerHTML = result.logs.map(log => 
                    \`<div style="margin: 2px 0; color: \${getLogColor(log)};">\${log}</div>\`
                ).join('');
                
                logContainer.scrollTop = logContainer.scrollHeight;
                addAdminLog('서버 로그 로드 완료 (' + result.logs.length + '개)');
                
            } catch (error) {
                addAdminLog('로그 로드 실패: ' + error.message, 'error');
            }
        }
        
        function getLogColor(logLine) {
            if (logLine.includes('ERROR')) return '#dc3545';
            if (logLine.includes('WARN')) return '#ffc107';
            if (logLine.includes('SUCCESS')) return '#28a745';
            return '#333';
        }
        
        function addAdminLog(message, type = 'info') {
            const timestamp = new Date().toLocaleTimeString();
            const logEntry = \`[\${timestamp}] \${message}\`;
            adminLogs.push({ text: logEntry, type: type });
            
            if (adminLogs.length > 50) adminLogs.shift();
            console.log(logEntry);
        }
        
        function showCurrentConfig() {
            const config = {
                'Port': window.location.port || '8080',
                'Symbols': 'BTC, ETH, XRP',
                'Data Interval': '15초',
                'Environment': 'Vultr Cloud'
            };
            
            let configText = '🔧 현재 시스템 설정:\\n\\n';
            for (const [key, value] of Object.entries(config)) {
                configText += \`• \${key}: \${value}\\n\`;
            }
            
            alert(configText);
            addAdminLog('시스템 설정 정보 조회');
        }
        
        function showSystemStats() {
            fetch('/api/stats')
                .then(response => response.json())
                .then(stats => {
                    let statsText = '📊 시스템 통계:\\n\\n';
                    statsText += \`• 가동시간: \${formatUptime(stats.uptime)}\\n\`;
                    statsText += \`• 메모리 사용: \${Math.round(stats.memory.heapUsed / 1024 / 1024)}MB\\n\`;
                    statsText += \`• API 호출: \${stats.apiCalls}회\\n\`;
                    statsText += \`• 데이터 포인트: \${stats.dataPoints}개\\n\`;
                    statsText += \`• 로그 라인: \${stats.logLines}개\\n\`;
                    
                    alert(statsText);
                    addAdminLog('시스템 통계 조회');
                })
                .catch(error => {
                    addAdminLog('통계 조회 실패: ' + error.message, 'error');
                });
        }
        
        function viewLogs() {
            showTab('logs');
            document.querySelector('[onclick="showTab(\\'logs\\')"]').click();
        }
        
        function goToDashboard() {
            window.open('/dashboard', '_blank');
            addAdminLog('대시보드 페이지 열기');
        }
        
        function downloadLogs() {
            fetch('/api/logs')
                .then(response => response.json())
                .then(result => {
                    const logData = result.logs.join('\\n');
                    const blob = new Blob([logData], { type: 'text/plain' });
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = \`kimp-logs-\${new Date().toISOString().split('T')[0]}.txt\`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(url);
                    
                    addAdminLog('로그 파일 다운로드');
                })
                .catch(error => {
                    addAdminLog('로그 다운로드 실패: ' + error.message, 'error');
                });
        }
        
        function showAlert(message, type) {
            const alertDiv = document.getElementById('control-alert');
            alertDiv.innerHTML = \`<div class="alert alert-\${type}">\${message}</div>\`;
            setTimeout(() => { alertDiv.innerHTML = ''; }, 3000);
        }
        
        function formatUptime(seconds) {
            if (seconds < 60) return seconds + '초';
            if (seconds < 3600) return Math.floor(seconds/60) + '분';
            const hours = Math.floor(seconds/3600);
            const minutes = Math.floor((seconds%3600)/60);
            return hours + '시간 ' + minutes + '분';
        }
        
        function setupAutoRefresh() {
            const checkbox = document.getElementById('auto-refresh');
            
            if (checkbox.checked) {
                autoRefreshInterval = setInterval(refreshData, 10000);
            } else {
                clearInterval(autoRefreshInterval);
            }
            
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    autoRefreshInterval = setInterval(refreshData, 10000);
                    addAdminLog('자동 새로고침 활성화');
                } else {
                    clearInterval(autoRefreshInterval);
                    addAdminLog('자동 새로고침 비활성화');
                }
            });
        }
        
        // API 키 관리 함수들
        async function updateApiKeys(exchange) {
            try {
                const apiKeyInput = document.getElementById(\`\${exchange}-api-key\`);
                const secretKeyInput = document.getElementById(\`\${exchange}-secret-key\`);
                
                const apiKey = apiKeyInput.value.trim();
                const secretKey = secretKeyInput.value.trim();
                
                if (!apiKey || !secretKey) {
                    showApiAlert(exchange, 'API 키와 시크릿 키를 모두 입력해주세요', 'error');
                    return;
                }
                
                const response = await fetch('/api/update-api-keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ exchange, apiKey, secretKey })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showApiAlert(exchange, \`\${exchange.toUpperCase()} API 키가 저장되었습니다\`, 'success');
                    addAdminLog(\`\${exchange.toUpperCase()} API 키 업데이트 완료\`);
                    
                    // 입력 필드 초기화
                    apiKeyInput.value = '';
                    secretKeyInput.value = '';
                    
                    loadApiKeyStatus();
                } else {
                    showApiAlert(exchange, 'API 키 저장 실패: ' + result.error, 'error');
                }
                
            } catch (error) {
                showApiAlert(exchange, 'API 키 저장 중 오류 발생: ' + error.message, 'error');
            }
        }
        
        async function testConnection(exchange) {
            try {
                const apiKeyInput = document.getElementById(\`\${exchange}-api-key\`);
                const secretKeyInput = document.getElementById(\`\${exchange}-secret-key\`);
                
                const apiKey = apiKeyInput.value.trim();
                const secretKey = secretKeyInput.value.trim();
                
                if (!apiKey || !secretKey) {
                    showApiAlert(exchange, 'API 키를 먼저 입력하고 저장해주세요', 'error');
                    return;
                }
                
                showApiAlert(exchange, '연결 테스트 중...', 'info');
                
                const response = await fetch('/api/test-api-connection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ exchange, apiKey, secretKey })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showApiAlert(exchange, \`✅ \${result.message}\`, 'success');
                    document.getElementById(\`\${exchange}-connection-status\`).textContent = '연결됨';
                    document.getElementById(\`\${exchange}-connection-status\`).className = 'status-value status-success';
                    addAdminLog(\`\${exchange.toUpperCase()} API 연결 테스트 성공\`);
                } else {
                    showApiAlert(exchange, \`❌ 연결 실패: \${result.error}\`, 'error');
                    document.getElementById(\`\${exchange}-connection-status\`).textContent = '연결 실패';
                    document.getElementById(\`\${exchange}-connection-status\`).className = 'status-value status-danger';
                    addAdminLog(\`\${exchange.toUpperCase()} API 연결 테스트 실패: \${result.error}\`);
                }
                
            } catch (error) {
                showApiAlert(exchange, '연결 테스트 중 오류 발생: ' + error.message, 'error');
            }
        }
        
        async function loadApiKeyStatus() {
            try {
                const response = await fetch('/api/api-keys');
                const apiKeys = await response.json();
                
                // 업비트 상태 업데이트
                if (apiKeys.upbit.connected) {
                    document.getElementById('upbit-connection-status').textContent = '연결됨';
                    document.getElementById('upbit-connection-status').className = 'status-value status-success';
                } else if (apiKeys.upbit.hasKey && apiKeys.upbit.hasSecret) {
                    document.getElementById('upbit-connection-status').textContent = '키 설정됨';
                    document.getElementById('upbit-connection-status').className = 'status-value';
                } else {
                    document.getElementById('upbit-connection-status').textContent = '키 없음';
                    document.getElementById('upbit-connection-status').className = 'status-value status-danger';
                }
                
                // 바이낸스 상태 업데이트
                if (apiKeys.binance.connected) {
                    document.getElementById('binance-connection-status').textContent = '연결됨';
                    document.getElementById('binance-connection-status').className = 'status-value status-success';
                } else if (apiKeys.binance.hasKey && apiKeys.binance.hasSecret) {
                    document.getElementById('binance-connection-status').textContent = '키 설정됨';
                    document.getElementById('binance-connection-status').className = 'status-value';
                } else {
                    document.getElementById('binance-connection-status').textContent = '키 없음';
                    document.getElementById('binance-connection-status').className = 'status-value status-danger';
                }
                
            } catch (error) {
                console.error('API 키 상태 로드 실패:', error);
            }
        }
        
        function showApiAlert(exchange, message, type) {
            const alertDiv = document.getElementById(\`\${exchange}-alert\`);
            const alertClass = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-error' : 'alert-info';
            alertDiv.innerHTML = \`<div class="alert \${alertClass}" style="margin-top: 15px;">\${message}</div>\`;
            setTimeout(() => { alertDiv.innerHTML = ''; }, 5000);
        }
        
        // 초기화
        document.addEventListener('DOMContentLoaded', () => {
            addAdminLog('Vultr 관리자 패널 로드 완료');
            refreshData();
            setupAutoRefresh();
            loadApiKeyStatus();
            loadDiscordWebhookStatus();
        });
        
        // Discord 웹훅 관리 함수들
        async function updateDiscordWebhook() {
            try {
                const webhookInput = document.getElementById('discord-webhook-url');
                const webhookUrl = webhookInput.value.trim();
                
                if (!webhookUrl) {
                    showDiscordAlert('Discord 웹훅 URL을 입력해주세요', 'error');
                    return;
                }
                
                // 웹훅 URL 유효성 검사
                if (!webhookUrl.includes('discord.com/api/webhooks/')) {
                    showDiscordAlert('올바른 Discord 웹훅 URL을 입력해주세요', 'error');
                    return;
                }
                
                const response = await fetch('/api/update-discord-webhook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ webhookUrl })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showDiscordAlert(\`✅ Discord 웹훅이 저장되었습니다\`, 'success');
                    addAdminLog('Discord 웹훅 URL 업데이트 완료');
                    
                    // 입력 필드 초기화
                    webhookInput.value = '';
                    
                    loadDiscordWebhookStatus();
                } else {
                    showDiscordAlert('웹훅 저장 실패: ' + result.error, 'error');
                }
                
            } catch (error) {
                showDiscordAlert('웹훅 저장 중 오류 발생: ' + error.message, 'error');
            }
        }
        
        async function testDiscordWebhook() {
            try {
                const webhookInput = document.getElementById('discord-webhook-url');
                const webhookUrl = webhookInput.value.trim();
                
                if (!webhookUrl) {
                    showDiscordAlert('웹훅 URL을 먼저 입력하고 저장해주세요', 'error');
                    return;
                }
                
                showDiscordAlert('테스트 메시지 전송 중...', 'info');
                
                const response = await fetch('/api/test-discord-webhook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ webhookUrl })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showDiscordAlert(\`✅ 테스트 메시지 전송 성공!\`, 'success');
                    document.getElementById('discord-webhook-status').textContent = '연결됨';
                    document.getElementById('discord-webhook-status').className = 'status-value status-success';
                    addAdminLog('Discord 웹훅 테스트 성공');
                } else {
                    showDiscordAlert(\`❌ 테스트 실패: \${result.error}\`, 'error');
                    document.getElementById('discord-webhook-status').textContent = '연결 실패';
                    document.getElementById('discord-webhook-status').className = 'status-value status-danger';
                    addAdminLog(\`Discord 웹훅 테스트 실패: \${result.error}\`);
                }
                
            } catch (error) {
                showDiscordAlert('테스트 중 오류 발생: ' + error.message, 'error');
            }
        }
        
        async function loadDiscordWebhookStatus() {
            try {
                const response = await fetch('/api/discord-webhook-status');
                const status = await response.json();
                
                if (status.configured) {
                    document.getElementById('discord-webhook-status').textContent = '설정됨';
                    document.getElementById('discord-webhook-status').className = 'status-value status-success';
                } else {
                    document.getElementById('discord-webhook-status').textContent = '미설정';
                    document.getElementById('discord-webhook-status').className = 'status-value status-danger';
                }
                
            } catch (error) {
                console.error('Discord 웹훅 상태 로드 실패:', error);
            }
        }
        
        function showDiscordAlert(message, type) {
            const alertDiv = document.getElementById('discord-alert');
            const alertClass = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : 'alert-info';
            alertDiv.innerHTML = \`<div class="alert \${alertClass}" style="margin-top: 10px; padding: 10px; border-radius: 5px; font-size: 14px;">\${message}</div>\`;
            setTimeout(() => { alertDiv.innerHTML = ''; }, 4000);
        }
    </script>
</body>
</html>`;
}

// 시스템 시작
async function startSystem() {
    log('🌟 Vultr 김프 아비트라지 모니터 시작');
    log(`📊 설정: 심볼 [${CONFIG.symbols.join(', ')}] / 데이터 수집 ${CONFIG.dataCollectionInterval/1000}초`);
    log(`💰 환율: ${globalState.usdKrwRate} KRW/USD`);
    
    globalState.isRunning = true;
    globalState.startTime = Date.now();
    
    // 스케줄러 시작
    setInterval(collectMarketData, CONFIG.dataCollectionInterval);
    setInterval(updateUsdKrwRate, CONFIG.exchangeRateUpdateInterval);
    setInterval(performMaintenance, CONFIG.cleanupInterval);
    
    // 초기 데이터 수집
    setTimeout(collectMarketData, 2000);
    setTimeout(updateUsdKrwRate, 5000);
    
    // HTTP 서버 시작
    server.listen(CONFIG.port, '0.0.0.0', async () => {
        log(`🚀 서버 시작: http://0.0.0.0:${CONFIG.port}`);
        log(`📱 대시보드: http://0.0.0.0:${CONFIG.port}/dashboard`);
        log(`⚙️ 관리자 패널: http://0.0.0.0:${CONFIG.port}/admin`);
        log(`🔍 헬스체크: http://0.0.0.0:${CONFIG.port}/health`);
        log('💡 Vultr 클라우드 최적화 완료');
        
        // Discord 시스템 시작 알림
        await sendSystemAlert('startup', {
            port: CONFIG.port,
            symbols: CONFIG.symbols,
            startTime: new Date().toLocaleString('ko-KR')
        });
    });
}

// 우아한 종료 처리
process.on('SIGTERM', () => {
    log('🛑 SIGTERM 신호 수신 - 우아한 종료 시작');
    globalState.isRunning = false;
    
    server.close(() => {
        log('✅ HTTP 서버 종료 완료');
        process.exit(0);
    });
    
    // 강제 종료 방지 (10초 후)
    setTimeout(() => {
        log('⚠️ 강제 종료 실행');
        process.exit(1);
    }, 10000);
});

process.on('SIGINT', () => {
    log('🛑 SIGINT 신호 수신 - 즉시 종료');
    
    const runtime = globalState.startTime ? Math.floor((Date.now() - globalState.startTime) / 1000) : 0;
    log('📊 최종 통계:');
    log(`   가동시간: ${formatTime(runtime)}`);
    log(`   API 호출: ${globalState.stats.apiCalls}회`);
    log(`   데이터 수집: ${globalState.stats.dataPoints}개`);
    log(`   오류: ${globalState.stats.errors}회`);
    log('✅ 김프 아비트라지 모니터 종료');
    
    process.exit(0);
});

// 예외 처리
process.on('uncaughtException', (error) => {
    log(`🚨 처리되지 않은 예외: ${error.message}`, 'ERROR');
    log(error.stack, 'ERROR');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`🚨 처리되지 않은 Promise 거부: ${reason}`, 'ERROR');
    console.error('Promise:', promise);
});

// 시간 포맷 함수
function formatTime(seconds) {
    if (seconds < 60) return `${seconds}초`;
    if (seconds < 3600) return `${Math.floor(seconds/60)}분`;
    return `${Math.floor(seconds/3600)}시간 ${Math.floor((seconds%3600)/60)}분`;
}

// 시스템 시작 실행
startSystem().catch(error => {
    log(`💥 시스템 시작 실패: ${error.message}`, 'ERROR');
    console.error(error.stack);
    process.exit(1);
});