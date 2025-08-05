# 김프 아비트라지 Vultr 서버 배포 가이드

## 📋 개요

이 디렉토리는 Vultr 클라우드 서버에 김프 아비트라지 모니터링 시스템을 배포하기 위한 모든 파일을 포함합니다.

## 🚀 빠른 시작

### 1. 서버 파일 업로드

```bash
# 모든 파일을 Vultr 서버에 업로드
scp -r server/* root@your-server-ip:~/kimp-arbitrage/
```

### 2. 자동 배포 실행

```bash
# 서버에 SSH 접속
ssh root@your-server-ip

# 배포 디렉토리로 이동
cd ~/kimp-arbitrage

# 배포 스크립트 실행 권한 부여
chmod +x deploy.sh

# 자동 배포 실행
./deploy.sh
```

## 📁 파일 구조

```
server/
├── app.js              # 메인 애플리케이션 (Vultr 최적화)
├── package.json        # Node.js 의존성 및 스크립트
├── ecosystem.config.js # PM2 프로세스 관리 설정
├── deploy.sh          # 자동 배포 스크립트
├── .env.example       # 환경 변수 템플릿
└── README.md          # 이 파일
```

## ⚙️ 환경 설정

### .env 파일 설정

배포 후 `.env` 파일을 수정하여 설정을 커스터마이즈할 수 있습니다:

```bash
# 환경 파일 편집
nano .env
```

주요 설정값:
- `PORT`: 서버 포트 (기본: 8080)
- `SYMBOLS`: 모니터링할 심볼 (기본: BTC,ETH,XRP)
- `DATA_INTERVAL`: 데이터 수집 간격 (기본: 15초)
- `RATE_INTERVAL`: 환율 업데이트 간격 (기본: 5분)

## 🛠️ 관리 명령어

### PM2 프로세스 관리

```bash
# 상태 확인
pm2 status

# 재시작
pm2 restart kimp-arbitrage

# 중지
pm2 stop kimp-arbitrage

# 로그 확인 (실시간)
pm2 logs kimp-arbitrage

# 로그 확인 (최근 100줄)
pm2 logs kimp-arbitrage --lines 100
```

### 시스템 모니터링

```bash
# 간단한 시스템 상태 확인
./monitor.sh

# 상세 시스템 모니터링
htop

# 네트워크 연결 상태
ss -tuln | grep 8080

# 디스크 사용량
df -h

# 메모리 사용량
free -h
```

### 서비스 관리

```bash
# Nginx 상태 확인
sudo systemctl status nginx

# Nginx 재시작
sudo systemctl restart nginx

# 방화벽 상태 확인
sudo ufw status

# 로그 확인
tail -f logs/app.log
```

## 🌐 접속 주소

배포 완료 후 다음 주소로 접속할 수 있습니다:

- **메인 대시보드**: `http://your-server-ip`
- **직접 접속**: `http://your-server-ip:8080`
- **헬스체크**: `http://your-server-ip/health`
- **API 데이터**: `http://your-server-ip/api/market-data`

## 📊 API 엔드포인트

| 엔드포인트 | 설명 | 응답 형식 |
|------------|------|-----------|
| `/health` | 시스템 헬스체크 | JSON |
| `/api/market-data` | 실시간 시장 데이터 | JSON |
| `/api/stats` | 시스템 통계 | JSON |
| `/api/logs` | 최근 로그 (100줄) | JSON |
| `/` | 웹 대시보드 | HTML |

## 💰 비용 및 성능

### 예상 운영 비용 (월간)
- **Vultr VPS (1GB)**: $5
- **트래픽**: ~1GB (무료 범위)
- **총 비용**: ~$5/월 (약 7,000원)

### 시스템 사양
- **CPU**: 1 vCPU
- **RAM**: 1GB
- **Storage**: 25GB SSD
- **Network**: 1TB/월

### 성능 특성
- **메모리 사용량**: ~200MB
- **CPU 사용량**: ~5%
- **API 호출**: 15초마다 3개 심볼
- **로그 크기**: 자동 로테이션으로 관리

## 🔒 보안 기능

### 자동 설정되는 보안 요소
- **방화벽**: UFW 자동 설정 (SSH, HTTP, HTTPS, 8080)
- **리버스 프록시**: Nginx로 보안 헤더 추가
- **프로세스 관리**: PM2로 자동 재시작
- **로그 관리**: 자동 로테이션으로 디스크 보호

### 추가 보안 설정 (권장)
```bash
# SSH 키 인증 설정
ssh-copy-id root@your-server-ip

# 패스워드 로그인 비활성화
sudo nano /etc/ssh/sshd_config
# PasswordAuthentication no

# 자동 보안 업데이트 활성화
sudo apt install unattended-upgrades
sudo dpkg-reconfigure unattended-upgrades
```

## 🔧 문제 해결

### 일반적인 문제들

#### 1. 서비스가 시작되지 않음
```bash
# 로그 확인
pm2 logs kimp-arbitrage

# 포트 충돌 확인
ss -tuln | grep 8080

# 수동 시작
node app.js
```

#### 2. 외부에서 접속이 안됨
```bash
# 방화벽 상태 확인
sudo ufw status

# 포트 열기
sudo ufw allow 8080

# Nginx 상태 확인
sudo systemctl status nginx
```

#### 3. 메모리 부족
```bash
# 메모리 사용량 확인
free -h

# PM2 프로세스 재시작
pm2 restart kimp-arbitrage

# 스왑 메모리 추가 (필요시)
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

#### 4. API 데이터가 업데이트되지 않음
```bash
# 네트워크 연결 확인
curl -I https://api.upbit.com/v1/ticker?markets=KRW-BTC

# 환율 API 확인
curl -I https://api.exchangerate-api.com/v4/latest/USD

# 로그에서 API 오류 확인
pm2 logs kimp-arbitrage | grep ERROR
```

## 📈 모니터링 및 최적화

### 성능 모니터링
```bash
# 시스템 리소스 모니터링
./monitor.sh

# PM2 실시간 모니터링
pm2 monit

# 네트워크 트래픽 모니터링
sudo nethogs

# 디스크 I/O 모니터링
sudo iotop
```

### 로그 관리
```bash
# 로그 크기 확인
du -sh logs/

# 오래된 로그 수동 정리
find logs/ -name "*.log" -mtime +7 -delete

# 로그 실시간 모니터링
tail -f logs/app.log | grep ERROR
```

## 🔄 업데이트 및 백업

### 애플리케이션 업데이트
```bash
# 새 버전 파일 업로드 후
pm2 restart kimp-arbitrage

# 또는 무중단 재로드
pm2 reload kimp-arbitrage
```

### 설정 백업
```bash
# 중요 설정 파일 백업
tar -czf backup-$(date +%Y%m%d).tar.gz .env logs/ ecosystem.config.js

# 원격 백업 (선택사항)
scp backup-*.tar.gz your-backup-server:/path/to/backup/
```

## 📞 지원 및 연락처

문제가 발생하거나 추가 지원이 필요한 경우:

1. **로그 확인**: `pm2 logs kimp-arbitrage`
2. **시스템 상태**: `./monitor.sh`
3. **헬스체크**: `curl http://localhost:8080/health`

---

**Vultr 김프 아비트라지 모니터링 시스템 v1.0**  
*안정적이고 효율적인 암호화폐 김치 프리미엄 모니터링*