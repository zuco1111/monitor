import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

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
      return filePath;
    }
  }
  
  return null;
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

    // 获取所有 session 列表
    const { stdout } = await execAsync('openclaw sessions --json', {
      timeout: 10000
    });

    let data;
    try {
      data = JSON.parse(stdout);
    } catch (e) {
      data = { sessions: [] };
    }

    const sessions = data.sessions || [];

    // 如果指定了 sessionKey，读取该 session 的消息历史
    let messages = [];
    if (sessionKey && sessions.length > 0) {
      const session = sessions.find(s => s.key === sessionKey);
      if (session && session.sessionId) {
        const sessionFile = getSessionFilePath(sessionKey, session.sessionId);
        
        if (sessionFile && fs.existsSync(sessionFile)) {
          try {
            const fileContent = fs.readFileSync(sessionFile, 'utf-8');
            const lines = fileContent.split('\n').filter(l => l.trim());
            
            messages = lines
              .map(line => {
                try {
                  return JSON.parse(line);
                } catch {
                  return null;
                }
              })
              .filter(item => item && item.type === 'message')
              .slice(-30)  // 只取最近30条
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
              .filter(msg => msg.content);  // 只保留有内容的消息
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
      messages: messages
    });
  } catch (error) {
    console.error('OpenClaw conversations error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch conversations', details: error.message },
      { status: 500 }
    );
  }
}
