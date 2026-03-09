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

// 获取今天的开始时间戳 (毫秒)
function getTodayStartTimestamp() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

// 每日token存储结构: { daily: { "2026-03-08": { total: 1000, sessions: {...} } }, lastResetDate: "2026-03-08" }
// 持久化设计：删除 session 不影响历史记录的今日 token，只在跨天时重置

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
  return { daily: {}, lastResetDate: null };
}

// 获取 session 文件的创建时间
function getSessionFileCreatedTime(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.birthtime.getTime();
  } catch (e) {
    return Date.now();
  }
}

// 计算今日Token消耗（持久化设计：删除 session 不影响历史今日 token）
async function calculateTodayTokens() {
  const homeDir = os.homedir();
  const sessionsDir = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
  
  const storage = loadDailyTokenStorage();
  const today = getTodayDateString();
  const todayStart = getTodayStartTimestamp();
  
  // 检查是否需要重置（跨天）
  if (storage.lastResetDate !== today) {
    // 新的一天，重置数据
    storage.daily = {};
    storage.daily[today] = { total: 0, sessions: {} };
    storage.lastResetDate = today;
    await saveDailyTokenStorage(storage);
    // 返回 0
    return { todayTokens: 0 };
  }
  
  // 确保今日数据存在
  if (!storage.daily[today]) {
    storage.daily[today] = { total: 0, sessions: {} };
  }
  
  const todayData = storage.daily[today];
  
  if (!fs.existsSync(sessionsDir)) {
    return { todayTokens: todayData.total };
  }
  
  // 从 0 开始计算今日总增量（不累加历史）
  let todayTotal = 0;
  const currentSessions = {};
  
  // 记录所有被删除但有记录的 session，用于保留其累积 token
  const deletedSessions = { ...todayData.sessions };
  
  try {
    const files = fs.readdirSync(sessionsDir);
    
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(sessionsDir, file);
      const fileCreatedTime = getSessionFileCreatedTime(filePath);
      const existingSessionData = todayData.sessions?.[sessionId];
      
      // 从 deletedSessions 中移除当前存在的 session
      delete deletedSessions[sessionId];
      
      // 修复：检测 session 是否被删除后重建（通过文件创建时间判断）
      // 如果文件创建时间与记录的创建时间不同，说明是同名但不同的 session，应视为新 session
      let sessionBaseline = existingSessionData;
      if (existingSessionData && existingSessionData.fileCreated !== fileCreatedTime) {
        // session 被删除后重建了同名 session，需要保留旧的今日增量 token
        // 今日增量 = lastTokens - baselineTokens
        const oldBaselineTokens = existingSessionData.baselineTokens || 0;
        const oldLastTokens = existingSessionData.lastTokens || 0;
        const oldTodayIncrement = Math.max(0, oldLastTokens - oldBaselineTokens);
        if (oldTodayIncrement > 0) {
          todayTotal += oldTodayIncrement;
          console.log(`[Token] Session ${sessionId} recreated, preserving ${oldTodayIncrement} tokens from old session`);
        }
        // 新的 session 从 0 开始计算
        sessionBaseline = { lastTokens: 0, initialTokens: 0, baselineTokens: 0, fileCreated: fileCreatedTime };
      }
      
      // 计算该 session 从 0 点到现在的 token 增量
      const tokenInfo = getTodayTokensFromSessionWithBaseline(
        filePath, 
        todayStart, 
        sessionBaseline || { lastTokens: 0, initialTokens: 0, baselineTokens: 0, fileCreated: fileCreatedTime }
      );
      
      if (tokenInfo.increment > 0) {
        todayTotal += tokenInfo.increment;
      }
      
      // 记录当前 session 的 token 状态（用于下次计算增量）
      // 修复2：记录 initialTokens，用于检测 reset
      let initialTokens = existingSessionData?.initialTokens || 0;
      let baselineTokens = existingSessionData?.baselineTokens || 0;
      if (tokenInfo.isReset || !existingSessionData || (existingSessionData && existingSessionData.fileCreated !== fileCreatedTime)) {
        // session 被 reset、新 session 或同名重建，记录初始 token
        initialTokens = tokenInfo.currentTokens;
        // baselineTokens：
        // - 今天新建的 session（fileCreatedToday = true）用 0
        // - 今天之前创建且今日有消息的 session 用今日第一条消息的 token
        // - 今天之前创建且今日无消息的 session 用 currentTokens（保持不变）
        if (tokenInfo.firstTodayTokens !== null) {
          baselineTokens = tokenInfo.firstTodayTokens;
        } else {
          // 今日无新消息，保持当前 token 作为 baseline
          baselineTokens = tokenInfo.currentTokens;
        }
      } else {
        // 已存在的 session（有记录且未被重建）
        // 如果今日有新消息，更新为今日第一条消息的 token
        if (tokenInfo.firstTodayTokens !== null) {
          baselineTokens = tokenInfo.firstTodayTokens;
        } else if (baselineTokens === 0 && tokenInfo.currentTokens > 0) {
          // 修复：旧数据 baselineTokens = 0 的边界情况
          // 如果今日无新消息且 baselineTokens 为 0，设为 currentTokens
          baselineTokens = tokenInfo.currentTokens;
        }
        // 如果今日无新消息且 baselineTokens > 0，保持不变
      }
      
      currentSessions[sessionId] = {
        lastTokens: tokenInfo.currentTokens,
        initialTokens: initialTokens,
        baselineTokens: baselineTokens,
        fileCreated: fileCreatedTime,
        lastUpdate: Date.now()
      };
    }
    
    // 将被删除的 session 的今日增量累积到今日总量
    // 修复：只计算今日新增的 token，而不是全量
    // 今日新增 = lastTokens - baselineTokens
    for (const [sessionId, sessionData] of Object.entries(deletedSessions)) {
      const baselineTokens = sessionData.baselineTokens || 0;
      const lastTokens = sessionData.lastTokens || 0;
      const todayIncrement = Math.max(0, lastTokens - baselineTokens);
      if (todayIncrement > 0) {
        todayTotal += todayIncrement;
        console.log(`[Token] Session ${sessionId} deleted, adding ${todayIncrement} tokens (was ${baselineTokens}, now ${lastTokens})`);
      }
    }
    
    // 更新存储（异步保存）
    storage.daily[today].sessions = currentSessions;
    // 只有 total 变化时才更新（避免频繁写入）
    if (storage.daily[today].total !== todayTotal) {
      storage.daily[today].total = todayTotal;
      await saveDailyTokenStorage(storage);
    }
    
  } catch (e) {
    console.error('Error calculating today tokens:', e);
  }
  
  return { todayTokens: todayTotal };
}

// 从session文件中提取今日token消耗（带增量基准）
// 修复2：检测 session 是否被 reset，避免历史 token 重复计入今日
function getTodayTokensFromSessionWithBaseline(sessionFilePath, todayStart, baselineData) {
  // baselineData: { lastTokens: number, initialTokens: number, baselineTokens: number, fileCreated: number }
  const baselineTokens = baselineData?.lastTokens || 0;
  const initialTokens = baselineData?.initialTokens || 0;
  const fileCreatedTime = baselineData?.fileCreated || 0;
  
  try {
    const stats = fs.statSync(sessionFilePath);
    if (stats.size === 0) return { increment: 0, currentTokens: 0, isReset: false };
    
    const content = fs.readFileSync(sessionFilePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    // 检查文件是否在今天之前创建
    const fileCreatedToday = fileCreatedTime >= todayStart;
    
    let todayIncrement = 0;
    let lastTokens = 0;
    let currentTokens = 0;
    let foundToday = false;
    let firstTodayTokens = null;
    
    // 修复2：如果文件不是今天创建的，但 currentTokens < initialTokens，说明被 reset 了
    // 此时用 initialTokens（或第一条消息的 token）作为今日起点
    let effectiveBaseline = baselineTokens;
    if (!fileCreatedToday && initialTokens > 0 && baselineTokens > initialTokens) {
      // session 被 reset 了，用当前文件的初始 token 作为基准
      effectiveBaseline = 0; // 从 0 开始计算
    }
    
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const msgTime = obj.message?.timestamp || 0;
        
        if (obj.type === 'message' && obj.message?.usage?.totalTokens) {
          currentTokens = obj.message.usage.totalTokens;
          
          if (msgTime >= todayStart) {
            if (!foundToday) {
              // 今日第一条消息
              foundToday = true;
              // 如果是被 reset 的 session，使用该消息的 token 作为今日起点
              if (!fileCreatedToday && baselineTokens > initialTokens) {
                firstTodayTokens = currentTokens;
              } else {
                firstTodayTokens = effectiveBaseline > 0 ? effectiveBaseline : currentTokens;
              }
              lastTokens = currentTokens;
            } else {
              // 后续消息，只累加正值增量
              if (currentTokens > lastTokens) {
                todayIncrement += (currentTokens - lastTokens);
              }
              lastTokens = currentTokens;
            }
          }
        }
      } catch (e) {
        // 跳过解析失败的行
      }
    }
    
    // 如果没有今天的消息，但有 baseline，用 baseline 计算
    if (!foundToday && baselineTokens > 0 && currentTokens > baselineTokens) {
      todayIncrement = currentTokens - baselineTokens;
    }
    
    // 返回是否被 reset 的标志
    const isReset = !fileCreatedToday && baselineTokens > initialTokens && currentTokens < baselineTokens;
    
    return { increment: todayIncrement, currentTokens, isReset, firstTodayTokens };
  } catch (e) {
    return { increment: 0, currentTokens: 0, isReset: false, firstTodayTokens: null };
  }
}

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
