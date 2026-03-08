import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CronExpressionParser } from 'cron-parser';

const execAsync = promisify(exec);

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
    const date = next.toDate();
    
    // 转换为上海时区显示
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    return formatter.format(date);
  } catch (e) {
    console.error('Failed to parse cron:', e);
    return null;
  }
}

// 格式化时间为 mm-dd hh:mm（使用上海时区）
function formatTime(timeStr) {
  if (!timeStr || timeStr === '-') return 'N/A';
  
  const shanghaiTz = 'Asia/Shanghai';
  
  // 如果已经是具体日期时间格式
  if (timeStr.match(/^\d{4}-\d{2}-\d{2}/)) {
    const date = new Date(timeStr);
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: shanghaiTz,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return formatter.format(date);
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
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: shanghaiTz,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return formatter.format(now);
  }
  
  return timeStr;
}

export async function GET() {
  try {
    const { stdout: listOutput } = await execAsync('openclaw cron list', {
      timeout: 10000
    });

    const tasks = [];
    const lines = listOutput.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      if (line.includes('─') || line.includes('ID') || line.startsWith('Hint')) continue;
      if (line.startsWith('ID ')) continue;
      
      if (line.length > 148) {
        const id = line.substring(0, 37).trim();
        const name = line.substring(37, 62).trim();
        const schedule = line.substring(62, 95).trim();
        const nextRun = line.substring(95, 106).trim();
        const lastRun = line.substring(106, 117).trim();
        const status = line.substring(117, 127).trim();
        
        if (id) {
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
      }
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
