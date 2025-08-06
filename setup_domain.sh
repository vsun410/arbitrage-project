#!/bin/bash

echo "🌐 vsun410.pe.kr 도메인 설정 시작"
echo "=================================="

# 1. Nginx 설치
echo "📦 Nginx 설치 중..."
apt update
apt install -y nginx

# 2. 방화벽 설정
echo "🔒 방화벽 설정 중..."
ufw allow 'Nginx Full'
ufw allow 80/tcp
ufw allow 443/tcp

# 3. Nginx 설정 파일 생성
echo "⚙️ Nginx 설정 파일 생성 중..."
cat > /etc/nginx/sites-available/vsun410.pe.kr << 'EOF'
server {
    listen 80;
    server_name vsun410.pe.kr www.vsun410.pe.kr;
    
    # 보안 헤더
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    
    # 메인 애플리케이션 프록시
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
    
    # 정적 파일 캐싱
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        proxy_pass http://localhost:8080;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # API 엔드포인트
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # 관리자 패널
    location /admin {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # 헬스체크
    location /health {
        proxy_pass http://localhost:8080;
        access_log off;
    }
}
EOF

# 4. 심볼릭 링크 생성 (사이트 활성화)
echo "🔗 사이트 활성화 중..."
ln -sf /etc/nginx/sites-available/vsun410.pe.kr /etc/nginx/sites-enabled/

# 5. 기본 사이트 비활성화
echo "🚫 기본 사이트 비활성화 중..."
rm -f /etc/nginx/sites-enabled/default

# 6. Nginx 설정 테스트
echo "🧪 Nginx 설정 테스트 중..."
nginx -t

if [ $? -eq 0 ]; then
    echo "✅ Nginx 설정 정상"
    
    # 7. Nginx 재시작
    echo "🔄 Nginx 재시작 중..."
    systemctl restart nginx
    systemctl enable nginx
    
    # 8. 상태 확인
    echo "📊 서비스 상태 확인..."
    systemctl status nginx --no-pager -l
    
    echo ""
    echo "🎉 도메인 설정 완료!"
    echo "=================================="
    echo "✅ http://vsun410.pe.kr - 메인 대시보드"
    echo "✅ http://vsun410.pe.kr/admin - 관리자 패널"  
    echo "✅ http://vsun410.pe.kr/health - 헬스체크"
    echo "✅ http://vsun410.pe.kr/api/market-data - API"
    echo ""
    echo "⏰ DNS 적용까지 10-30분 소요될 수 있습니다"
    echo ""
    
else
    echo "❌ Nginx 설정 오류 발생"
    nginx -t
    exit 1
fi