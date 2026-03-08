import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as si from 'systeminformation';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

// 尝试执行命令并获取输出
async function tryCommand(cmd, timeout = 3000) {
  try {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

// 带超时的 Promise wrapper
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), ms)
    )
  ]);
}

// 获取 CPU 温度
async function getCPUTemperature() {
  // 方案 1：osx-cpu-temp（仅 Intel Mac 有效，M 系列返回 0°C 或失败）
  const osxTempOutput = await tryCommand('osx-cpu-temp');
  if (osxTempOutput) {
    const temp = parseFloat(osxTempOutput.replace('°C', '').trim());
    if (!isNaN(temp) && temp > 10 && temp < 150) {
      return temp;
    }
  }
  
  // 方案 2：systeminformation（Linux/部分 Intel Mac 有效）
  try {
    const temps = await si.cpuTemperature();
    if (temps.main && temps.main > 10 && temps.main < 150) {
      return temps.main;
    }
  } catch {
    // 忽略
  }
  
  return null;
}

export async function GET() {
  try {
    // 并行获取所有系统信息（带超时保护）
    const [cpu, cpuInfo, mem, disks, cpuTemp] = await Promise.all([
      withTimeout(si.currentLoad(), 5000).catch(() => null),
      withTimeout(si.cpu(), 5000).catch(() => ({})),
      withTimeout(si.mem(), 5000).catch(() => null),
      withTimeout(si.fsSize(), 5000).catch(() => []),
      getCPUTemperature()
    ]);

    // 修复硬盘分类逻辑 - macOS 的 /Volumes/SpaceShip 是内置硬盘
    const systemVolumes = [
      '/System/Volumes/VM', '/System/Volumes/Preboot', '/System/Volumes/Update', 
      '/System/Volumes/xarts', '/System/Volumes/iSCPreboot', '/System/Volumes/Hardware',
      '/System/Volumes/Data', '/Volumes/SpaceShip'
    ];
    
    // 内置硬盘：/ 和 /System/Volumes/Data
    const internalDisks = disks.filter(d => d.mount === '/' || d.mount === '/System/Volumes/Data');
    // 外接硬盘：其他挂载点
    const externalDisks = disks.filter(d => !internalDisks.includes(d) && !systemVolumes.includes(d.mount));

    // 计算总硬盘使用率（取第一个内置硬盘）
    const mainDisk = internalDisks[0] || {};

    return NextResponse.json({
      cpu: {
        speed: cpuInfo.cores?.[0]?.speed || 0,
        speedMin: cpuInfo.cores?.[0]?.speed || 0,
        speedMax: cpuInfo.brand,
        load: cpu.currentLoad,
        cores: cpu.cpus.map(c => c.load),
        brand: cpuInfo.brand,
        coresCount: cpuInfo.cores,
        physicalCores: cpuInfo.physicalCores
      },
      memory: {
        used: mem.used,
        total: mem.total,
        usedPercent: (mem.used / mem.total) * 100,
        free: mem.free,
        active: mem.active,
        available: mem.available
      },
      disks: {
        internal: internalDisks.map(d => ({
          mount: d.mount,
          type: d.type,
          size: d.size,
          used: d.used,
          available: d.available,
          usedPercent: d.use
        })),
        external: externalDisks.map(d => ({
          mount: d.mount,
          type: d.type,
          size: d.size,
          used: d.used,
          available: d.available,
          usedPercent: d.use
        }))
      },
      // 主硬盘（用于展示）
      mainDisk: {
        mount: mainDisk.mount || '/',
        usedPercent: mainDisk.use || 0,
        used: mainDisk.used,
        total: mainDisk.size,
        available: mainDisk.available
      },
      temperature: {
        cpu: cpuTemp,
        note: cpuTemp === null ? '无法获取温度' : null
      }
    });
  } catch (error) {
    console.error('System info error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch system information' },
      { status: 500 }
    );
  }
}
