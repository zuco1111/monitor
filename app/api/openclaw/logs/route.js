import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    // 限制最大返回 200 条日志，防止 OOM
    const rawLimit = parseInt(searchParams.get('limit')) || 100;
    const limit = Math.min(Math.max(rawLimit, 1), 200);

    // 获取日志（带超时保护）
    const { stdout } = await execAsync(
      `openclaw logs --json --limit ${limit} --plain`,
      { timeout: 10000 }
    );

    // 解析 JSON 行
    const logs = stdout
      .split('\n')
      .filter(l => l.trim())
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          // 如果不是 JSON，尝试解析为普通文本日志
          return {
            time: new Date().toISOString(),
            level: 'info',
            message: l
          };
        }
      })
      .filter(Boolean);

    // 统计日志级别
    const stats = {
      total: logs.length,
      trace: 0,
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      fatal: 0
    };

    logs.forEach(log => {
      const level = (log.level || 'info').toLowerCase();
      if (stats[level] !== undefined) {
        stats[level]++;
      }
    });

    return NextResponse.json({
      logs: logs,
      stats: stats,
      count: logs.length
    });
  } catch (error) {
    console.error('OpenClaw logs error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch logs', details: error.message },
      { status: 500 }
    );
  }
}
