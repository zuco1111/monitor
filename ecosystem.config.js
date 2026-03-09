module.exports = {
  apps: [{
    name: 'monitor',
    script: 'npm',
    args: 'start',
    cwd: '/Volumes/SpaceShip/Monitor',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3344
    },
    // 健康检查
    healthcheck: {
      enabled: true,
      url: 'http://127.0.0.1:3344/api/health',
      timeout: 5,
      interval: 30,
      retries: 3,
      restart_delay: 1000
    },
    // 日志配置
    out_file: '/tmp/monitor-out.log',
    error_file: '/tmp/monitor-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // 进程保护
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 1000
  }]
};
