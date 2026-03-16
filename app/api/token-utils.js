import fs from 'fs';
import fsPromises from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';

// ============== Token 计算缓存（开发模式禁用，使用文件缓存）==============
// 开发模式下内存缓存不可靠，每个 worker 进程有独立内存
// 所以这里直接禁用内存缓存，每次都从文件读取和计算
const TOKEN_CACHE_TTL = 0; // 禁用内存缓存

// 开发模式下也禁用所有缓存
const DISABLE_ALL_CACHE = true;
let cachedTotalTokens = null;
let cachedTotalTokensTime = 0;
let cachedTodayTokens = null;
let cachedTodayTokensTime = 0;

// ============== Token 存储配置 ==============
const TOKEN_STORAGE_FILE = path.join(os.homedir(), '.openclaw', 'token-usage.json');
const DAILY_BASELINE_FILE = path.join(os.homedir(), '.openclaw', 'daily-baseline.json');
const DAILY_HISTORY_FILE = path.join(os.homedir(), '.openclaw', 'daily-history.json');

// ============== 工具函数 ==============

// 获取今天日期字符串 (YYYY-MM-DD)
export function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 获取昨天日期字符串 (YYYY-MM-DD)
export function getYesterdayDateString() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
}

// 加载历史Token存储
export function loadTokenStorage() {
  try {
    if (fs.existsSync(TOKEN_STORAGE_FILE)) {
      const data = fs.readFileSync(TOKEN_STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && parsed.sessions && typeof parsed.total === 'number') {
        return parsed;
      }
    }
  } catch (e) {
    console.error('[Token] Error loading token storage:', e);
  }
  return { sessions: {}, total: 0, lastUpdated: null };
}

// 保存历史Token存储（原子写入）
export async function saveTokenStorage(storage) {
  const tempFile = TOKEN_STORAGE_FILE + '.' + randomUUID() + '.tmp';
  try {
    const dir = path.dirname(TOKEN_STORAGE_FILE);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(tempFile, JSON.stringify(storage, null, 2), 'utf-8');
    await fsPromises.rename(tempFile, TOKEN_STORAGE_FILE);
  } catch (e) {
    console.error('[Token] Error saving token storage:', e);
    try { await fsPromises.unlink(tempFile); } catch {}
  }
}

// 加载每日基准（用于增量计算）
export function loadDailyBaseline() {
  try {
    if (fs.existsSync(DAILY_BASELINE_FILE)) {
      const data = fs.readFileSync(DAILY_BASELINE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[Token] Error loading daily baseline:', e);
  }
  return { date: null, sessions: {}, todayTokens: 0 };
}

// 保存每日基准（原子写入）
export async function saveDailyBaseline(baseline) {
  const tempFile = DAILY_BASELINE_FILE + '.' + randomUUID() + '.tmp';
  try {
    const dir = path.dirname(DAILY_BASELINE_FILE);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(tempFile, JSON.stringify(baseline, null, 2), 'utf-8');
    await fsPromises.rename(tempFile, DAILY_BASELINE_FILE);
  } catch (e) {
    console.error('[Token] Error saving daily baseline:', e);
    try { await fsPromises.unlink(tempFile); } catch {}
  }
}

// 加载每日历史（用于记录每日总量）
export function loadDailyHistory() {
  try {
    if (fs.existsSync(DAILY_HISTORY_FILE)) {
      const data = fs.readFileSync(DAILY_HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[Token] Error loading daily history:', e);
  }
  return {}; // { "2026-03-13": 123456, "2026-03-12": 98765, ... }
}

// 保存每日历史
export async function saveDailyHistory(history) {
  const tempFile = DAILY_HISTORY_FILE + '.' + randomUUID() + '.tmp';
  try {
    const dir = path.dirname(DAILY_HISTORY_FILE);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(tempFile, JSON.stringify(history, null, 2), 'utf-8');
    await fsPromises.rename(tempFile, DAILY_HISTORY_FILE);
  } catch (e) {
    console.error('[Token] Error saving daily history:', e);
    try { await fsPromises.unlink(tempFile); } catch {}
  }
}

// 从 session 文件中提取最终的 token 消耗（取最后一条消息的 totalTokens）
export function getFinalTokensFromSession(sessionFilePath) {
  try {
    const stats = fs.statSync(sessionFilePath);
    if (stats.size === 0) return 0;
    
    const readSize = Math.min(stats.size, 500 * 1024);
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
      } catch (e) {}
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// ============== 核心逻辑：计算总Token消耗（历史累计）==============
/**
 * 计算总Token消耗（历史累计）- 带内存缓存
 * - 内存缓存 60 秒，避免频繁文件 I/O
 * - 记录每个 session 的历史 token 最大值
 * - 即使 session 被删除/重置，也保留历史 token
 * - 总消耗 = 所有 session 的历史 token 之和（取每个 session 的最大值）
 * @param {boolean} forceRefresh - 强制刷新缓存
 */
export function calculateTotalTokensAllSessions(forceRefresh = false) {
  const now = Date.now();
  
  // 检查内存缓存
  if (!forceRefresh && cachedTotalTokens !== null && (now - cachedTotalTokensTime) < TOKEN_CACHE_TTL) {
    return cachedTotalTokens;
  }
  
  const homeDir = os.homedir();
  const agentsDir = path.join(homeDir, '.openclaw', 'agents');
  
  // 读取历史记录
  const storage = loadTokenStorage();
  const historySessions = storage.sessions || {};
  
  // 获取所有 agent 目录
  let agents = [];
  try {
    agents = fs.readdirSync(agentsDir);
  } catch { 
    return storage.total || 0;
  }
  
  // 遍历所有当前存在的 session，取每个 session 的最大 token 值
  let hasChanges = false;
  const newHistorySessions = { ...historySessions };
  
  for (const agent of agents) {
    const sessionsDir = path.join(agentsDir, agent, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    
    try {
      const files = fs.readdirSync(sessionsDir);
      
      // 收集同一个 sessionId 的所有文件，取最大值
      const sessionMaxTokens = {};
      
      for (const file of files) {
        if (!file.endsWith('.jsonl') && !file.includes('.jsonl.deleted.') && !file.includes('.jsonl.reset.')) continue;
        
        // 提取 sessionId
        let sessionId = file.replace('.jsonl', '');
        sessionId = sessionId.replace(/\.deleted\..+$/, '');
        sessionId = sessionId.replace(/\.reset\..+$/, '');
        
        const uniqueKey = `${agent}:${sessionId}`;
        const filePath = path.join(sessionsDir, file);
        
        // 读取文件的 token 值
        const tokens = getFinalTokensFromSession(filePath);
        
        // 【修复】取最大值，而不是累加
        if (!sessionMaxTokens[uniqueKey] || tokens > sessionMaxTokens[uniqueKey]) {
          sessionMaxTokens[uniqueKey] = tokens;
        }
      }
      
      // 处理每个 session
      for (const [uniqueKey, maxTokens] of Object.entries(sessionMaxTokens)) {
        if (maxTokens > 0) {
          // 如果当前最大值大于历史值，更新
          if (!historySessions[uniqueKey] || maxTokens > historySessions[uniqueKey]) {
            newHistorySessions[uniqueKey] = maxTokens;
            hasChanges = true;
            console.log(`[Token] Session ${uniqueKey} updated: ${historySessions[uniqueKey] || 0} -> ${maxTokens}`);
          } else {
            newHistorySessions[uniqueKey] = historySessions[uniqueKey];
          }
        }
      }
    } catch (e) {
      console.error(`[Token] Error processing agent ${agent}:`, e);
      continue;
    }
  }
  
  // 保留已删除 session 的历史数据
  for (const [uniqueKey, historicalTokens] of Object.entries(historySessions)) {
    if (!newHistorySessions[uniqueKey] && historicalTokens > 0) {
      newHistorySessions[uniqueKey] = historicalTokens;
      hasChanges = true;
      console.log(`[Token] Restored deleted session ${uniqueKey}: ${historicalTokens}`);
    }
  }
  
  // 计算历史累计总值
  const totalTokens = Object.values(newHistorySessions).reduce((sum, t) => sum + t, 0);
  
  // 保存更新
  if (hasChanges || Object.keys(newHistorySessions).length !== Object.keys(historySessions).length) {
    const newStorage = {
      sessions: newHistorySessions,
      total: totalTokens,
      lastUpdated: new Date().toISOString()
    };
    saveTokenStorage(newStorage);
    console.log(`[Token] Total tokens updated: ${totalTokens}`);
  }
  
  // 更新内存缓存
  cachedTotalTokens = totalTokens;
  cachedTotalTokensTime = now;
  
  return totalTokens;
}

// ============== 核心逻辑：计算今日Token消耗（增量计算）==============
/**
 * 计算今日Token消耗 - 增量计算方式
 * - 记录每个 session 的 token 基准值
 * - 每次调用计算增量并累加到今日 token
 * - 支持 session 删除/重置：读取 .deleted. 文件获取最终 token 并计入
 * - 每天 0 点自动重置，并将前日数据保存到历史
 * @param {boolean} forceRefresh - 强制刷新缓存
 */
export async function calculateTodayTokens(forceRefresh = false) {
  const now = Date.now();
  
  // 检查内存缓存（TOKEN_CACHE_TTL=0 时禁用）
  const useCache = TOKEN_CACHE_TTL > 0;
  if (useCache && !forceRefresh && cachedTodayTokens !== null && (now - cachedTodayTokensTime) < TOKEN_CACHE_TTL) {
    return cachedTodayTokens;
  }
  
  const today = getTodayDateString();
  const homeDir = os.homedir();
  const agentsDir = path.join(homeDir, '.openclaw', 'agents');
  
  // 加载或初始化每日基准
  let baseline = loadDailyBaseline();
  const yesterday = getYesterdayDateString();
  
  // 跨天检测：每天 0 点重置
  if (baseline.date !== today) {
    // 保存昨日数据到历史
    if (baseline.date && baseline.todayTokens > 0) {
      const dailyHistory = loadDailyHistory();
      dailyHistory[baseline.date] = baseline.todayTokens;
      await saveDailyHistory(dailyHistory);
      console.log(`[Token] Saved yesterday ${baseline.date}: ${baseline.todayTokens} tokens`);
    }
    
    console.log(`[Token] New day detected: ${baseline.date} -> ${today}, resetting daily token`);
    baseline = {
      date: today,
      sessions: {},
      todayTokens: 0
    };
  }
  
  // 获取当前所有活跃 session 的 token
  const currentSessions = {};
  let agents = [];
  
  try {
    agents = fs.readdirSync(agentsDir);
  } catch {}
  
  for (const agent of agents) {
    const sessionsDir = path.join(agentsDir, agent, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    
    try {
      const files = fs.readdirSync(sessionsDir);
      
      // 只读取活跃的 .jsonl 文件（跳过 .deleted. 和 .reset.）
      for (const file of files) {
        // 跳过 .deleted. 和 .reset. 文件
        if (!file.endsWith('.jsonl') || file.includes('.jsonl.deleted.') || file.includes('.jsonl.reset.')) continue;
        
        const sessionId = file.replace('.jsonl', '');
        const uniqueKey = `${agent}:${sessionId}`;
        const filePath = path.join(sessionsDir, file);
        const currentTokens = getFinalTokensFromSession(filePath);
        
        if (currentTokens > 0) {
          currentSessions[uniqueKey] = currentTokens;
        }
      }
    } catch { continue; }
  }
  
  // 计算增量并更新今日 token
  let newTodayTokens = baseline.todayTokens;
  const currentBaseline = baseline.sessions;
  const newBaselineSessions = {};
  
  // 1. 处理当前仍存在的 session：计算增量
  for (const [uniqueKey, currentTokens] of Object.entries(currentSessions)) {
    const sessionBaseline = currentBaseline[uniqueKey] || { baseline: 0 };
    
    // 【修复】如果之前被标记为已删除（processed: true），需要先从基准中清除之前计入的 token
    // 然后重新计算增量（从 0 开始）
    let startFrom = sessionBaseline.baseline;
    if (sessionBaseline.processed) {
      // 之前已经计入过删除会话的 token，现在当作新会话处理
      startFrom = 0;
    }
    
    if (currentTokens > startFrom) {
      // 有增量：累加到今日 token
      const increment = currentTokens - startFrom;
      newTodayTokens += increment;
      
      console.log(`[Token] Session ${uniqueKey}: ${startFrom} -> ${currentTokens}, increment: ${increment}`);
    }
    
    // 更新基准值
    newBaselineSessions[uniqueKey] = {
      baseline: currentTokens
    };
  }
  
  // 2. 处理已被删除的 session：从基准中移除
  for (const uniqueKey of Object.keys(currentBaseline)) {
    if (!currentSessions[uniqueKey]) {
      console.log(`[Token] Session ${uniqueKey} deleted, removed from baseline`);
    }
  }
  
  // 保存更新后的基准
  baseline.sessions = newBaselineSessions;
  baseline.todayTokens = newTodayTokens;
  baseline.date = today;
  await saveDailyBaseline(baseline);
  
  console.log(`[Token] Today tokens: ${newTodayTokens}, active sessions: ${Object.keys(currentSessions).length}`);
  
  // 更新内存缓存
  cachedTodayTokens = newTodayTokens;
  cachedTodayTokensTime = now;
  
  return { todayTokens: newTodayTokens };
}
