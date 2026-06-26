const fs = require('fs');
const path = require('path');

// ============================================================
// СИСТЕМА ЛОГИРОВАНИЯ С УРОВНЯМИ И SSE
// ============================================================

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const CURRENT_LOG_LEVEL = 'debug'; // debug < info < warn < error
const MAX_LOGS = 500;

let logs = [];
let eventStreamClients = []; // Клиенты, подписанные на SSE

// Создаем поток для записи логов в файл
const logFilePath = path.join(__dirname, 'server.log');
const logFileStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf-8' });

/**
 * Главная функция логирования
 * @param {string} level - уровень: debug, info, warn, error
 * @param {string} message - сообщение
 * @param {*} data - дополнительные данные (опционально)
 */
function log(level, message, data = null) {
  if (LOG_LEVELS[level] < LOG_LEVELS[CURRENT_LOG_LEVEL]) return;

  const timestamp = new Date().toISOString();
  const timeShort = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const logEntry = {
    id: logs.length + 1,
    timestamp,
    timeShort,
    level,
    message,
    data: data || null
  };

  // Форматированный вывод в консоль терминала
  const levelEmoji = {
    debug: '🐛',
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌'
  };
  const levelPrefix = `[${level.toUpperCase().padEnd(6)}]`;
  const colorCodes = {
    debug: '\x1b[36m',   // cyan
    info: '\x1b[32m',    // green
    warn: '\x1b[33m',    // yellow
    error: '\x1b[31m'    // red
  };
  const reset = '\x1b[0m';

  console.log(
    `${colorCodes[level] || ''}[${timeShort}] ${levelPrefix} ${levelEmoji[level] || '📌'} ${message}${reset}`
  );
  if (data) {
    console.log(`   └─ Данные:`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  // Запись в файл
  const logLine = `[${timeShort}] ${levelPrefix} ${levelEmoji[level] || '📌'} ${message}`;
  const dataLine = data ? `\n   └─ Данные: ${typeof data === 'string' ? data : JSON.stringify(data)}` : '';
  logFileStream.write(logLine + dataLine + '\n');

  logs.push(logEntry);

  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }

  // Push новым клиентам SSE
  broadcastToSSE(logEntry);
}

// Convenience-функции
const serverLog = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data)
};

/**
 * Отправляет лог всем подписанным SSE-клиентам
 */
function broadcastToSSE(logEntry) {
  const payload = JSON.stringify(logEntry);
  eventStreamClients = eventStreamClients.filter(client => !client.destroyed);
  for (const client of eventStreamClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

/**
 * Получить все логи
 */
function getLogs(levelFilter) {
  if (levelFilter && LOG_LEVELS[levelFilter] !== undefined) {
    return logs.filter(l => l.level === levelFilter);
  }
  return logs;
}

/**
 * Очистить логи
 */
function clearLogs() {
  const count = logs.length;
  logs = [];
  return count;
}

// Export
module.exports = {
  log,
  serverLog,
  getLogs,
  clearLogs,
  eventStreamClients,
  LOG_LEVELS,
  CURRENT_LOG_LEVEL,
  MAX_LOGS,
  logFileStream
};
