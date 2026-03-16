import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as si from 'systeminformation';
import { CronExpressionParser } from 'cron-parser';

const execAsync = promisify(exec);
const OPENCLAW_BIN = '/Volumes/SpaceShip/NPM_Data/npm-global/bin/openclaw';

export const dynamic = 'force-dynamic';

// 计算 cron 表达式的下次执行时间
function calculateNextRun(schedule) {
  if (!schedule) return null;
  
  try {
    // 移除 "cron " 前缀
    let cronExpr = schedule.replace(/^cron\s+/, '').replace(/\s*@.*$/, '').replace(/\s*\(exact\)/, '');
    
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(),
      tz: 'Asia/Shanghai'
    });
    
    const next = interval.next();
    // toDate() 返回 UTC 时间戳，在上海时区的服务器上用 getHours() 直接获取本地时间
    const utcDate = next.toDate();
    
    const month = String(utcDate.getMonth() + 1).padStart(2, '0');
    const day = String(utcDate.getDate()).padStart(2, '0');
    const hour = String(utcDate.getHours()).padStart(2, '0');
    const minute = String(utcDate.getMinutes()).padStart(2, '0');
    
    return `${month}-${day} ${hour}:${minute}`;
  } catch (e) {
    console.error('Failed to parse cron:', e);
    return null;
  }
}

// 导入共享的 Token 计算模块
import {
  calculateTotalTokensAllSessions,
  calculateTodayTokens,
  getTodayDateString,
  getYesterdayDateString
} from '../token-utils';

// ============== 解析函数 ==============
function parseOverview(lines) {
  const overview = {};
  let inOverview = false;
  let currentKey = null;

  for (const line of lines) {
    if (line.includes('│ Item') && line.includes('│ Value')) {
      inOverview = true;
      continue;
    }
    if (inOverview && line.includes('└─────────────────┴─')) break;
    if (inOverview && line.includes('├─────────────────┼─')) continue;

    if (inOverview && line.includes('│')) {
      const match = line.match(/│\s*(.*?)\s*│\s*(.*?)\s*│$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!key && currentKey && value) {
          overview[currentKey] += ' ' + value;
        } else if (key && key !== 'Item' && key !== 'Value' && !key.includes('─')) {
          currentKey = key;
          overview[key] = value;
        }
      }
    }
  }
  return overview;
}

function parseGatewaySection(lines) {
  const gateways = [];
  let inSection = false;

  for (const line of lines) {
    if (line.includes('┌──────────┬─────────┬────────┬─')) {
      inSection = true;
      continue;
    }
    if (inSection && line.includes('└──────────┴─────────┴────────┴─')) break;
    if (inSection && line.includes('│')) {
      const parts = line.split('│').map(p => p.trim()).filter(p => p);
      if (parts.length >= 4 && parts[0] && parts[0] !== 'Channel') {
        if (!gateways.find(g => g.name === parts[0])) {
          gateways.push({
            name: parts[0],
            enabled: parts[1] === 'ON',
            status: parts[2],
            details: parts[3] || ''
          });
        }
      }
    }
  }
  return gateways;
}

// ============== OpenClaw 状态抓取 ==============
async function fetchOpenClawStatus() {
  const [statusResult, sessionsResult, tokenResult, todayTokenResult] = await Promise.all([
    execAsync(`${OPENCLAW_BIN} status 2>&1`, { timeout: 10000 }),
    execAsync(`${OPENCLAW_BIN} sessions --all-agents --json`, { timeout: 10000 }),
    Promise.resolve({ totalTokens: calculateTotalTokensAllSessions() }),
    calculateTodayTokens()
  ]);

  const lines = statusResult.stdout.split('\n');
  const overview = parseOverview(lines);
  const gateways = parseGatewaySection(lines);

  let sessions = [];
  try {
    // openclaw 输出可能包含调试日志，需要提取 JSON 部分
    let jsonStr = '';
    let inJson = false;
    let braceCount = 0;

    for (const char of sessionsResult.stdout) {
      if (char === '{') {
        inJson = true;
        braceCount = 1;
      }
      if (inJson) {
        jsonStr += char;
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (braceCount === 0) break;
      }
    }

    if (jsonStr) {
      const data = JSON.parse(jsonStr);
      sessions = data.sessions || [];
    }
  } catch {}

  const activeGateways = gateways.filter(g => g.enabled && g.status === 'OK');

  return {
    gateways: gateways.filter(g => g.name && g.name !== 'default' && g.name !== 'Account'),
    sessions: sessions,
    sessionCount: sessions.filter(s => s.key?.includes('main')).length,
    runningGateways: activeGateways.length,
    totalGateways: gateways.filter(g => g.enabled).length,
    healthy: activeGateways.length > 0,
    overview,
    agentCount: parseInt((overview['Agents'] || '').match(/^(\d+)/)?.[1] || '0'),
    totalTokens: tokenResult.totalTokens,
    todayTokens: todayTokenResult.todayTokens,
    contextTokens: sessions[0]?.contextTokens || 200000,
    model: sessions[0]?.model || 'N/A',
    heartbeat: overview['Heartbeat'] || '',
    memory: overview['Memory'] || '',
    gatewayReachable: (overview['Gateway'] || '').includes('reachable'),
    gatewayLatency: (overview['Gateway'] || '').match(/reachable\s+(\d+)ms/)?.[1] + 'ms' || 'N/A',
    dashboard: overview['Dashboard'] || 'N/A'
  };
}

// ============== System 状态抓取 ==============
async function fetchSystemStatus() {
  const tryCommand = async (cmd, timeout = 3000) => {
    try {
      const { stdout } = await execAsync(cmd, { timeout });
      return stdout.trim();
    } catch { return null; }
  };

  const getCPUTemperature = async () => {
    const osxTemp = await tryCommand('osx-cpu-temp');
    if (osxTemp) {
      const temp = parseFloat(osxTemp.replace('°C', '').trim());
      if (!isNaN(temp) && temp > 10 && temp < 150) return temp;
    }
    try {
      const temps = await si.cpuTemperature();
      if (temps.main && temps.main > 10 && temps.main < 150) return temps.main;
    } catch {}
    return null;
  };

  const [cpu, cpuInfo, mem, disks, cpuTemp] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.cpu().catch(() => ({})),
    si.mem().catch(() => null),
    si.fsSize().catch(() => []),
    getCPUTemperature()
  ]);

  const systemVolumes = [
    '/System/Volumes/VM', '/System/Volumes/Preboot', '/System/Volumes/Update',
    '/System/Volumes/xarts', '/System/Volumes/iSCPreboot', '/System/Volumes/Hardware',
    '/System/Volumes/Data', '/Volumes/SpaceShip'
  ];

  const internalDisks = disks.filter(d => d.mount === '/' || d.mount === '/System/Volumes/Data');
  const externalDisks = disks.filter(d => !internalDisks.includes(d) && !systemVolumes.includes(d.mount));
  const mainDisk = internalDisks[0] || {};

  return {
    cpu: {
      load: cpu?.currentLoad || 0,
      cores: (cpu?.cpus || []).map(c => c.load),
      brand: cpuInfo.brand,
      physicalCores: cpuInfo.physicalCores
    },
    memory: {
      used: mem?.used || 0,
      total: mem?.total || 1,
      usedPercent: mem?.total ? (mem.used / mem.total) * 100 : 0,
      free: mem?.free || 0,
      available: mem?.available || 0
    },
    disks: {
      internal: internalDisks.map(d => ({
        mount: d.mount,
        usedPercent: d.use,
        used: d.used,
        total: d.size,
        available: d.available
      })),
      external: externalDisks.map(d => ({
        mount: d.mount,
        usedPercent: d.use,
        used: d.used,
        total: d.size,
        available: d.available
      }))
    },
    mainDisk: {
      mount: mainDisk.mount || '/',
      usedPercent: mainDisk.use || 0,
      used: mainDisk.used,
      total: mainDisk.size,
      available: mainDisk.available
    },
    temperature: { cpu: cpuTemp }
  };
}

// ============== Docker 状态抓取 ==============
async function fetchDockerStatus() {
  try {
    const Docker = (await import('dockerode')).default;
    const docker = new Docker();
    const containers = await docker.listContainers({ all: true });

    const containerDetails = await Promise.all(
      containers.map(async (container) => {
        const info = docker.getContainer(container.Id);
        const inspect = await info.inspect();
        const startedAt = new Date(inspect.State.StartedAt);
        const uptime = inspect.State.Running ? Date.now() - startedAt.getTime() : null;

        return {
          id: container.Id,
          name: container.Names[0]?.replace(/^\//, ''),
          image: container.Image,
          state: inspect.State.Status,
          status: container.Status,
          uptime: uptime,
          uptimeFormatted: formatUptime(uptime),
          ports: (container.Ports || []).map(p => ({
            privatePort: p.PrivatePort,
            publicPort: p.PublicPort,
            type: p.Type
          }))
        };
      })
    );

    const running = containerDetails.filter(c => c.state === 'running');
    const exited = containerDetails.filter(c => c.state === 'exited');

    return {
      containers: containerDetails,
      summary: {
        total: containerDetails.length,
        running: running.length,
        stopped: exited.length
      }
    };
  } catch (e) {
    return { error: e.message, summary: { total: 0, running: 0, stopped: 0 } };
  }
}

function formatUptime(ms) {
  if (!ms) return 'N/A';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ============== Cron 任务抓取 ==============
async function fetchCronTasks() {
  try {
    const { stdout } = await execAsync(`${OPENCLAW_BIN} cron list`, { timeout: 10000 });
    const tasks = [];
    const lines = stdout.split('\n').filter(l => l.trim());

    for (const line of lines) {
      if (line.includes('─') || line.includes('┌') || line.includes('ID') || line.startsWith('Hint')) continue;
      if (line.startsWith('ID ')) continue;
      if (line.length < 130) continue;

      const id = line.substring(0, 37).trim();
      const name = line.substring(37, 62).trim();
      const schedule = line.substring(62, 95).trim();
      const nextRun = line.substring(95, 106).trim();
      const lastRun = line.substring(106, 117).trim();
      const status = line.substring(117, 127).trim();

      // 过滤掉非任务的行（插件日志、测试行等）
      if (!id || id.length < 36 || id.includes('$') || id.includes('zuco') || id.includes('[') || id.includes('plugins')) continue;

      // 验证 id 格式（UUID 应该是 36 位）
      if (!id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) continue;

      // 格式化时间 mm-dd hh-mm（使用上海时区）
      // 获取当前上海时区时间 - 服务器本身就是上海时区，直接用 new Date() 即可
      const getShanghaiNow = () => new Date();

      const formatTime = (timeStr) => {
        if (!timeStr || timeStr === '-') return 'N/A';

        // "in 14m" 格式（下次执行时间）
        const inMatch = timeStr.match(/^in\s+(\d+)([dhms])$/);
        if (inMatch) {
          const now = getShanghaiNow();
          const value = parseInt(inMatch[1]);
          const unit = inMatch[2];
          switch (unit) {
            case 'd': now.setDate(now.getDate() + value); break;
            case 'h': now.setHours(now.getHours() + value); break;
            case 'm': now.setMinutes(now.getMinutes() + value); break;
            case 's': now.setSeconds(now.getSeconds() + value); break;
          }
          const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          });
          return formatter.format(now).replace(/\//g, '-');
        }

        // "5d ago" 格式（上次执行时间）
        const agoMatch = timeStr.match(/(\d+)\s*([dhms])\s*ago/);
        if (agoMatch) {
          const now = getShanghaiNow();
          const value = parseInt(agoMatch[1]);
          const unit = agoMatch[2];
          switch (unit) {
            case 'd': now.setDate(now.getDate() - value); break;
            case 'h': now.setHours(now.getHours() - value); break;
            case 'm': now.setMinutes(now.getMinutes() - value); break;
            case 's': now.setSeconds(now.getSeconds() - value); break;
          }
          const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          });
          return formatter.format(now).replace(/\//g, '-');
        }

        // 如果已经是具体日期时间格式 (YYYY-MM-DD HH:mm)
        if (timeStr.match(/^\d{4}-\d{2}-\d{2}/)) {
          const date = new Date(timeStr);
          const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          });
          return formatter.format(date).replace(/\//g, '-');
        }

        return timeStr;
      };

      // 使用 cron-parser 计算准确的下次执行时间
      const calculatedNextRun = calculateNextRun(schedule);

      tasks.push({
        id,
        name,
        schedule,
        nextRun: calculatedNextRun || formatTime(nextRun),
        lastRun: formatTime(lastRun),
        status: status === 'ok' ? '已完成' : status
      });
    }

    const enabledTasks = tasks.filter(t => t.status === '已完成' || t.status === 'running').length;

    return { tasks, totalTasks: tasks.length, enabledTasks };
  } catch (e) {
    return { tasks: [], totalTasks: 0, enabledTasks: 0, error: e.message };
  }
}

// ============== 统一数据抓取 ==============
// ============== 缓存系统 ==============
let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 后端缓存 5 秒

// P1 修复：使用 Promise 锁防止并发抓取
let fetchPromise = null;
let fetchResolve = null;

async function fetchAllData() {
  const now = Date.now();

  // 检查缓存
  if (cachedData && (now - cacheTime) < CACHE_TTL) {
    return cachedData;
  }

  // P1 修复：防止并发抓取 - 使用 Promise 锁
  if (fetchPromise) {
    // 已有请求在进行中，等待它完成
    await fetchPromise;
    return cachedData || { error: 'Fetching in progress', cached: true };
  }

  // 创建新的锁
  let releaseLock = null;
  fetchPromise = new Promise((resolve) => {
    releaseLock = resolve;
  });

  try {
    const [openclaw, system, docker, cron] = await Promise.all([
      fetchOpenClawStatus(),
      fetchSystemStatus(),
      fetchDockerStatus(),
      fetchCronTasks()
    ]);

    cachedData = {
      openclaw,
      system,
      docker,
      cron,
      timestamp: now
    };
    cacheTime = now;

    return cachedData;
  } catch (e) {
    console.error('fetchAllData error:', e);
    return cachedData || { error: e.message };
  } finally {
    // 释放锁
    fetchPromise = null;
    if (releaseLock) releaseLock();
  }
}

// ============== SSE 端点 ==============
export async function GET(request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // P0 修复：添加连接状态追踪
      let isClientConnected = true;

      const send = (event, data) => {
        // P0 修复：检查客户端是否仍然连接
        if (!isClientConnected) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (e) {
          // 客户端已断开，标记并停止发送
          isClientConnected = false;
        }
      };

      // 立即发送一次数据
      const data = await fetchAllData();
      send('update', data);

      // P0 修复：每 5 秒推送一次，添加连接状态检测
      const interval = setInterval(async () => {
        if (!isClientConnected) {
          clearInterval(interval);
          clearInterval(heartbeat);
          return;
        }
        try {
          const freshData = await fetchAllData();
          send('update', freshData);
        } catch (e) {
          send('error', { message: e.message });
        }
      }, 5000);

      // P0 修复：心跳保持连接
      const heartbeat = setInterval(() => {
        send('ping', { time: Date.now() });
      }, 30000);

      // P0 修复：清理函数
      const cleanup = () => {
        isClientConnected = false;
        clearInterval(interval);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch (e) {
          // 可能已经关闭
        }
      };

      // 监听连接断开
      request.signal.addEventListener('abort', cleanup);
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
