#!/bin/bash

# Monitor 启动脚本
# 用法: ./start.sh [dev|start|pm2]

MODE=${1:-start}

cd "$(dirname "$0")"

case "$MODE" in
  dev)
    echo "🚀 开发模式启动..."
    npm run dev
    ;;
  start)
    echo "🚀 生产模式启动..."
    npm run build
    npm run start
    ;;
  pm2)
    echo "🚀 PM2 模式启动..."
    if ! command -v pm2 &> /dev/null; then
      echo "❌ PM2 未安装，请先运行: npm install -g pm2"
      exit 1
    fi
    pm2 start ecosystem.config.js
    pm2 save
    echo "✅ PM2 已启动 Monitor 服务"
    echo "📊 查看状态: pm2 status"
    echo "📜 查看日志: pm2 logs monitor"
    ;;
  stop)
    echo "🛑 停止 PM2..."
    pm2 stop monitor 2>/dev/null || echo "Monitor 未在运行"
    ;;
  restart)
    echo "🔄 重启 Monitor..."
    pm2 restart monitor
    ;;
  *)
    echo "用法: $0 [dev|start|pm2|stop|restart]"
    echo "  dev    - 开发模式 (热重载)"
    echo "  start  - 生产模式"
    echo "  pm2    - PM2 守护进程模式"
    echo "  stop   - 停止 PM2"
    echo "  restart- 重启 PM2"
    exit 1
    ;;
esac
