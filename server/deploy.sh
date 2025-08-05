#!/bin/bash

# Vultr 서버 김프 아비트라지 시스템 자동 배포 스크립트
# 사용법: ./deploy.sh

set -e  # 오류 발생시 스크립트 중단

echo "🌟 Vultr 김프 아비트라지 시스템 배포 시작"
echo "==============================================" 

# 현재 시간 로깅
echo "📅 배포 시작 시간: $(date)"

# 1. 시스템 업데이트
echo ""
echo "📦 시스템 패키지 업데이트 중..."
sudo apt update -y
sudo apt upgrade -y

# 2. Node.js 설치 (최신 LTS)
echo ""
echo "📦 Node.js 설치 중..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "✅ Node.js가 이미 설치되어 있습니다: $(node --version)"
fi

# 3. 필수 도구 설치
echo ""
echo "📦 필수 패키지 설치 중..."
sudo apt install -y git htop curl wget unzip nginx certbot python3-certbot-nginx

# 4. PM2 설치 (프로세스 관리자)
echo ""
echo "📦 PM2 설치 중..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
    pm2 startup
else
    echo "✅ PM2가 이미 설치되어 있습니다: $(pm2 --version)"
fi

# 5. 프로젝트 디렉토리 생성
echo ""
echo "📁 프로젝트 디렉토리 설정..."
PROJECT_DIR="$HOME/kimp-arbitrage"
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

# 6. 로그 디렉토리 생성
mkdir -p logs

# 7. 환경 설정 파일 생성
echo ""
echo "⚙️ 환경 설정 파일 생성..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "📝 .env 파일이 생성되었습니다. 필요시 수정하세요."
else
    echo "✅ .env 파일이 이미 존재합니다."
fi

# 8. 방화벽 설정
echo ""
echo "🔥 방화벽 설정 중..."
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP
sudo ufw allow 443/tcp     # HTTPS
sudo ufw allow 8080/tcp    # 애플리케이션
sudo ufw --force enable

# 9. Nginx 설정 (리버스 프록시)
echo ""
echo "🌐 Nginx 설정 중..."
sudo tee /etc/nginx/sites-available/kimp-arbitrage > /dev/null <<EOF
server {
    listen 80;
    server_name _;
    
    # 보안 헤더
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    
    # 압축 설정
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
    
    # 메인 애플리케이션 프록시
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # 타임아웃 설정
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # 헬스체크 캐싱 제외
    location /health {
        proxy_pass http://localhost:8080;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
    
    # 정적 파일 캐싱
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        proxy_pass http://localhost:8080;
    }
}
EOF

# Nginx 사이트 활성화
sudo ln -sf /etc/nginx/sites-available/kimp-arbitrage /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

# 10. PM2로 애플리케이션 시작
echo ""
echo "🚀 애플리케이션 시작 중..."

# 기존 프로세스 중지 (있다면)
pm2 delete kimp-arbitrage 2>/dev/null || true

# 새 프로세스 시작
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup

# 11. 시스템 모니터링 도구 설치 (선택사항)
echo ""
echo "📊 모니터링 도구 설정 중..."

# htop 설정
sudo apt install -y htop iotop nethogs

# 간단한 시스템 모니터링 스크립트
cat > monitor.sh << 'EOF'
#!/bin/bash
echo "🖥️ 시스템 리소스 모니터링"
echo "============================"
echo "💾 메모리 사용량:"
free -h
echo ""
echo "💿 디스크 사용량:"
df -h
echo ""
echo "🔥 CPU 사용량 (top 5 프로세스):"
ps aux --sort=-%cpu | head -6
echo ""
echo "📊 PM2 프로세스 상태:"
pm2 status
echo ""
echo "🌐 네트워크 연결:"
ss -tuln | grep :8080
EOF

chmod +x monitor.sh

# 12. 로그 로테이션 설정
echo ""
echo "📝 로그 로테이션 설정 중..."
sudo tee /etc/logrotate.d/kimp-arbitrage > /dev/null <<EOF
$PROJECT_DIR/logs/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    sharedscripts
    postrotate
        pm2 reload kimp-arbitrage
    endscript
}
EOF

# 13. 자동 업데이트 크론잡 설정 (선택사항)
echo ""
echo "⏰ 자동 재시작 크론잡 설정 중..."
(crontab -l 2>/dev/null; echo "0 4 * * * cd $PROJECT_DIR && pm2 restart kimp-arbitrage") | crontab -

# 14. 최종 상태 확인
echo ""
echo "✅ 배포 완료! 서비스 상태 확인 중..."
sleep 5

# 서비스 상태 확인
echo ""
echo "📊 최종 상태 점검:"
echo "==================="

# Node.js 버전
echo "Node.js: $(node --version)"

# PM2 상태
echo "PM2 프로세스:"
pm2 status

# 네트워크 포트 확인
echo ""
echo "포트 바인딩 상태:"
ss -tuln | grep -E ':(80|443|8080)'

# 애플리케이션 헬스체크
echo ""
echo "애플리케이션 헬스체크:"
sleep 2
if curl -s http://localhost:8080/health > /dev/null; then
    echo "✅ 애플리케이션이 정상적으로 실행 중입니다"
else
    echo "❌ 애플리케이션 연결 실패"
fi

# 외부 IP 확인
EXTERNAL_IP=$(curl -s ifconfig.me 2>/dev/null || echo "IP확인실패")

# 15. 배포 완료 메시지
echo ""
echo "=============================================="
echo "🎉 Vultr 김프 아비트라지 시스템 배포 완료!"
echo "=============================================="
echo "📅 배포 완료 시간: $(date)"
echo ""
echo "🌐 접속 주소:"
echo "   HTTP:  http://$EXTERNAL_IP"
echo "   HTTPS: https://$EXTERNAL_IP (SSL 설정 시)"
echo "   앱 직접: http://$EXTERNAL_IP:8080"
echo ""
echo "🔍 주요 엔드포인트:"
echo "   헬스체크: /health"
echo "   대시보드: /"
echo "   시장데이터: /api/market-data"
echo "   통계: /api/stats"
echo ""
echo "🛠️ 관리 명령어:"
echo "   상태확인: pm2 status"
echo "   재시작: pm2 restart kimp-arbitrage"
echo "   로그확인: pm2 logs kimp-arbitrage"
echo "   모니터링: ./monitor.sh"
echo ""
echo "💰 예상 운영비용:"
echo "   Vultr VPS: $5/월 (1GB RAM)"
echo "   트래픽: ~1GB/월 (무료 범위)"
echo "   총 비용: ~$5/월 (약 7,000원)"
echo ""
echo "📈 시스템 사양:"
echo "   CPU: 1 vCPU"
echo "   RAM: 1GB"
echo "   Storage: 25GB SSD"
echo "   Network: 1TB/월"
echo ""
echo "🔒 보안 기능:"
echo "   ✅ UFW 방화벽 활성화"
echo "   ✅ Nginx 리버스 프록시"
echo "   ✅ 자동 로그 로테이션"
echo "   ✅ PM2 프로세스 관리"
echo ""
echo "📞 문제 해결:"
echo "   1. 서비스 중단: pm2 restart kimp-arbitrage"
echo "   2. 로그 확인: pm2 logs --lines 100"
echo "   3. 시스템 상태: ./monitor.sh"
echo "   4. Nginx 상태: sudo systemctl status nginx"
echo "=============================================="

# 최종 성공 상태 코드 반환
exit 0