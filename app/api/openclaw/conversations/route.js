import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);
const OPENCLAW_BIN = '/Volumes/SpaceShip/NPM_Data/npm-global/bin/openclaw';

export const dynamic = 'force-dynamic';

// 从 sessions.json 读取 session 文件路径
function getSessionFilePath(sessionKey, sessionId) {
  const homeDir = os.homedir();
  const agentsDir = path.join(homeDir, '.openclaw', 'agents');
  
  const agentId = sessionKey.split(':')[1] || 'main';
  
  const sessionsDir = path.join(agentsDir, agentId, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) {
      return { dir: sessionsDir, filePath, sessionId };
    }
  }
  
  return null;
}

// 检查 session 是否被 reset
function checkSessionReset(sessionsDir, sessionId) {
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return false;
  
  try {
    const files = fs.readdirSync(sessionsDir);
    const resetFile = files.find(f => f.startsWith(sessionId) && f.includes('.reset.'));
    return !!resetFile;
  } catch (e) {
    return false;
  }
}

// 提取消息内容
function extractMessageContent(content) {
  if (!content) return '';
  
  // content 是一个数组，包含不同类型的块
  let text = '';
  
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        text += block.text + '\n';
      }
      // 忽略 thinking 块
    }
  } else if (typeof content === 'string') {
    text = content;
  }
  
  return text.trim();
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionKey = searchParams.get('session');
    const after = searchParams.get('after'); // 可选的时间戳，用于增量获取

    // 获取所有 session 列表（包含所有 agent）
    const { stdout, stderr } = await execAsync(`${OPENCLAW_BIN} sessions --all-agents --json`, {
      timeout: 10000
    });

    let data;
    try {
      // openclaw 输出可能包含调试日志，需要提取 JSON 部分
      let jsonStr = '';
      let inJson = false;
      let braceCount = 0;
      
      for (const char of stdout) {
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
      
      data = jsonStr ? JSON.parse(jsonStr) : { sessions: [] };
    } catch (e) {
      data = { sessions: [] };
    }

    const sessions = data.sessions || [];

    // 如果指定了 sessionKey，读取该 session 的消息历史
    let messages = [];
    let isReset = false;
    if (sessionKey && sessions.length > 0) {
      const session = sessions.find(s => s.key === sessionKey);
      if (session && session.sessionId) {
        const sessionInfo = getSessionFilePath(sessionKey, session.sessionId);
        
        if (sessionInfo && fs.existsSync(sessionInfo.filePath)) {
          // 检查是否被 reset
          isReset = checkSessionReset(sessionInfo.dir, session.sessionId);
          
          try {
            const fileContent = fs.readFileSync(sessionInfo.filePath, 'utf-8');
            const lines = fileContent.split('\n').filter(l => l.trim());
            
            // 过滤消息
            let filteredLines = lines
              .map(line => {
                try {
                  return JSON.parse(line);
                } catch {
                  return null;
                }
              })
              .filter(item => item && item.type === 'message');
            
            // 如果指定了 after 参数，只返回增量消息
            if (after) {
              const afterTimestamp = parseInt(after);
              filteredLines = filteredLines.filter(item => item.timestamp > afterTimestamp);
            } else {
              // 默认只取最近30条
              filteredLines = filteredLines.slice(-30);
            }
            
            messages = filteredLines
              .map(item => {
                const msg = item.message;
                return {
                  id: item.id,
                  role: msg?.role,
                  content: extractMessageContent(msg?.content),
                  timestamp: item.timestamp,
                  usage: msg?.usage
                };
              })
              .filter(msg => msg.content && msg.role !== 'toolResult');  // 过滤掉工具结果
          } catch (e) {
            console.error('Failed to read session file:', e);
          }
        }
      }
    }

    return NextResponse.json({
      sessions: sessions,
      totalSessions: sessions.length,
      currentSession: sessionKey,
      messages: messages,
      isReset: isReset
    });
  } catch (error) {
    console.error('OpenClaw conversations error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch conversations', details: error.message },
      { status: 500 }
    );
  }
}
