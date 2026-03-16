import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CronExpressionParser } from 'cron-parser';

const execAsync = promisify(exec);
const OPENCLAW_BIN = '/Volumes/SpaceShip/NPM_Data/npm-global/bin/openclaw';

export const dynamic = 'force-dynamic';

// 从 schedule 中提取可读的时间描述
function parseSchedule(schedule) {
  if (!schedule) return 'N/A';
  
  // 移除 "cron " 前缀和 @ Asia/Shanghai 后缀
  let cronExpr = schedule.replace(/^cron\s+/, '').replace(/\s*@.*$/, '').replace(/\s*\(exact\)/, '');
  
  const parts = cronExpr.split(/\s+/);
  if (parts.length < 5) return schedule;
  
  const [minute, hour, , , dayOfWeek] = parts;
  
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  
  let dayStr = '';
  if (dayOfWeek && dayOfWeek !== '*') {
    const dayNum = parseInt(dayOfWeek);
    if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
      dayStr = `每${dayNames[dayNum]} `;
    }
  }
  
  return `${dayStr}${hour}:${minute.padStart(2, '0')}`;
}

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

// 格式化时间为 mm-dd hh-mm（使用上海时区）
function formatDateTime(date, shanghaiTz = 'Asia/Shanghai') {
  if (!date) return 'N/A';
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: shanghaiTz,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return formatter.format(date).replace(/\//g, '-');
}

// 格式化时间为 mm-dd hh-mm（使用上海时区）
function formatTime(timeStr) {
  if (!timeStr || timeStr === '-') return 'N/A';
  
  const shanghaiTz = 'Asia/Shanghai';
  
  // "in 14m" 格式（下次执行时间）
  const inMatch = timeStr.match(/^in\s+(\d+)([dhms])$/);
  if (inMatch) {
    const now = new Date();
    const value = parseInt(inMatch[1]);
    const unit = inMatch[2];
    switch (unit) {
      case 'd': now.setDate(now.getDate() + value); break;
      case 'h': now.setHours(now.getHours() + value); break;
      case 'm': now.setMinutes(now.getMinutes() + value); break;
      case 's': now.setSeconds(now.getSeconds() + value); break;
    }
    return formatDateTime(now, shanghaiTz);
  }
  
  // 如果已经是具体日期时间格式
  if (timeStr.match(/^\d{4}-\d{2}-\d{2}/)) {
    const date = new Date(timeStr);
    return formatDateTime(date, shanghaiTz);
  }
  
  // "5d ago" 格式
  const agoMatch = timeStr.match(/(\d+)\s*([dhms])\s*ago/);
  if (agoMatch) {
    const now = new Date();
    const value = parseInt(agoMatch[1]);
    const unit = agoMatch[2];
    switch (unit) {
      case 'd': now.setDate(now.getDate() - value); break;
      case 'h': now.setHours(now.getHours() - value); break;
      case 'm': now.setMinutes(now.getMinutes() - value); break;
      case 's': now.setSeconds(now.getSeconds() - value); break;
    }
    return formatDateTime(now, shanghaiTz);
  }
  
  return timeStr;
}

export async function GET() {
  try {
    const { stdout: listOutput } = await execAsync(`${OPENCLAW_BIN} cron list`, {
      timeout: 10000
    });

    const tasks = [];
    const lines = listOutput.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      // 跳过表头和分隔线
      if (line.includes('─') || line.includes('┌') || line.includes('ID') || line.startsWith('Hint')) continue;
      if (line.startsWith('ID ')) continue;
      if (line.length < 130) continue;
      
      // 使用固定字符位置截取（兼容性好）
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
      
      // 计算精确的下次执行时间
      const calculatedNextRun = calculateNextRun(schedule);
      
      tasks.push({
        id,
        name,
        schedule: parseSchedule(schedule),
        nextRun: calculatedNextRun || formatTime(nextRun),
        lastRun: formatTime(lastRun),
        status: status === 'ok' ? '已完成' : status
      });
    }

    const enabledTasks = tasks.filter(t => t.status === '已完成' || t.status === 'running').length;

    return NextResponse.json({
      tasks: tasks,
      totalTasks: tasks.length,
      enabledTasks: enabledTasks
    });
  } catch (error) {
    console.error('OpenClaw tasks error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch cron tasks', details: error.message },
      { status: 500 }
    );
  }
}
