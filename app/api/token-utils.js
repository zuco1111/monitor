import fs from 'fs';
import fsPromises from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';

// ============== Token 存储配置 ==============
const TOKEN_STORAGE_FILE = path.join(os.homedir(), '.openclaw', 'token-usage.json');
const DAILY_TOKEN_FILE = path.join(os.homedir(), '.openclaw', 'daily-token.json');

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

// 加载每日Token存储
export function loadDailyTokenStorage() {
  try {
    if (fs.existsSync(DAILY_TOKEN_FILE)) {
      const data = fs.readFileSync(DAILY_TOKEN_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[Token] Error loading daily token storage:', e);
  }
  // 返回结构：{ yesterdayTotal: number, sessions: { [key]: number }, lastUpdateDate: string }
  return { yesterdayTotal: 0, sessions: {}, lastUpdateDate: null };
}

// 保存每日Token存储（原子写入）
export async function saveDailyTokenStorage(storage) {
  const tempFile = DAILY_TOKEN_FILE + '.' + randomUUID() + '.tmp';
  try {
    const dir = path.dirname(DAILY_TOKEN_FILE);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(tempFile, JSON.stringify(storage, null, 2), 'utf-8');
    await fsPromises.rename(tempFile, DAILY_TOKEN_FILE);
  } catch (e) {
    console.error('[Token] Error saving daily token storage:', e);
    try { await fsPromises.unlink(tempFile); } catch {}
  }
}

// 从 session 文件中提取最终的 token 消耗（取最后一条消息的 totalTokens）
// 增大读取限制到 500KB 以处理更大的 session 文件
export function getFinalTokensFromSession(sessionFilePath) {
  try {
    const stats = fs.statSync(sessionFilePath);
    if (stats.size === 0) return 0;
    
    // 读取文件最后 500KB 来获取最新的 usage（原 100KB 增大到 500KB）
    const readSize = Math.min(stats.size, 500 * 1024);
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

// ============== 核心逻辑：计算总Token消耗（历史累计） ==============
/**
 * 计算总Token消耗（历史累计）
 * - 记录每个 session 的历史最大 token 值
 * - 即使 session 被删除，也保留历史最大值（通过不删除 sessions 记录）
 * - 总消耗 = 所有 session 的历史最大值之和
 * - 支持所有 agent 的 sessions
 * - 正确处理 .reset. 文件（会创建新 session，原文件变成 .reset.）
 * - 正确处理 .deleted. 文件（会保留最终 token）
 */
export function calculateTotalTokensAllSessions() {
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
    // 如果读取失败，返回历史累计值
    return storage.total || 0;
  }
  
  // 遍历所有当前存在的 session，更新历史最大值
  let hasChanges = false;
  const newHistorySessions = { ...historySessions };
  
  for (const agent of agents) {
    const sessionsDir = path.join(agentsDir, agent, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    
    try {
      const files = fs.readdirSync(sessionsDir);
      
      for (const file of files) {
        // 支持三种文件：
        // - .jsonl（正常）: xxx.jsonl
        // - .jsonl.deleted.xxx（已删除）: xxx.jsonl.deleted.timestamp
        // - .jsonl.reset.xxx（已重置）: xxx.jsonl.reset.timestamp
        if (!file.endsWith('.jsonl') && !file.includes('.jsonl.deleted.')) continue;
        
        // 提取 sessionId：移除 .jsonl, .deleted.xxx, .reset.xxx 等后缀
        let sessionId = file.replace('.jsonl', '');
        sessionId = sessionId.replace(/\.deleted\..+$/, '');  // 移除 .deleted.timestamp
        sessionId = sessionId.replace(/\.reset\..+$/, '');    // 移除 .reset.timestamp
        
        const uniqueKey = `${agent}:${sessionId}`;
        
        let currentTokens = 0;
        const filePath = path.join(sessionsDir, file);
        
        // 正常文件 (.jsonl) 或 .deleted 文件：读取最终 token
        if (!file.includes('.reset.')) {
          currentTokens = getFinalTokensFromSession(filePath);
        }
        // .reset. 文件：这是旧文件，被重置后会变成新 session，
        // 新 session 会被正常扫描，所以 .reset. 文件不再单独处理
        // （但我们保留历史记录中的数据）
        
        if (currentTokens > 0) {
          // 如果当前值大于历史最大值，更新历史最大值
          if (!historySessions[uniqueKey] || currentTokens > historySessions[uniqueKey]) {
            newHistorySessions[uniqueKey] = currentTokens;
            hasChanges = true;
            console.log(`[Token] Session ${uniqueKey} updated: ${historySessions[uniqueKey] || 0} -> ${currentTokens}`);
          } else {
            // 保持历史值
            newHistorySessions[uniqueKey] = historySessions[uniqueKey];
          }
        }
      }
    } catch (e) {
      console.error(`[Token] Error processing agent ${agent}:`, e);
      continue;
    }
  }
  
  // 计算历史累计总值
  const totalTokens = Object.values(newHistorySessions).reduce((sum, t) => sum + t, 0);
  
  // 只有发生变化时才写入文件（避免频繁 IO）
  // 注意：即使 session 被删除，我们也不从 historySessions 中删除，
  // 这样可以保留历史累计数据
  const hasSessionCountChange = Object.keys(newHistorySessions).length !== Object.keys(historySessions).length;
  if (hasChanges || hasSessionCountChange) {
    const newStorage = {
      sessions: newHistorySessions,
      total: totalTokens,
      lastUpdated: new Date().toISOString()
    };
    saveTokenStorage(newStorage);
    console.log(`[Token] Total tokens updated: ${totalTokens}`);
  }
  
  return totalTokens;
}

// ============== 核心逻辑：计算今日Token消耗 ==============
/**
 * 计算今日Token消耗
 * - 跨天/首次：记录当前所有 session 的 token 值作为今日基准
 * - 今日消耗 = sum(当前值 - 基准) + sum(今日新增session的token)
 * - 对于今日被删除的session：从今日基准中获取其最终的token并计入今日消耗
 * - 每天0点会自动重置今日统计
 * - 修复：yesterdayTotal 每次跨天时都更新为上一天的历史总量
 */
export async function calculateTodayTokens() {
  const dailyStorage = loadDailyTokenStorage();
  const historyStorage = loadTokenStorage();
  const today = getTodayDateString();
  const yesterday = getYesterdayDateString();
  const homeDir = os.homedir();
  const agentsDir = path.join(homeDir, '.openclaw', 'agents');
  
  // 首次运行或跨天：初始化今日基准
  if (dailyStorage.lastUpdateDate !== today) {
    const baselineSessions = {};
    let agents = [];
    try {
      agents = fs.readdirSync(agentsDir);
    } catch {}
    
    // 遍历当前所有 session，记录今日0点的基准
    for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;
      try {
        const files = fs.readdirSync(sessionsDir);
        for (const file of files) {
          // 支持三种文件：
          // - .jsonl（正常）
          // - .jsonl.deleted.xxx（已删除）
          // - .jsonl.reset.xxx（已重置）- 重置前的文件也需要计入今日基准
          if (!file.endsWith('.jsonl') && !file.includes('.jsonl.deleted.') && !file.includes('.jsonl.reset.')) continue;
          
          const sessionId = file.replace('.jsonl', '').replace(/\.deleted\..+$/, '').replace(/\.reset\..+$/, '');
          const uniqueKey = `${agent}:${sessionId}`;
          const filePath = path.join(sessionsDir, file);
          const tokens = getFinalTokensFromSession(filePath);
          if (tokens > 0) {
            // 如果已存在基准（可能多个同名文件），取最大值
            if (!baselineSessions[uniqueKey] || tokens > baselineSessions[uniqueKey]) {
              baselineSessions[uniqueKey] = tokens;
            }
          }
        }
      } catch { continue; }
    }
    
    // 【修复】yesterdayTotal 更新逻辑：
    // 1. 首次运行时：使用当前历史总量作为 yesterdayTotal
    // 2. 跨天时：使用当前历史总量作为 yesterdayTotal（确保与上一天衔接）
    // 3. 如果 yesterdayTotal 是 0（历史遗留问题），也更新为当前历史总量
    const yesterdayTotal = historyStorage.total || 0;
    
    if (dailyStorage.lastUpdateDate === null) {
      // 首次运行
      dailyStorage.yesterdayTotal = yesterdayTotal;
      console.log(`[Token] First run, yesterdayTotal set to: ${yesterdayTotal}`);
    } else if (dailyStorage.lastUpdateDate !== yesterday) {
      // 跨天（跳过一天或多天）：更新 yesterdayTotal
      dailyStorage.yesterdayTotal = yesterdayTotal;
      console.log(`[Token] Cross day, yesterdayTotal updated to: ${yesterdayTotal}`);
    } else if (dailyStorage.yesterdayTotal === 0 && yesterdayTotal > 0) {
      // 历史遗留问题修复：如果 yesterdayTotal 是 0但当前有历史数据，更新它
      dailyStorage.yesterdayTotal = yesterdayTotal;
      console.log(`[Token] Fixed historical yesterdayTotal: ${yesterdayTotal}`);
    }
    // 注意：如果是连续运行（同一天多次调用），且 yesterdayTotal > 0，则不更新
    
    // 更新今日 session 基准
    dailyStorage.sessions = baselineSessions;
    dailyStorage.lastUpdateDate = today;
    await saveDailyTokenStorage(dailyStorage);
    
    console.log(`[Token] New day, baseline sessions: ${Object.keys(baselineSessions).length}, yesterdayTotal: ${dailyStorage.yesterdayTotal}`);
  }
  
  // 【修复】yesterdayTotal 历史遗留问题：每次调用时检查并修复
  // 如果 yesterdayTotal 是 0但当前有历史数据，更新它
  const historyTotal = loadTokenStorage().total || 0;
  if (dailyStorage.yesterdayTotal === 0 && historyTotal > 0) {
    dailyStorage.yesterdayTotal = historyTotal;
    await saveDailyTokenStorage(dailyStorage);
    console.log(`[Token] Fixed historical yesterdayTotal: ${historyTotal}`);
  }
  
  // 计算今日消耗
  let todayTokens = 0;
  const baselineSessions = dailyStorage.sessions || {};
  
  // 获取当前所有 session
  let agents = [];
  try {
    agents = fs.readdirSync(agentsDir);
  } catch {}
  
  const currentSessions = {};
  
  for (const agent of agents) {
    const sessionsDir = path.join(agentsDir, agent, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        // 支持三种文件：
        // - .jsonl（正常）
        // - .jsonl.deleted.xxx（已删除）
        // - .jsonl.reset.xxx（已重置）- 重置前的文件也需要计入今日消耗
        if (!file.endsWith('.jsonl') && !file.includes('.jsonl.deleted.') && !file.includes('.jsonl.reset.')) continue;
        
        const sessionId = file.replace('.jsonl', '').replace(/\.deleted\..+$/, '').replace(/\.reset\..+$/, '');
        const uniqueKey = `${agent}:${sessionId}`;
        const filePath = path.join(sessionsDir, file);
        const currentTokens = getFinalTokensFromSession(filePath);
        
        if (currentTokens > 0) {
          // 对于同一个 session，可能同时存在 .jsonl 和 .jsonl.reset.xxx（刚被重置）
          // 取最大值，确保重置前的消耗被计入
          if (!currentSessions[uniqueKey] || currentTokens > currentSessions[uniqueKey]) {
            currentSessions[uniqueKey] = currentTokens;
          }
        }
      }
    } catch { continue; }
  }
  
  // 统一计算今日消耗（避免同一 session 多次计算）
  for (const [uniqueKey, currentTokens] of Object.entries(currentSessions)) {
    const baseline = baselineSessions[uniqueKey] || 0;
    if (currentTokens > baseline) {
      todayTokens += (currentTokens - baseline);
    }
    // 如果 currentTokens <= baseline，说明 session 被重置或无变化，不计入
  }
  
  // 注意：被删除的 session 不需要额外处理！
  // 因为：
  // 1. 如果 session 在基准中存在（今日0点存在），它的基准 token 已经计入今日消耗
  // 2. 我们计算的是"今日新增的 token"，不是"今日存在的 token"
  // 3. 如果 session 被删除，它今日的增量是 0，不需要额外加任何值
  
  console.log(`[Token] Today tokens: ${todayTokens}`);
  return { todayTokens };
}
