module.exports = {
  apps: [{
    name: 'monitor',
    script: 'npm',
    args: 'start',
    cwd: '/Volumes/SpaceShip/Projects/Monitor',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3344,
      PATH: '/Volumes/SpaceShip/NPM_Data/npm-global/bin:/opt/homebrew/bin:/usr/local/bin:' + process.env.PATH
    },
    // 健康检查 - 暂时禁用，避免启动时检查失败导致重启
    // healthcheck: {
    //   enabled: true,
    //   url: 'http://127.0.0.1:3344/api/health',
    //   timeout: 5,
    //   interval: 30,
    //   retries: 3,
    //   restart_delay: 1000
    // },
    // 日志配置 - 自动轮转
    out_file: '/Volumes/SpaceShip/Projects/Monitor/logs/out.log',
    error_file: '/Volumes/SpaceShip/Projects/Monitor/logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // PM2 Logrotate (自动安装)
    // 运行: pm2 install pm2-logrotate
    // 进程保护
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,  // 启动延迟 5 秒，避免端口占用
    wait_ready: true,
    listen_timeout: 15000
  }]
};
