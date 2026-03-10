import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

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

// ============== 缓存 ==============
let cachedResult = null;
let cacheTime = 0;
const CACHE_TTL = 5000;

// ============== 主 API ==============
export async function GET() {
  try {
    const now = Date.now();
    if (cachedResult && (now - cacheTime) < CACHE_TTL) {
      return NextResponse.json(cachedResult);
    }

    const [statusResult, sessionsResult, tokenResult, todayTokenResult] = await Promise.all([
      execAsync('openclaw status 2>&1', { timeout: 10000 }),
      execAsync('openclaw sessions --json', { timeout: 10000 }),
      Promise.resolve(calculateTotalTokensAllSessions()),
      calculateTodayTokens()
    ]);

    const { stdout } = statusResult;
    const { stdout: sessionsOutput } = sessionsResult;
    const allTokens = tokenResult;
    const todayTokens = todayTokenResult;

    const lines = stdout.split('\n');
    const overview = parseOverview(lines);
    const gateways = parseGatewaySection(lines);

    let sessions = [];
    try {
      const data = JSON.parse(sessionsOutput);
      sessions = data.sessions || [];
    } catch (e) {
      // 解析失败，忽略
    }
    
    const agentsInfo = overview['Agents'] || '';
    const agentsMatch = agentsInfo.match(/^(\d+)/);
    const agentCount = agentsMatch ? parseInt(agentsMatch[1]) : 0;
    
    const sessionsInfo = overview['Sessions'] || '';
    const sessionsMatch = sessionsInfo.match(/(\d+)\s+active/);
    const activeSessions = sessionsMatch ? parseInt(sessionsMatch[1]) : 0;

    const gatewayInfo = overview['Gateway'] || '';
    const gatewayReachable = gatewayInfo.includes('reachable');
    const gatewayMsMatch = gatewayInfo.match(/reachable\s+(\d+)ms/);
    const gatewayLatency = gatewayMsMatch ? gatewayMsMatch[1] + 'ms' : 'N/A';
    
    const heartbeatInfo = overview['Heartbeat'] || '';
    const memoryInfo = overview['Memory'] || '';

    const activeGateways = gateways.filter(g => g.enabled && g.status === 'OK');
    const summary = {
      gateways: gateways.filter(g => g.name && g.name !== 'default' && g.name !== 'Account'),
      sessions: sessions,
      sessionCount: activeSessions,
      runningGateways: activeGateways.length,
      totalGateways: gateways.filter(g => g.enabled).length,
      healthy: activeGateways.length > 0,
      overview: overview,
      agentCount: agentCount,
      totalTokens: allTokens,
      todayTokens: todayTokens.todayTokens,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      contextTokens: sessions[0]?.contextTokens || 200000,
      model: sessions[0]?.model || 'N/A',
      heartbeat: heartbeatInfo,
      memory: memoryInfo,
      gatewayReachable: gatewayReachable,
      gatewayLatency: gatewayLatency,
      gatewayAddress: overview['Dashboard'] || 'N/A'
    };

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
