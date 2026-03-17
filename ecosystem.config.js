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
      PATH: '/Volumes/SpaceShip/NPM_Data/npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    },
    // 日志配置
    out_file: '/Volumes/SpaceShip/Projects/Monitor/logs/out.log',
    error_file: '/Volumes/SpaceShip/Projects/Monitor/logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // 进程保护
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    wait_ready: true,
    listen_timeout: 15000
  }]
};
