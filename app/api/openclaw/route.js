import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

// Token 持久化存储文件路径
const TOKEN_STORAGE_FILE = path.join(os.homedir(), '.openclaw', 'token-usage.json');
const TOKEN_LOCK_FILE = path.join(os.homedir(), '.openclaw', 'token-usage.lock');

// 简单内存缓存
let cachedResult = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 5秒缓存

// 从 session 文件中提取最终的 token 消耗（取最后一条消息的 totalTokens）
function getFinalTokensFromSession(sessionFilePath) {
  try {
    const stats = fs.statSync(sessionFilePath);
    if (stats.size === 0) return 0;
    
    // 读取文件最后 100KB 来获取最新的 usage
    const readSize = Math.min(stats.size, 100 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(sessionFilePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);
    
    const content = buffer.toString('utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    // 从最后往前找，最后一个包含 usage.totalTokens 的 message 就是最终值
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message' && obj.message?.usage?.totalTokens) {
          return obj.message.usage.totalTokens;
        }
      } catch (e) {
        // 跳过解析失败的行
      }
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// 加载已保存的 token 记录
function loadTokenStorage() {
  try {
    if (fs.existsSync(TOKEN_STORAGE_FILE)) {
      const data = fs.readFileSync(TOKEN_STORAGE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error loading token storage:', e);
  }
  return { sessions: {}, total: 0, lastUpdated: null };
}

// 简单的文件锁实现（防止并发写入）
function acquireLock(maxWaitMs = 2000) {
  const startTime = Date.now();
  while (true) {
    try {
      // 尝试创建锁文件
      fs.writeFileSync(TOKEN_LOCK_FILE, String(process.pid));
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') {
        // 锁已存在，检查是否过期（超过10秒）
        try {
          const stats = fs.statSync(TOKEN_LOCK_FILE);
          if (Date.now() - stats.mtimeMs > 10000) {
            // 锁过期，强制删除
            fs.unlinkSync(TOKEN_LOCK_FILE);
            continue;
          }
        } catch {
          // 忽略，继续等待
        }
        
        if (Date.now() - startTime > maxWaitMs) {
          return false; // 等待超时
        }
        // 等待一小段时间后重试
        const waitStart = Date.now();
        while (Date.now() - waitStart < 50) {
          // busy wait
        }
        continue;
      }
      return false;
    }
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(TOKEN_LOCK_FILE)) {
      fs.unlinkSync(TOKEN_LOCK_FILE);
    }
  } catch (e) {
    // 忽略解锁错误
  }
}

// 保存 token 记录（带锁）
function saveTokenStorage(storage) {
  if (!acquireLock()) {
    console.warn('Failed to acquire lock for token storage');
    return;
  }
  try {
    const dir = path.dirname(TOKEN_STORAGE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TOKEN_STORAGE_FILE, JSON.stringify(storage, null, 2));
  } catch (e) {
    console.error('Error saving token storage:', e);
  } finally {
    releaseLock();
  }
}

// 快速获取缓存的 token（用于主流程，不阻塞）
function getCachedTokens() {
  const storage = loadTokenStorage();
  return storage.total || 0;
}

// 后台更新 token 缓存（异步，不阻塞响应）
function updateTokenCacheInBackground() {
  setImmediate(() => {
    try {
      calculateTotalTokensAllSessionsInternal();
    } catch (e) {
      console.error('Background token update failed:', e);
    }
  });
}

// 实际计算 token 的逻辑
function calculateTotalTokensAllSessionsInternal() {
  const homeDir = os.homedir();
  const sessionsDir = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
  
  const storage = loadTokenStorage();
  let totalTokens = storage.total || 0;
  const knownSessions = storage.sessions || {};
  
  if (!fs.existsSync(sessionsDir)) {
    return;
  }
  
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
        
        if (!knownSessions[sessionId]) {
          const added = currentTokens;
          totalTokens += added;
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
    
    if (hasChanges || Object.keys(currentSessions).length !== Object.keys(knownSessions).length) {
      storage.sessions = currentSessions;
      storage.total = totalTokens;
      storage.lastUpdated = new Date().toISOString();
      saveTokenStorage(storage);
    }
    
  } catch (e) {
    console.error('Error calculating total tokens:', e);
  }
}

// 主流程调用的函数：快速返回缓存，后台更新
function calculateTotalTokensAllSessions() {
  // 先返回缓存的值（快速）
  const cached = getCachedTokens();
  // 然后在后台更新缓存
  updateTokenCacheInBackground();
  return { totalTokens: cached, totalInputTokens: 0, totalOutputTokens: 0 };
}

// 解析 Overview 部分的关键信息（支持多行值）
function parseOverview(lines) {
  const overview = {};
  let inOverview = false;
  let currentKey = null;
  
  for (const line of lines) {
    // 开始 Overview 部分 - 找到表头
    if (line.includes('│ Item') && line.includes('│ Value')) {
      inOverview = true;
      continue;
    }
    // 结束 Overview 部分 - 找到结束边框
    if (inOverview && line.includes('└─────────────────┴─')) {
      break;
    }
    
    // 跳过表头分隔线
    if (line.includes('├─────────────────┼─')) {
      continue;
    }
    
    if (inOverview && line.includes('│')) {
      const match = line.match(/│\s*(.*?)\s*│\s*(.*?)\s*│$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        
        // 如果 key 为空，说明是上一行的延续
        if (!key && currentKey && value) {
          overview[currentKey] += ' ' + value;
        } else if (key && key !== 'Item' && key !== 'Value' && !key.includes('─')) {
          // 新的一行
          currentKey = key;
          overview[key] = value;
        }
      }
    }
  }
  
  return overview;
}

// 解析 Gateway 状态表格
function parseGatewaySection(lines) {
  const gateways = [];
  let inSection = false;
  
  for (const line of lines) {
    if (line.includes('┌──────────┬─────────┬────────┬─')) {
      inSection = true;
      continue;
    }
    if (inSection && line.includes('└──────────┴─────────┴────────┴─')) {
      break;
    }
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

export async function GET() {
  try {
    // 检查缓存（5秒内重复请求直接返回缓存）
    const now = Date.now();
    if (cachedResult && (now - cacheTime) < CACHE_TTL) {
      return NextResponse.json(cachedResult);
    }

    // 并行执行所有耗时的命令和计算
    const [statusResult, sessionsResult, tokenResult] = await Promise.all([
      // 1. openclaw status
      execAsync('openclaw status 2>&1', { timeout: 10000 }),
      // 2. openclaw sessions --json
      execAsync('openclaw sessions --json', { timeout: 10000 }),
      // 3. token 计算（已在函数内部缓存，结果会写入文件）
      Promise.resolve(calculateTotalTokensAllSessions())
    ]);

    const { stdout } = statusResult;
    const { stdout: sessionsOutput } = sessionsResult;
    const allTokens = tokenResult;

    const lines = stdout.split('\n');
    
    // 解析 Overview
    const overview = parseOverview(lines);
    
    // 解析 Gateway 状态
    const gateways = parseGatewaySection(lines);

    // 解析 Sessions
    let sessions = [];
    try {
      const data = JSON.parse(sessionsOutput);
      sessions = data.sessions || [];
    } catch (e) {
      // 解析失败，忽略
    }
    
    // 解析 Agent 数量 - 从 "10 total · 7 bootstrapping · 1 active · 7 sessions" 格式
    const agentsInfo = overview['Agents'] || '';
    const agentsMatch = agentsInfo.match(/^(\d+)/);
    const agentCount = agentsMatch ? parseInt(agentsMatch[1]) : 0;
    
    // 解析 Sessions 数量
    const sessionsInfo = overview['Sessions'] || '';
    const sessionsMatch = sessionsInfo.match(/(\d+)\s+active/);
    const activeSessions = sessionsMatch ? parseInt(sessionsMatch[1]) : 0;

    // 解析 Gateway 状态
    const gatewayInfo = overview['Gateway'] || '';
    const gatewayReachable = gatewayInfo.includes('reachable');
    const gatewayMsMatch = gatewayInfo.match(/reachable\s+(\d+)ms/);
    const gatewayLatency = gatewayMsMatch ? gatewayMsMatch[1] + 'ms' : 'N/A';
    
    // 解析 Heartbeat
    const heartbeatInfo = overview['Heartbeat'] || '';
    
    // 解析 Memory
    const memoryInfo = overview['Memory'] || '';

    // 解析统计数据
    const activeGateways = gateways.filter(g => g.enabled && g.status === 'OK');
    const summary = {
      gateways: gateways.filter(g => g.name && g.name !== 'default' && g.name !== 'Account'),
      sessions: sessions,
      sessionCount: activeSessions,
      runningGateways: activeGateways.length,
      totalGateways: gateways.filter(g => g.enabled).length,
      healthy: activeGateways.length > 0,
      
      // Overview 中的详细信息
      overview: overview,
      
      // 详细统计
      agentCount: agentCount,
      totalTokens: allTokens.totalTokens,
      totalInputTokens: allTokens.totalInputTokens,
      totalOutputTokens: allTokens.totalOutputTokens,
      contextTokens: sessions[0]?.contextTokens || 200000,
      model: sessions[0]?.model || 'N/A',
      
      // Heartbeat 信息
      heartbeat: heartbeatInfo,
      
      // Memory 信息
      memory: memoryInfo,
      
      // Gateway 详情
      gatewayReachable: gatewayReachable,
      gatewayLatency: gatewayLatency,
      gatewayAddress: overview['Dashboard'] || 'N/A'
    };

    // 缓存结果
    cachedResult = summary;
    cacheTime = now;

    return NextResponse.json(summary);
  } catch (error) {
    console.error('OpenClaw info error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch OpenClaw information', details: error.message },
      { status: 500 }
    );
  }
}
