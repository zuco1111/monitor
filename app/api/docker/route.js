import { NextResponse } from 'next/server';
import Docker from 'dockerode';

export const dynamic = 'force-dynamic';

// Docker 连接池（复用连接）
let dockerInstance = null;
let dockerInstanceTime = 0;
const DOCKER_TTL = 60000; // 60秒复用

function getDocker() {
  const now = Date.now();
  if (!dockerInstance || (now - dockerInstanceTime) > DOCKER_TTL) {
    dockerInstance = new Docker();
    dockerInstanceTime = now;
  }
  return dockerInstance;
}

export async function GET() {
  try {
    // 使用连接池
    const docker = getDocker();

    // 获取所有容器（包括未运行的）
    const containers = await docker.listContainers({ all: true });

    // 获取容器详细信息
    const containerDetails = await Promise.all(
      containers.map(async (container) => {
        const info = docker.getContainer(container.Id);
        const inspect = await info.inspect();

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
