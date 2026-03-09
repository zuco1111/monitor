import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

// Token 持久化存储文件路径
const TOKEN_STORAGE_FILE = path.join(os.homedir(), '.openclaw', 'token-usage.json');
// 每日Token消耗存储
const DAILY_TOKEN_FILE = path.join(os.homedir(), '.openclaw', 'daily-token.json');

// 缓存更新锁（防止并发更新）
let isUpdatingCache = false;

// 获取今天日期字符串 (YYYY-MM-DD)
function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 每日token存储结构: { yesterdayTotal: 1000, lastUpdateDate: "2026-03-08" }
// 今日 token = 当前历史总消耗 - yesterdayTotal
// 跨天时自动更新 yesterdayTotal

// 异步保存每日token记录
async function saveDailyTokenStorage(storage) {
  const tempFile = DAILY_TOKEN_FILE + '.' + randomUUID() + '.tmp';
  try {
    const dir = path.dirname(DAILY_TOKEN_FILE);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(tempFile, JSON.stringify(storage, null, 2), 'utf-8');
    await fsPromises.rename(tempFile, DAILY_TOKEN_FILE);
  } catch (e) {
    console.error('Error saving daily token storage:', e);
    try {
      await fsPromises.unlink(tempFile);
    } catch {}
  }
}

// 加载每日token记录（同步版本，用于主流程）
function loadDailyTokenStorage() {
  try {
    if (fs.existsSync(DAILY_TOKEN_FILE)) {
      const data = fs.readFileSync(DAILY_TOKEN_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error loading daily token storage:', e);
  }
  return { yesterdayTotal: 0, lastUpdateDate: null };
}

// 获取昨天日期字符串 (YYYY-MM-DD)
function getYesterdayDateString() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
}

// ============================================================================
// 新方案：今日token = 当前历史总消耗 - 昨日历史总消耗
// ============================================================================
async function calculateTodayTokens() {
  const storage = loadDailyTokenStorage();
  const today = getTodayDateString();
  const yesterday = getYesterdayDateString();
  
  // 获取当前历史总消耗
  const currentTotal = getCachedTokens();
  
  // 检查是否需要跨天更新
  if (storage.lastUpdateDate !== today) {
    if (storage.lastUpdateDate === null) {
      // 首次运行：yesterdayTotal 设为 0
      storage.yesterdayTotal = 0;
    }
    // 跨多天的情况：保持原来的 yesterdayTotal 不变（用之前的值作为基准）
    
    storage.lastUpdateDate = today;
    await saveDailyTokenStorage(storage);
    
    console.log(`[Token] Day change detected, yesterdayTotal: ${storage.yesterdayTotal}`);
    return { todayTokens: 0 };
  }
  
  // 今日 token = 当前历史总消耗 - 昨日历史总消耗
  const todayTokens = Math.max(0, currentTotal - storage.yesterdayTotal);
  
  return { todayTokens };
}
// ============================================================================

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

// 加载已保存的 token 记录（增加有效性检查）
function loadTokenStorage() {
  try {
    if (fs.existsSync(TOKEN_STORAGE_FILE)) {
      const data = fs.readFileSync(TOKEN_STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      
      // 检查数据结构有效性
      if (parsed && typeof parsed.total === 'number' && parsed.total >= 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Error loading token storage:', e);
  }
  // 返回默认值，保留已有的历史累计
  return { sessions: {}, total: 0, lastUpdated: null };
}

// 异步保存 token 记录（无锁设计，通过原子重命名实现）
async function saveTokenStorage(storage) {
  const tempFile = TOKEN_STORAGE_FILE + '.' + randomUUID() + '.tmp';
  try {
    const dir = path.dirname(TOKEN_STORAGE_FILE);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(tempFile, JSON.stringify(storage, null, 2), 'utf-8');
    // 原子重命名（自动覆盖旧文件）
    await fsPromises.rename(tempFile, TOKEN_STORAGE_FILE);
  } catch (e) {
    console.error('Error saving token storage:', e);
    // 清理临时文件
    try {
      await fsPromises.unlink(tempFile);
    } catch {}
  }
}

// 快速获取缓存的 token（用于主流程，不阻塞）
function getCachedTokens() {
  const storage = loadTokenStorage();
  return storage.total || 0;
}

// 后台更新 token 缓存（异步，不阻塞响应，带锁防止并发）
function updateTokenCacheInBackground() {
  setImmediate(() => {
    // 如果正在更新，直接跳过
    if (isUpdatingCache) return;
    isUpdatingCache = true;
    
    try {
      calculateTotalTokensAllSessionsInternal();
    } catch (e) {
      console.error('Background token update failed:', e);
    } finally {
      isUpdatingCache = false;
    }
  });
}

// 检查 session 是否被 reset（通过检查是否存在 .reset. 后缀的历史文件）
function isSessionReset(sessionsDir, sessionId) {
  try {
    const files = fs.readdirSync(sessionsDir);
    return files.some(f => f.startsWith(sessionId) && f.includes('.reset.'));
  } catch (e) {
    return false;
  }
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
        
        // 修复1：检测 session 是否被 reset，如果是则重新计算
        const wasReset = isSessionReset(sessionsDir, sessionId);
        
        if (!knownSessions[sessionId] || wasReset) {
          // 新 session 或被 reset 的 session：直接使用当前 token
          // 如果是被 reset 的，需要从历史累计中移除旧数据（通过不累加旧值）
          const added = currentTokens;
          totalTokens += added;
          hasChanges = true;
          console.log(`[Token] Session ${sessionId} ${wasReset ? 'reset' : 'new'}: +${added} tokens`);
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
    const [statusResult, sessionsResult, tokenResult, todayTokenResult] = await Promise.all([
      // 1. openclaw status
      execAsync('openclaw status 2>&1', { timeout: 10000 }),
      // 2. openclaw sessions --json
      execAsync('openclaw sessions --json', { timeout: 10000 }),
      // 3. token 计算（已在函数内部缓存，结果会写入文件）
      Promise.resolve(calculateTotalTokensAllSessions()),
      // 4. 今日 token 计算（异步，已持久化）
      calculateTodayTokens()
    ]);

    const { stdout } = statusResult;
    const { stdout: sessionsOutput } = sessionsResult;
    const allTokens = tokenResult;
    const todayTokens = todayTokenResult;

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
      todayTokens: todayTokens.todayTokens,
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
