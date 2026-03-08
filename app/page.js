'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Cpu, MemoryStick, HardDrive, Thermometer, 
  Box, Activity, MessageSquare, FileText, Clock, RefreshCw,
  Sun, Moon, Monitor
} from 'lucide-react';

// 智能滚动 Hook - 优化版，减少重渲染
function useSmartScroll(fetchData, idleTimeout = 5000) {
  const [lastActivity, setLastActivity] = useState(Date.now());
  const scrollRef = useRef(null);
  const isFetchingRef = useRef(false);
  const fetchDataRef = useRef(fetchData);

  // 更新 fetchData 引用
  useEffect(() => {
    fetchDataRef.current = fetchData;
  }, [fetchData]);

  // 用户活动处理 - 使用函数式更新避免依赖
  const handleUserActivity = useCallback(() => {
    setLastActivity(prev => Date.now());
  }, []);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // 定时检查 - 使用 ref 避免依赖问题
  useEffect(() => {
    let lastCheckTime = Date.now();
    
    const checkInterval = setInterval(() => {
      const now = Date.now();
      // 使用 ref 获取最新的 fetchData
      if (now - lastActivity >= idleTimeout && !isFetchingRef.current) {
        isFetchingRef.current = true;
        fetchDataRef.current().finally(() => {
          isFetchingRef.current = false;
          lastCheckTime = now;
          setTimeout(scrollToBottom, 100);
        });
      }
    }, 1000);

    return () => clearInterval(checkInterval);
  }, [idleTimeout, scrollToBottom, lastActivity]);

  return { scrollRef, handleUserActivity };
}

// 格式化字节数
function formatBytes(bytes) {
  if (!bytes) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

// 格式化百分比
function formatPercent(value) {
  if (!value && value !== 0) return 'N/A';
  return `${Number(value).toFixed(1)}%`;
}

export default function Home() {
  const [systemData, setSystemData] = useState(null);
  const [dockerData, setDockerData] = useState(null);
  const [openclawData, setOpenclawData] = useState(null);
  const [tasksData, setTasksData] = useState(null);
  const [logsData, setLogsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  
  // 主题状态
  const [theme, setTheme] = useState('system');
  
  // 对话相关状态 - 分离管理
  const [sessionsList, setSessionsList] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [conversationMessages, setConversationMessages] = useState([]);

  // 主题切换
  const toggleTheme = () => {
    const themes = ['light', 'dark', 'system'];
    const currentIndex = themes.indexOf(theme);
    const nextTheme = themes[(currentIndex + 1) % themes.length];
    setTheme(nextTheme);
    localStorage.setItem('theme', nextTheme);
  };

  // 应用主题
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'system';
    setTheme(savedTheme);
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    
    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  // 获取数据 - 静默刷新，不显示 loading
  const fetchData = async () => {
    try {
      const [system, docker, openclaw, tasks] = await Promise.all([
        fetch('/api/system').then(r => r.json()).catch(() => null),
        fetch('/api/docker').then(r => r.json()).catch(() => null),
        fetch('/api/openclaw').then(r => r.json()).catch(() => null),
        fetch('/api/openclaw/tasks').then(r => r.json()).catch(() => null)
      ]);

      setSystemData(system);
      setDockerData(docker);
      setOpenclawData(openclaw);
      setTasksData(tasks);
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  };

  // 首次加载时获取会话列表
  const fetchSessionsList = async () => {
    try {
      const data = await fetch('/api/openclaw/conversations').then(r => r.json());
      if (data.sessions && data.sessions.length > 0) {
        setSessionsList(data.sessions);
        if (!selectedSession) {
          setSelectedSession(data.sessions[0].key);
        }
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    }
  };

  // 获取指定会话的消息
  const fetchSessionMessages = async (sessionKey) => {
    if (!sessionKey) return;
    try {
      const data = await fetch(`/api/openclaw/conversations?session=${encodeURIComponent(sessionKey)}`).then(r => r.json());
      setConversationMessages(data.messages || []);
    } catch (e) {
      console.error('Failed to fetch messages:', e);
      setConversationMessages([]);
    }
  };

  // 对话智能滚动 Hook
  const { scrollRef: messagesScrollRef, handleUserActivity: handleMessagesActivity } = useSmartScroll(
    () => selectedSession ? fetchSessionMessages(selectedSession) : Promise.resolve()
  );

  // 日志智能滚动 Hook
  const { scrollRef: logsScrollRef, handleUserActivity: handleLogsActivity } = useSmartScroll(
    () => fetch('/api/openclaw/logs?limit=50').then(r => r.json()).then(data => {
      setLogsData(data);
    }).catch(() => {})
  );

  // 首次加载
  useEffect(() => {
    fetchData();
    fetchSessionsList();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  // 当选中会话变化时，获取该会话的消息
  useEffect(() => {
    if (selectedSession) {
      fetchSessionMessages(selectedSession);
    }
  }, [selectedSession]);

  // 计算状态颜色
  const getStatusColor = (status) => {
    if (status === 'running' || status === 'ok') return 'bg-green-500';
    if (status === 'paused') return 'bg-yellow-500';
    return 'bg-gray-400';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900 p-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent dark:text-white">
            系统监控面板
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            最后更新: {lastUpdate ? lastUpdate.toLocaleTimeString() : '加载中...'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 主题切换 */}
          <button 
            onClick={toggleTheme}
            className="p-2 rounded-lg bg-gray-200 dark:bg-slate-700 hover:bg-gray-300 dark:hover:bg-slate-600 transition-all shadow-md"
            title={`当前: ${theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}`}
          >
            {theme === 'light' && <Sun className="w-5 h-5 text-amber-500" />}
            {theme === 'dark' && <Moon className="w-5 h-5 text-indigo-400" />}
            {theme === 'system' && <Monitor className="w-5 h-5 text-gray-500" />}
          </button>
          {/* 刷新 */}
          <button 
            onClick={fetchData}
            className="p-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:from-indigo-600 hover:to-purple-600 transition-all shadow-md"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 系统状态一行 - 7个卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        {/* CPU */}
        <Card className="bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-300">CPU</CardTitle>
            <Cpu className="w-4 h-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-indigo-600">{formatPercent(systemData?.cpu?.load)}</div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {systemData?.cpu?.brand?.substring(0, 20) || 'CPU'} • {systemData?.cpu?.coresCount} 核
            </p>
          </CardContent>
        </Card>

        {/* 内存 */}
        <Card className="bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-300">内存</CardTitle>
            <MemoryStick className="w-4 h-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">{formatPercent(systemData?.memory?.usedPercent)}</div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {formatBytes(systemData?.memory?.used)} / {formatBytes(systemData?.memory?.total)}
            </p>
          </CardContent>
        </Card>

        {/* 硬盘 */}
        <Card className="bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-300">硬盘</CardTitle>
            <HardDrive className="w-4 h-4 text-pink-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-pink-600">
              {formatPercent(systemData?.mainDisk?.usedPercent)}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {formatBytes(systemData?.mainDisk?.used)} / {formatBytes(systemData?.mainDisk?.total)}
            </p>
          </CardContent>
        </Card>

        {/* 温度 - 读取不到时不显示 */}
        {systemData?.temperature?.cpu && (
          <Card className="bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-300">温度</CardTitle>
              <Thermometer className="w-4 h-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-500">
                {systemData.temperature.cpu}°C
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">CPU 温度</p>
            </CardContent>
          </Card>
        )}

        {/* OpenClaw 状态 */}
        <Card className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-white/80">OpenClaw</CardTitle>
            <Activity className="w-4 h-4 text-white" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${openclawData?.healthy ? 'bg-green-400' : 'bg-red-400'}`}></div>
              <span className="font-bold">{openclawData?.healthy ? '运行正常' : '异常'}</span>
            </div>
            <p className="text-xs text-white/80 mt-1">
              {openclawData?.sessionCount || 0} Sessions · {openclawData?.agentCount || 0} Agents
            </p>
          </CardContent>
        </Card>

        {/* Gateway 状态 */}
        <Card className="bg-gradient-to-br from-blue-500 to-cyan-600 text-white shadow-lg border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-white/80">Gateway</CardTitle>
            <Activity className="w-4 h-4 text-white" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${openclawData?.gatewayReachable ? 'bg-green-400' : 'bg-red-400'}`}></div>
              <span className="font-bold">{openclawData?.gatewayReachable ? '可达' : '不可达'}</span>
            </div>
            <p className="text-xs text-white/80 mt-1">
              {openclawData?.gatewayLatency || 'N/A'}
            </p>
          </CardContent>
        </Card>

        {/* Token 消耗 */}
        <Card className="bg-gradient-to-br from-green-500 to-teal-600 text-white shadow-lg border-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-white/80">Token消耗</CardTitle>
            <Activity className="w-4 h-4 text-white" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {openclawData?.totalTokens ? `${(openclawData.totalTokens / 1000).toFixed(1)}k` : '0'}
            </div>
            <p className="text-xs text-white/80 mt-1">历史累计</p>
          </CardContent>
        </Card>
      </div>

      {/* 对话和日志 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* 对话 */}
        <Card className="bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-indigo-500" />
              对话
              <Badge variant="outline">{sessionsList.length || 0}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* 会话列表 */}
            <div className="mb-4">
              <select 
                className="w-full p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-slate-700 focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-gray-900 dark:text-gray-100"
                value={selectedSession || ''}
                onChange={(e) => setSelectedSession(e.target.value)}
              >
                <option value="">选择会话</option>
                {sessionsList.map((session) => (
                  <option key={session.key} value={session.key}>
                    {session.key.split(':').slice(2).join(':') || session.key} ({session.kind})
                  </option>
                ))}
              </select>
            </div>
            
            {/* 消息列表 - 对话卡片专用滚动区域 */}
            <div 
              className="space-y-2 max-h-[270px] overflow-y-auto" 
              ref={messagesScrollRef}
              onMouseMove={handleMessagesActivity}
              onTouchStart={handleMessagesActivity}
              onKeyDown={handleMessagesActivity}
              onScroll={handleMessagesActivity}
            >
              {conversationMessages.slice(0, 20).map((msg, i) => (
                <div key={i} className="p-3 bg-gradient-to-r from-gray-50 dark:from-slate-700 to-white dark:to-slate-800 rounded-lg border border-gray-100 dark:border-gray-700">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                      msg.role === 'assistant' ? 'bg-indigo-100 text-indigo-700' : 
                      msg.role === 'user' ? 'bg-green-100 text-green-700' : 
                      msg.role === 'tool' ? 'bg-amber-100 text-amber-700' :
                      'bg-gray-100 text-gray-700 dark:text-gray-200'
                    }`}>
                      {msg.role || 'system'}
                    </span>
                    {msg.usage?.totalTokens > 0 && (
                      <span className="text-xs text-gray-400 dark:text-gray-500">{msg.usage.totalTokens} tokens</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-all">
                    {msg.content || '(无内容)'}
                  </div>
                </div>
              ))}
              {(conversationMessages.length === 0) && (
                <p className="text-center text-gray-400 dark:text-gray-500 py-4">选择会话查看消息</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* OpenClaw日志 */}
        <Card className="bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-500" />
              OpenClaw日志
              <Badge variant="outline">{logsData?.stats?.total || 0} 条</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col">
            <div 
              className="space-y-1 font-mono text-xs max-h-[340px] overflow-y-auto flex-1"
              ref={logsScrollRef}
              onMouseMove={handleLogsActivity}
              onTouchStart={handleLogsActivity}
              onKeyDown={handleLogsActivity}
              onScroll={handleLogsActivity}
            >
              {logsData?.logs?.slice(0, 30).map((log, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="text-gray-400 dark:text-gray-500 whitespace-nowrap">
                    {log.time ? new Date(log.time).toLocaleTimeString() : ''}
                  </span>
                  <Badge 
                    className={`text-[10px] px-1 ${
                      log.level === 'error' || log.level === 'fatal' ? 'bg-red-100 text-red-700' :
                      log.level === 'warn' ? 'bg-yellow-100 text-yellow-700' : 
                      'bg-gray-100 text-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {log.level || 'info'}
                  </Badge>
                  <span className="text-gray-600 dark:text-gray-300 break-all">{log.message || log.msg}</span>
                </div>
              ))}
              {(!logsData?.logs || logsData.logs.length === 0) && (
                <p className="text-center text-gray-400 dark:text-gray-500 py-4">暂无日志</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Docker 容器 */}
      <Card className="mb-6 bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Box className="w-5 h-5 text-indigo-500" />
            Docker 容器
            <Badge className="bg-green-100 text-green-700 hover:bg-green-200">
              {dockerData?.summary?.running || 0} 运行中
            </Badge>
            <Badge variant="outline">{dockerData?.summary?.total || 0} 总计</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">容器名</th>
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">镜像</th>
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">状态</th>
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">运行时长</th>
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">端口</th>
                </tr>
              </thead>
              <tbody>
                {dockerData?.containers?.map((container) => (
                  <tr key={container.id} className="border-b border-gray-50 dark:border-gray-700 hover:bg-gray-50/50 dark:hover:bg-slate-700/50">
                    <td className="py-3 font-mono text-xs max-w-[150px] truncate" title={container.name}>
                      {container.name}
                    </td>
                    <td className="py-3 text-gray-500 dark:text-gray-400 text-xs max-w-[200px] truncate" title={container.image}>
                      {container.image}
                    </td>
                    <td className="py-3">
                      <Badge className={`${container.state === 'running' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600 dark:text-gray-300'}`}>
                        {container.state}
                      </Badge>
                    </td>
                    <td className="py-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">{container.uptimeFormatted}</td>
                    <td className="py-3 text-xs text-gray-500 dark:text-gray-400 max-w-[150px] truncate">
                      {container.ports?.filter(p => p.publicPort).map(p => `${p.publicPort}:${p.privatePort}`).join(', ') || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 定时任务 - 放最下面 */}
      <Card className="bg-white/80 dark:bg-slate-800/80 backdrop-blur shadow-lg border-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-500" />
            定时任务
            <Badge className="bg-indigo-100 text-indigo-700">
              {tasksData?.enabledTasks || 0} 启用中
            </Badge>
            <Badge variant="outline">{tasksData?.totalTasks || 0} 总计</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">名称</th>
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">下次执行</th>
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">上次执行</th>
                  <th className="text-left py-3 font-medium text-gray-600 dark:text-gray-300">执行结果</th>
                </tr>
              </thead>
              <tbody>
                {tasksData?.tasks?.map((task) => (
                  <tr key={task.id} className="border-b border-gray-50 hover:bg-gray-50/50 dark:hover:bg-slate-700/50">
                    <td className="py-3 font-medium">{task.name}</td>
                    <td className="py-3 text-gray-600 dark:text-gray-300">{task.nextRun}</td>
                    <td className="py-3 text-gray-600 dark:text-gray-300">{task.lastRun}</td>
                    <td className="py-3">
                      <Badge className={task.status === '已完成' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600 dark:text-gray-300'}>
                        {task.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(!tasksData?.tasks || tasksData.tasks.length === 0) && (
              <p className="text-center text-gray-400 dark:text-gray-500 py-4">暂无定时任务</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
