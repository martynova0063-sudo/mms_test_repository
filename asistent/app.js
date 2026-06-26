const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const RegistrationAgent = require('./registration-agent');
const { serverLog, getLogs, clearLogs, eventStreamClients, logFileStream } = require('./logger');
const excel = require('excel4node');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Инициализация базы данных
const db = new sqlite3.Database('./registrations.db');

// Стартовые логи
serverLog.info('🚀 Сервер запущен!');
serverLog.info(`📂 Рабочая папка: ${process.cwd()}`);
serverLog.info(`📊 Уровень логирования: debug`);
serverLog.info(`📏 Макс. логов в памяти: 500`);


// Маршрут главной страницы
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// API ДЛЯ КАТАЛОГОВ
// ============================================================

// Получить все каталоги (GET /api/directories)
app.get('/api/directories', (req, res) => {
  db.all('SELECT * FROM directories ORDER BY name', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Добавить каталог (POST /api/directories)
app.post('/api/directories', (req, res) => {
  const { name, url, captcha_status, is_active } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'name и url обязательны' });
  }
  db.run(
    'INSERT INTO directories (name, url, captcha_status, is_active) VALUES (?, ?, ?, ?)',
    [name, url, captcha_status || 'Не проверен', is_active ? 1 : 0],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      serverLog.info(`➕ Каталог добавлен: ${name}`);
      res.json({ id: this.lastID, message: 'Каталог добавлен' });
    }
  );
});

// Обновить каталог (PUT /api/directories/:id)
app.put('/api/directories/:id', (req, res) => {
  const { id } = req.params;
  const { name, url, captcha_status, is_active } = req.body;
  db.run(
    'UPDATE directories SET name=?, url=?, captcha_status=?, is_active=? WHERE id=?',
    [name, url, captcha_status, is_active ? 1 : 0, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Не найден' });
      res.json({ message: 'Обновлён' });
    }
  );
});

// Удалить каталог (DELETE /api/directories/:id)
app.delete('/api/directories/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM directories WHERE id=?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Не найден' });
    res.json({ message: 'Удалён' });
  });
});

// Запуск регистрации
app.post('/start-registration', async (req, res) => {
  const { website, email, apppassword, imapHost, port, directories } = req.body;
  
  serverLog.info(`📥 Получен запрос на регистрацию`);
  serverLog.info(`   Сайт: ${website}`);
  serverLog.info(`   Email: ${email}`);
  serverLog.info(`   Каталогов: ${directories ? (Array.isArray(directories) ? directories.length : 1) : 0}`);

  try {
    const agent = new RegistrationAgent();
    const result = await agent.runRegistration(website, email, imapHost, port, apppassword, directories);

    serverLog.info(`✅ Запрос обработан успешно`);
    res.json({
      success: true,
      message: 'Регистрация завершена',
      result
    });
  } catch (error) {
    serverLog.error(`❌ Ошибка при запуске регистрации: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Ошибка при запуске регистрации',
      error: error.message
    });
  }
});

// Получение результатов
app.get('/results', (req, res) => {
  db.all('SELECT * FROM registrations ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ============================================================
// ЭКСПОРТ РЕЗУЛЬТАТОВ
// ============================================================

// Экспорт в CSV
app.get('/export/csv', (req, res) => {
  db.all('SELECT * FROM registrations ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const headers = ['ID', 'Сайт', 'Email', 'Логин', 'Пароль', 'Профиль', 'Статус', 'Дата', 'Компания', 'Каталог', 'Ошибка'];
    const csvContent = [
      headers.join(';'),
      ...rows.map(row => [
        row.id,
        row.website,
        row.email,
        row.login,
        row.password,
        row.profile_url,
        row.status,
        row.created_at,
        row.company,
        row.catalog,
        row.error || ''
      ].map(val => `"${val || ''}"`).join(';'))
    ].join('\n');
    
    // Добавляем BOM для корректного отображения кириллицы в Excel
    const bom = '\ufeff';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=registrations_${Date.now()}.csv`);
    res.send(bom + csvContent);
  });
});

// Экспорт в Excel (XLSX)
app.get('/export/excel', (req, res) => {
  db.all('SELECT * FROM registrations ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const wb = new excel.Workbook();
    const ws = wb.addWorksheet('Регистрации');
    
    // Стили
    const headerStyle = wb.createStyle({
      font: { bold: true, color: '#FFFFFF', size: 12 },
      fill: { type: 'pattern', patternType: 'solid', fgColor: '#4472C4' },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
    });
    
    const cellStyle = wb.createStyle({
      font: { size: 11 },
      alignment: { vertical: 'center' },
      border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
    });
    
    const statusStyleSuccess = wb.createStyle({
      ...cellStyle,
      fill: { type: 'pattern', patternType: 'solid', fgColor: '#C6EFCE' },
      font: { color: '#006100' }
    });
    
    const statusStyleError = wb.createStyle({
      ...cellStyle,
      fill: { type: 'pattern', patternType: 'solid', fgColor: '#FFC7CE' },
      font: { color: '#9C0006' }
    });
    
    // Заголовки
    const headers = ['ID', 'Сайт', 'Email', 'Логин', 'Пароль', 'Профиль', 'Статус', 'Дата', 'Компания', 'Каталог', 'Ошибка'];
    headers.forEach((h, i) => {
      ws.cell(1, i + 1).string(h).style(headerStyle);
    });
    
    // Данные
    rows.forEach((row, rowIndex) => {
      const r = rowIndex + 2;
      ws.cell(r, 1).number(row.id).style(cellStyle);
      ws.cell(r, 2).string(row.website || '').style(cellStyle);
      ws.cell(r, 3).string(row.email || '').style(cellStyle);
      ws.cell(r, 4).string(row.login || '').style(cellStyle);
      ws.cell(r, 5).string(row.password || '').style(cellStyle);
      ws.cell(r, 6).string(row.profile_url || '').style(cellStyle);
      ws.cell(r, 7).string(row.status || '').style(row.status === 'success' ? statusStyleSuccess : statusStyleError);
      ws.cell(r, 8).string(row.created_at || '').style(cellStyle);
      ws.cell(r, 9).string(row.company || '').style(cellStyle);
      ws.cell(r, 10).string(row.catalog || '').style(cellStyle);
      ws.cell(r, 11).string(row.error || '').style(cellStyle);
    });
    
    // Авто-ширина колонок
    headers.forEach((h, i) => {
      ws.column(i + 1).setWidth(h === 'Профиль' || h === 'Ошибка' ? 30 : 15);
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=registrations_${Date.now()}.xlsx`);
    wb.write(res);
  });
});

// Экспорт в JSON
app.get('/export/json', (req, res) => {
  db.all('SELECT * FROM registrations ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=registrations_${Date.now()}.json`);
    res.json(rows);
  });
});

// ============================================================
// API ДЛЯ ПОЛУЧЕНИЯ ЛОГОВ
// ============================================================

// Получить все логи (GET /api/logs)
app.get('/api/logs', (req, res) => {
  const { level } = req.query;
  const filtered = getLogs(level);
  
  res.json({
    count: filtered.length,
    logs: filtered
  });
});

// Очистить логи (POST /api/logs/clear)
app.post('/api/logs/clear', (req, res) => {
  const count = clearLogs();
  serverLog.info(`🗑️ Логи очищены (${count} записей удалено)`);
  res.json({ cleared: count, message: 'Логи очищены' });
});

// SSE STREAM — ПОДПИСКА НА ЛОГИ В РЕАЛЬНОМ ВРЕМЕНИ
app.get('/api/logs-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const lastFew = getLogs().slice(-50);
  for (const entry of lastFew) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  eventStreamClients.push(res);

  req.on('close', () => {
    serverLog.debug('🔌 SSE клиент отключился');
    eventStreamClients = eventStreamClients.filter(c => c !== res);
  });
});

// 404 HANDLER
app.use((req, res) => {
  serverLog.warn(`⛔ 404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Not Found' });
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  serverLog.error('💥 Неожиданная ошибка сервера', {
    message: err.message,
    stack: err.stack
  });
  res.status(500).json({ error: 'Internal Server Error' });
});

// Запуск сервера
app.listen(PORT, () => {
  serverLog.info(`🌐 Сервер доступен: http://localhost:${PORT}`);
  serverLog.info(`📊 API логов:       http://localhost:${PORT}/api/logs`);
  serverLog.info(`📡 SSE stream:      http://localhost:${PORT}/api/logs-stream`);
  serverLog.info(`🗑️ Очистить логи:   POST http://localhost:${PORT}/api/logs/clear`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  serverLog.info('🛑 Сервер останавливается (SIGINT)');
  eventStreamClients.forEach(c => c.end());
  logFileStream.end(() => {
    serverLog.info('📄 Файл логов закрыт');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  serverLog.info('🛑 Сервер останавливается (SIGTERM)');
  eventStreamClients.forEach(c => c.end());
  logFileStream.end(() => {
    serverLog.info('📄 Файл логов закрыт');
    process.exit(0);
  });
});
