import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import * as si from 'systeminformation';
import { CronExpressionParser } from 'cron-parser';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

// ============== 缓存系统 ==============
let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 后端缓存 5 秒
let isFetching = false; // 防止并发抓取

// Token 存储路径
const TOKEN_STORAGE_FILE = path.join(os.homedir(), '.openclaw', 'token-usage.json');
const DAILY_TOKEN_FILE = path.join(os.homedir(), '.openclaw', 'daily-token.json');

function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function loadDailyTokenStorage() {
  try {
    if (fs.existsSync(DAILY_TOKEN_FILE)) {
      const data = fs.readFileSync(DAILY_TOKEN_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {}
  return { yesterdayTotal: 0, lastUpdateDate: null };
}

async function saveDailyTokenStorage(storage) {
  const tempFile = DAILY_TOKEN_FILE + '.' + randomUUID() + '.tmp';
  try {
    const dir = path.dirname(DAILY_TOKEN_FILE);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(tempFile, JSON.stringify(storage, null, 2), 'utf-8');
    await fsPromises.rename(tempFile, DAILY_TOKEN_FILE);
  } catch (e) {
    try { await fsPromises.unlink(tempFile); } catch {}
  }
}

function getFinalTokensFromSession(sessionFilePath) {
  try {
    const stats = fs.statSync(sessionFilePath);
    if (stats.size === 0) return 0;
    const readSize = Math.min(stats.size, 100 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(sessionFilePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);
    const content = buffer.toString('utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message' && obj.message?.usage?.totalTokens) {
          return obj.message.usage.totalTokens;
        }
      } catch {}
    }
    return 0;
  } catch { return 0; }
}

function loadTokenStorage() {
  try {
    if (fs.existsSync(TOKEN_STORAGE_FILE)) {
      const data = fs.readFileSync(TOKEN_STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.total === 'number' && parsed.total >= 0) {
        return parsed;
      }
    }
  } catch {}
  return { sessions: {}, total: 0, lastUpdated: null };
}

function isSessionReset(sessionsDir, sessionId) {
  try {
    const files = fs.readdirSync(sessionsDir);
    return files.some(f => f.startsWith(sessionId) && f.includes('.reset.'));
  } catch { return false; }
}

function calculateTotalTokensAllSessions() {
  const homeDir = os.homedir();
  const sessionsDir = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
  const storage = loadTokenStorage();
  let totalTokens = storage.total || 0;
  const knownSessions = storage.sessions || {};
  
  if (!fs.existsSync(sessionsDir)) return totalTokens;
  
  try {
    const files = fs.readdirSync(sessionsDir);
    const currentSessions = {};
    let hasChanges = false;
    
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(sessionsDir, file);
      const currentTokens = getFinalTokensFromSession(filePath);
      
      if (currentTokens > 0) {
        currentSessions[sessionId] = currentTokens;
        const wasReset = isSessionReset(sessionsDir, sessionId);
        
        if (!knownSessions[sessionId] || wasReset) {
          totalTokens += currentTokens;
          hasChanges = true;
        } else if (knownSessions[sessionId] !== currentTokens) {
          const diff = currentTokens - knownSessions[sessionId];
          if (diff > 0) {
            totalTokens += diff;
            hasChanges = true;
          }
        }
      }
    }
    
    if (hasChanges) {
      storage.sessions = currentSessions;
      storage.total = totalTokens;
      storage.lastUpdated = new Date().toISOString();
      fs.writeFileSync(TOKEN_STORAGE_FILE, JSON.stringify(storage, null, 2), 'utf-8');
    }
  } catch {}
  
  return totalTokens;
}

async function calculateTodayTokens() {
  const storage = loadDailyTokenStorage();
  const today = getTodayDateString();
  const currentTotal = calculateTotalTokensAllSessions();
  
  // 首次运行或跨天：更新 yesterdayTotal
  if (storage.lastUpdateDate !== today) {
    if (storage.lastUpdateDate === null) {
      // 首次运行：把当前总量设为昨日基准，今日消耗为 0
      storage.yesterdayTotal = currentTotal;
    }
    // 跨天时保持 yesterdayTotal 不变（用之前累计值）
    storage.lastUpdateDate = today;
    await saveDailyTokenStorage(storage);
  }
  
  const todayTokens = Math.max(0, currentTotal - storage.yesterdayTotal);
  return { todayTokens };
}

// ============== OpenClaw 状态抓取 ==============
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

async function fetchOpenClawStatus() {
  const [statusResult, sessionsResult, tokenResult, todayTokenResult] = await Promise.all([
    execAsync('openclaw status 2>&1', { timeout: 10000 }),
    execAsync('openclaw sessions --json', { timeout: 10000 }),
    Promise.resolve({ totalTokens: calculateTotalTokensAllSessions() }),
    calculateTodayTokens()
  ]);

  const lines = statusResult.stdout.split('\n');
  const overview = parseOverview(lines);
  const gateways = parseGatewaySection(lines);

  let sessions = [];
  try {
    const data = JSON.parse(sessionsResult.stdout);
    sessions = data.sessions || [];
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
    const { stdout } = await execAsync('openclaw cron list', { timeout: 10000 });
    const tasks = [];
    const lines = stdout.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      if (line.includes('─') || line.includes('┌') || line.includes('ID') || line.startsWith('Hint')) continue;
      if (line.startsWith('ID ')) continue;
      if (line.length < 130) continue;
      
      const id = line.substring(0, 37).trim();
      const name = line.substring(37, 62).trim();
      const schedule = line.substring(62, 95).trim();
      const status = line.substring(117, 127).trim();
      
      if (!id || id.length < 10) continue;
      
      tasks.push({ id, name, schedule, status: status === 'ok' ? '已完成' : status });
    }
    
    return { tasks, totalTasks: tasks.length };
  } catch (e) {
    return { tasks: [], totalTasks: 0, error: e.message };
  }
}

// ============== 统一数据抓取 ==============
async function fetchAllData() {
  const now = Date.now();
  
  // 检查缓存
  if (cachedData && (now - cacheTime) < CACHE_TTL) {
    return cachedData;
  }
  
  // 防止并发抓取
  if (isFetching) {
    return cachedData || { error: 'Fetching in progress', cached: true };
  }
  
  isFetching = true;
  
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
    isFetching = false;
    
    return cachedData;
  } catch (e) {
    console.error('fetchAllData error:', e);
    isFetching = false;
    return cachedData || { error: e.message };
  }
}

// ============== SSE 端点 ==============
export async function GET(request) {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // 立即发送一次数据
      const data = await fetchAllData();
      send('update', data);

      // 每 5 秒推送一次（后端缓存TTL）
      const interval = setInterval(async () => {
        try {
          const freshData = await fetchAllData();
          send('update', freshData);
        } catch (e) {
          send('error', { message: e.message });
        }
      }, 5000);

      // 心跳保持连接
      const heartbeat = setInterval(() => {
        send('ping', { time: Date.now() });
      }, 30000);

      // 清理
      request.signal.addEventListener('abort', () => {
        clearInterval(interval);
        clearInterval(heartbeat);
        controller.close();
      });
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
