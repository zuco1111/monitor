import { NextResponse } from 'next/server';

// Docker 实例缓存（按需创建，不用则销毁）
let dockerInstance = null;
let dockerInstanceTime = 0;
const DOCKER_TTL = 30000; // 30秒复用

async function getDocker() {
  const now = Date.now();
  // 如果超过 TTL 或者实例无效，重新创建
  if (!dockerInstance || (now - dockerInstanceTime) > DOCKER_TTL) {
    try {
      // 尝试销毁旧实例
      if (dockerInstance) {
        dockerInstance = null;
      }
    } catch (e) {
      // 忽略销毁错误
    }
    // 动态导入 dockerode，延迟加载避免 Turbopack 构建问题
    const Docker = (await import('dockerode')).default;
    dockerInstance = new Docker();
    dockerInstanceTime = now;
  }
  return dockerInstance;
}

// 带重试的 Docker 操作（增加延迟和限制）
async function dockerWithRetry(fn, maxRetries = 2) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // 首次失败时重置连接
      dockerInstance = null;
      dockerInstanceTime = 0;
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 300 * (i + 1))); // 递增延迟
      }
    }
  }
  throw lastError;
}

export async function GET() {
  try {
    // 使用连接池（带重试）
    const docker = await getDocker();

    // 获取所有容器（包括未运行的）
    const containers = await dockerWithRetry(() => docker.listContainers({ all: true }));

    // 获取容器详细信息（带超时和重试）
    const containerDetails = await Promise.all(
      containers.map(async (container) => {
        const info = docker.getContainer(container.Id);
        const inspect = await dockerWithRetry(() => info.inspect(), 2);

        // 计算运行时长
        const startedAt = new Date(inspect.State.StartedAt);
        const createdAt = new Date(inspect.Created);
        const uptime = inspect.State.Running 
          ? Date.now() - startedAt.getTime()
          : null;

        return {
          id: container.Id,
          name: container.Names[0]?.replace(/^\//, ''),
          image: container.Image,
          state: inspect.State.Status,
          status: container.Status,
          created: inspect.Created,
          startedAt: inspect.State.StartedAt,
          uptime: uptime,
          uptimeFormatted: formatUptime(uptime),
          ports: (container.Ports || []).map(p => ({
            privatePort: p.PrivatePort,
            publicPort: p.PublicPort,
            type: p.Type
          })),
          labels: container.Labels
        };
      })
    );

    // 按状态分组
    const running = containerDetails.filter(c => c.state === 'running');
    const exited = containerDetails.filter(c => c.state === 'exited');
    const paused = containerDetails.filter(c => c.state === 'paused');

    return NextResponse.json({
      containers: containerDetails,
      summary: {
        total: containerDetails.length,
        running: running.length,
        exited: exited.length,
        paused: paused.length
      },
      running: running,
      stopped: exited,
      paused: paused
    });
  } catch (error) {
    console.error('Docker info error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Docker information', details: error.message },
      { status: 500 }
    );
  }
}

function formatUptime(ms) {
  if (!ms) return 'N/A';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
