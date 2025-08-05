# 김프 아비트라지 자동매매 시스템

한국과 해외 암호화폐 거래소 간의 가격 차이(김치 프리미엄)를 활용한 자동매매 시스템입니다.

## 🎯 프로젝트 개요

**김프 아비트라지 자동매매 시스템**은 Z-Score 통계 기반으로 김치 프리미엄의 극단값을 포착하여 안정적인 수익을 창출하는 자동화 트레이딩 봇입니다.

### 핵심 특징

- 📊 **Z-Score 기반 과학적 분석**: 20일 이동평균과 표준편차를 활용한 통계적 진입/청산
- 🔄 **동시 포지션 실행**: 업비트(현물)과 바이낸스(선물)에서 동시 반대 포지션
- 💰 **수익 보장 청산**: 최소 0.4% 이상 수익 확정 시에만 청산
- 🛡️ **리스크 관리**: 포지션 크기 제한, 일일 거래 한도, 손실 제한
- 📱 **실시간 알림**: Discord, Telegram을 통한 거래 알림

### 성과 목표

- **월 수익률**: 3-4% 안정적 목표
- **승률**: 85% 이상 (백테스팅 기준)
- **최대 드로우다운**: 2.3% 이하
- **운용 자본**: 4,000만원 규모

## 🏗️ 시스템 아키텍처

```
icarus/
├── kimp/                           # 메인 서비스
│   ├── main.py                     # 애플리케이션 진입점
│   ├── core_logic_engine.py        # 핵심 거래 로직
│   ├── strategies/                 # 전략 모듈
│   │   └── zscore_strategy.py      # Z-Score 전략 구현
│   ├── data_fetcher.py             # 시장 데이터 수집
│   ├── order_executor.py           # 주문 실행 시스템
│   ├── state_manager.py            # 포지션 상태 관리
│   ├── risk_manager.py             # 리스크 관리
│   ├── notification_service.py     # 알림 서비스
│   ├── database_handler.py         # 데이터베이스 처리
│   └── logging_config.py           # 로깅 시스템
├── docker-compose.yml              # 컨테이너 설정
└── .env                           # 환경 변수 설정
```

## 🚀 빠른 시작

### 1. 요구사항

- Docker & Docker Compose
- Python 3.9+
- 업비트 API 키
- 바이낸스 선물 API 키

### 2. 설치

```bash
# 저장소 클론
git clone <repository-url>
cd kimp-arbitrage

# 환경 변수 설정
cp .env.example .env
# .env 파일에서 API 키 설정

# Docker로 시스템 시작
./docker-start.sh
```

### 3. 설정

`.env` 파일에서 다음 항목들을 설정하세요:

```bash
# 거래소 API 키
UPBIT_API_KEY=your_upbit_api_key
UPBIT_SECRET_KEY=your_upbit_secret_key
BINANCE_API_KEY=your_binance_api_key
BINANCE_SECRET_KEY=your_binance_secret_key

# 알림 설정 (선택사항)
DISCORD_WEBHOOK=your_discord_webhook_url
TELEGRAM_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

## 📊 전략 상세

### Z-Score 전략 파라미터

```python
STRATEGY_CONFIG = {
    "zscore_period": 20,        # Z-Score 계산 기간 (일)
    "entry_threshold": 2.0,     # 진입 임계값
    "min_kimp_entry": 0.5,      # 최소 김프 진입 조건 (%)
    "min_profit_target": 0.4,   # 최소 수익 목표 (%)
    "max_position_size": 1333   # 최대 포지션 크기 (만원)
}
```

### 거래 로직

1. **진입 조건**:
   - Z-Score ±2.0 극단값 도달 후 회귀 시작
   - 김프 절댓값 0.5% 이상
   
2. **포지션 유형**:
   - **역프 시**: 업비트 현물 매수 + 바이낸스 선물 매도
   - **김프 시**: 업비트 현물 매도 + 바이낸스 선물 매수

3. **청산 조건**:
   - 최소 0.4% 이상 수익 + Z-Score ±0.5 이하

## 🔧 개발 환경

### 개발 도구 설치

```bash
# 개발 의존성 설치
make install-dev

# 코드 품질 검사
make lint

# 테스트 실행
make test

# 코드 포맷팅
make format
```

### 유용한 명령어

```bash
# 시스템 상태 확인
docker-compose ps

# 로그 실시간 확인
docker-compose logs -f kimp_app

# 데이터베이스 접속
docker-compose exec postgres psql -U kimp_user -d kimp_arbitrage

# 시스템 재시작
docker-compose restart
```

## 📈 모니터링

### 로그 파일

- `logs/kimp_arbitrage.log`: 전체 시스템 로그
- `logs/trades.log`: 거래 전용 로그
- `logs/error.log`: 에러 전용 로그

### 주요 지표

- 일일 거래 횟수: 8-10회 목표
- 평균 보유 시간: 2-6시간
- 실시간 수익률 추적

## ⚠️ 리스크 관리

### 안전장치

- **포지션 크기 제한**: 종목당 최대 1,333만원
- **일일 거래 제한**: 최대 10회
- **총 포지션 제한**: 최대 4,000만원
- **손절 없음**: 아비트라지 특성상 시간이 지나면 수렴

### 보안 설정

- API 키 암호화 저장
- 환경 변수를 통한 민감 정보 관리
- 화이트리스트 IP 설정 권장

## 🤝 기여하기

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 라이선스

이 프로젝트는 MIT 라이선스 하에 배포됩니다. 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

## ⚡ 면책 조항

이 소프트웨어는 교육 및 연구 목적으로 제공됩니다. 암호화폐 거래는 높은 위험을 수반하며, 투자 손실에 대한 책임은 사용자에게 있습니다. 실제 거래 전에 충분한 테스트와 검증을 권장합니다.

---

**주의**: API 키는 절대 공개하지 마세요. `.env` 파일을 Git에 커밋하지 않도록 주의하세요.