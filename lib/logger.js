const rfs = require('rotating-file-stream');
const path = require('path');
const fs = require('fs');

// 确保日志目录存在
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 创建轮转日志流
const accessLogStream = rfs.createStream('access.log', {
  interval: '1d',           // 每天轮转
  maxFiles: 7,              // 保留7天
  maxSize: '10M',           // 最大10MB
  compress: 'gzip',         // 压缩旧日志
  path: logDir
});

const errorLogStream = rfs.createStream('error.log', {
  interval: '1d',
  maxFiles: 7,
  maxSize: '10M',
  compress: 'gzip',
  path: logDir
});

module.exports = {
  accessLogStream,
  errorLogStream,
  logDir
};
