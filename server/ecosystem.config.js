// PM2 프로세스 관리 설정
module.exports = {
  apps: [{
    name: 'kimp-arbitrage',
    script: 'app.js',
    
    // 기본 설정
    instances: 1,
    exec_mode: 'cluster',
    
    // 자동 재시작 설정
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    
    // 환경 변수
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    
    // 로그 설정
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // 재시작 정책
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    
    // 성능 모니터링
    monitoring: false,
    
    // 클러스터 설정
    instance_var: 'INSTANCE_ID',
    
    // 크론 재시작 (선택사항 - 매일 새벽 4시)
    cron_restart: '0 4 * * *',
    
    // 고급 설정
    node_args: '--max-old-space-size=256', // 메모리 제한
    
    // 환경별 설정
    env_development: {
      NODE_ENV: 'development',
      PORT: 8081,
      LOG_LEVEL: 'debug'
    },
    
    env_staging: {
      NODE_ENV: 'staging',
      PORT: 8082
    },
    
    env_production: {
      NODE_ENV: 'production',
      PORT: 8080,
      LOG_LEVEL: 'info'
    }
  }]
};