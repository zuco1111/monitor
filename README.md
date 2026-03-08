# 🖥️ 系统监控面板 (Monitor)

一个基于 Next.js + shadcn/ui 的系统监控面板，用于监控本地系统状态、Docker 容器和 OpenClaw 运行情况。

![Dashboard](https://img.shields.io/badge/Next.js-16-black) ![React](https://img.shields.io/badge/React-19-blue) ![shadcn/ui](https://img.shields.io/badge/shadcn/ui-latest-white)

## ✨ 功能特性

- **系统监控**：CPU、内存、硬盘使用情况
- **Docker 监控**：容器状态、运行时长、端口映射
- **OpenClaw 监控**：会话管理、Token 消耗统计、定时任务
- **实时日志**：OpenClaw 运行日志
- **主题切换**：支持浅色/深色/跟随系统
- **自动刷新**：每 5 秒自动更新数据

## 🖱️ 演示

![Monitor Dashboard](https://via.placeholder.com/800x400?text=Monitor+Dashboard)

## 📋 环境要求

- **Node.js** >= 18.0
- **macOS** / Linux (Windows WSL2 也可运行)
- **OpenClaw** 已安装并运行（用于监控）
- **Docker** 已安装（用于容器监控，可选）

## 🚀 安装教程

### 1. 克隆项目

```bash
git clone <your-repo>/monitor.git
cd monitor
```

### 2. 安装 Node.js 依赖

```bash
npm install
```

### 3. 安装系统依赖（可选）

#### macOS

```bash
# 安装 Docker（可选，用于容器监控）
brew install --cask docker

# 安装 osx-cpu-temp（仅 Intel Mac，用于 CPU 温度监控）
# 注意：Apple Silicon (M1/M2/M3) 不支持此工具
brew install osx-cpu-temp
```

#### Linux (Ubuntu/Debian)

```bash
# 安装 Docker
sudo apt install docker.io
sudo systemctl start docker
sudo systemctl enable docker

# 安装 lm-sensors（用于 CPU 温度监控）
sudo apt install lm-sensors
```

### 4. 配置 OpenClaw

确保 OpenClaw 已安装并运行在默认端口（默认 `http://127.0.0.1:18789`）。

```bash
# 检查 OpenClaw 状态
openclaw status
```

### 5. 启动监控面板

```bash
# 开发模式（默认端口 3344）
npm run dev

# 生产构建
npm run build
npm start
```

### 6. 访问面板

打开浏览器访问：http://localhost:3344

## ⚙️ 配置说明

### 修改端口

在 `package.json` 中修改：

```json
{
  "scripts": {
    "dev": "next dev -p <端口号>"
  }
}
```

### 修改刷新间隔

编辑 `app/page.js`，找到：

```javascript
const interval = setInterval(fetchData, 5000); // 5000ms = 5秒
```

### 主题设置

支持三种主题模式：
- `light`：浅色模式
- `dark`：深色模式
- `system`：跟随系统设置

点击标题栏的太阳/月亮图标切换主题。

## 📁 项目结构

```
monitor/
├── app/
│   ├── api/
│   │   ├── docker/          # Docker 容器 API
│   │   ├── openclaw/        # OpenClaw 相关 API
│   │   │   ├── conversations/
│   │   │   ├── logs/
│   │   │   ├── tasks/
│   │   │   └── route.js
│   │   └── system/          # 系统信息 API
│   ├── page.js              # 主页面
│   └── layout.js            # 布局
├── components/              # UI 组件
├── lib/                     # 工具函数
├── public/                  # 静态资源
├── package.json
└── README.md
```

## 🔧 常见问题

### Q: 温度显示 N/A？

**原因**：Apple Silicon (M1/M2/M3) Mac 无法通过常规方式获取 CPU 温度。

**解决方案**：
1. Intel Mac：安装 `osx-cpu-temp` 后重启面板
   ```bash
   brew install osx-cpu-temp
   ```

2. M 系列 Mac：可尝试安装 iStats（需要 Ruby）
   ```bash
   sudo gem install iStats
   ```
   然后重启面板。

### Q: Docker 容器显示失败？

**原因**：Docker 服务未启动或无权限。

**解决方案**：
```bash
# 启动 Docker
open -a Docker

# 或者
sudo systemctl start docker
```

### Q: Token 消耗数据不准确？

**原因**：首次运行需要时间计算历史 Token。

**说明**：系统会自动从所有 session 文件中统计 Token 消耗，并在 `~/.openclaw/token-usage.json` 中持久化存储。

### Q: 页面加载很慢？

**原因**：首次加载需要执行多个系统命令。

**说明**：已添加 5 秒缓存，后续请求会很快。如果仍有问题，检查 `openclaw status` 命令响应时间。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
