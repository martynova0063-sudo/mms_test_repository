const express = require('express');
require('dotenv').config();

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const RegistrationAgent = require('./registration-agent');
const { serverLog, getLogs, clearLogs, eventStreamClients, logFileStream } = require('./logger');
const taskManager = require('./task-manager');
const excel = require('excel4node');
const {
  getChatPriority,
  normalizeStatus,
  summarizeChats,
} = require('./chat-prioritization');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Инициализация базы данных
const db = new sqlite3.Database('./registrations.db');

// Таблица чатов отделена от регистраций: она не содержит пароли и подходит
// для импорта откликов из HH.ru, Telegram, Slack или другого источника.
db.run(`
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    conversation_url TEXT,
    company TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    applied_at TEXT,
    last_response_at TEXT,
    last_message_at TEXT,
    last_message_direction TEXT DEFAULT 'incoming',
    new_message_at TEXT,
    message_preview TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) serverLog.error('❌ Не удалось создать таблицу чатов:', err.message);
});

// Миграция: добавляем столбец is_test если его нет
db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='directories'", (err, row) => {
  if (!err && row) {
    db.all("PRAGMA table_info(directories)", (err, rows) => {
      if (err) { serverLog.warn('⚠️ Миграция is_test не удалась:', err.message); return; }
      const hasIsTest = rows && rows.some(r => r.name === 'is_test');
      if (!hasIsTest) {
        db.run("ALTER TABLE directories ADD COLUMN is_test INTEGER DEFAULT 0", (err) => {
          if (err) serverLog.warn('⚠️ Миграция is_test не удалась:', err.message);
          else serverLog.info('✅ Миграция: добавлен столбец is_test');
        });
      }
    });
  }
});

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeChatInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const externalId = source.external_id ?? source.externalId ?? source.chat_id;
  const company = String(source.company ?? source.from ?? '').trim();
  const direction = String(
    source.last_message_direction ??
      source.lastMessageDirection ??
      source.message_direction ??
      source.messageDirection ??
      'incoming',
  ).toLowerCase();

  return {
    externalId: externalId ? String(externalId).trim() : null,
    conversationUrl:
      source.conversation_url ?? source.conversationUrl ?? source.url ?? null,
    company: company || 'Без компании',
    status: normalizeStatus(source.status),
    appliedAt: normalizeTimestamp(
      source.applied_at ?? source.appliedAt ?? source.application_at,
    ),
    lastResponseAt: normalizeTimestamp(
      source.last_response_at ?? source.lastResponseAt,
    ),
    lastMessageAt: normalizeTimestamp(
      source.last_message_at ?? source.lastMessageAt ?? source.message_at,
    ),
    lastMessageDirection: direction === 'outgoing' ? 'outgoing' : 'incoming',
    newMessageAt: normalizeTimestamp(
      source.new_message_at ?? source.newMessageAt ?? source.unread_at,
    ),
    messagePreview:
      source.message_preview ?? source.last_message ?? source.lastMessage ?? null,
    createdAt: normalizeTimestamp(source.created_at),
  };
}

function serializeChat(row) {
  const priority = getChatPriority(row);
  return {
    ...row,
    from: row.company,
    status: priority.status,
    isHot: priority.isHot,
    priority: priority.priority,
    priorityReasons: priority.reasons,
    waitingDays: priority.waitingDays,
  };
}

async function getChats() {
  const rows = await dbAll('SELECT * FROM chats ORDER BY updated_at DESC, id DESC');
  return rows.map(serializeChat);
}

function getNotificationSettings(body = {}) {
  const provider = String(
    body.provider ||
      process.env.NOTIFICATION_WEBHOOK_PROVIDER ||
      'slack',
  ).toLowerCase();
  const webhookUrl = body.webhookUrl || process.env.NOTIFICATION_WEBHOOK_URL;
  const telegramChatId =
    body.telegramChatId || process.env.NOTIFICATION_TELEGRAM_CHAT_ID;

  return { provider, webhookUrl, telegramChatId };
}

function formatNotificationReport(summary) {
  return [
    'Отчёт по чатам',
    `Новые отклики за 24 часа: ${summary.newApplications}`,
    `Новые сообщения за 24 часа: ${summary.newMessages}`,
    `Отказы: ${summary.refusals}`,
    `Собеседования: ${summary.interviews}`,
    `Горячие чаты: ${summary.hot}`,
  ].join('\n');
}

async function sendNotificationReport(summary, settings = {}) {
  const { provider, webhookUrl, telegramChatId } =
    getNotificationSettings(settings);

  if (!webhookUrl) {
    throw new Error('Вебхук уведомлений не настроен');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    throw new Error('Укажите корректный URL вебхука');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Вебхук должен использовать HTTP или HTTPS');
  }

  const text = formatNotificationReport(summary);
  const payload =
    provider === 'telegram'
      ? { chat_id: telegramChatId, text }
      : { text };

  if (provider === 'telegram' && !telegramChatId) {
    throw new Error('Для Telegram укажите Chat ID');
  }

  const response = await fetch(parsedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Вебхук вернул HTTP ${response.status}`);
  }

  return { provider, message: text };
}

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
  const { name, url, captcha_status, is_active, is_test } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'name и url обязательны' });
  }
  db.run(
    'INSERT INTO directories (name, url, captcha_status, is_active, is_test) VALUES (?, ?, ?, ?, ?)',
    [name, url, captcha_status || 'Не проверен', is_active ? 1 : 0, is_test ? 1 : 0],
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
  const { name, url, captcha_status, is_active, is_test } = req.body;
  db.run(
    'UPDATE directories SET name=?, url=?, captcha_status=?, is_active=?, is_test=? WHERE id=?',
    [name, url, captcha_status, is_active ? 1 : 0, is_test ? 1 : 0, id],
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
    
    // Создаём задачи для каждого каталога
    const directoryList = Array.isArray(directories) ? directories : [directories];
    const taskIds = [];
    
    for (const dirUrl of directoryList) {
      const dirName = dirUrl.split('/').pop() || dirUrl;
      const taskId = taskManager.createTask(website, email, website, dirName);
      taskIds.push({ taskId, dirUrl });
    }

    // Передаём callback для обновления задач
    const taskCallbacks = {
      updateStatus: (taskId, status, progress, currentStep, error) => {
        taskManager.updateTaskStatus(taskId, status, progress, currentStep, error);
      },
      completeTask: (taskId, status, error) => {
        taskManager.completeTask(taskId, status, error);
      }
    };
    
    const result = await agent.runRegistration(website, email, imapHost, port, apppassword, directories, taskIds, taskCallbacks);

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
// ЧАТЫ, ПРИОРИТЕТЫ И СТАТИСТИКА
// ============================================================

app.get('/api/chats', async (req, res) => {
  try {
    const priorityFilter = String(req.query.priority || 'all').toLowerCase();
    const chats = await getChats();
    const filtered = chats.filter((chat) => {
      if (priorityFilter === 'hot') return chat.isHot;
      if (priorityFilter === 'archive') return !chat.isHot;
      return true;
    });
    res.json({ chats: filtered, count: filtered.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat-analytics', async (req, res) => {
  try {
    const chats = await getChats();
    res.json({
      summary: summarizeChats(chats),
      chats: chats.filter((chat) => chat.isHot),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function upsertChat(chat) {
  return new Promise((resolve, reject) => {
    const updateExisting = (existing) => {
      if (!existing) {
        const insertSql = chat.createdAt
          ? `INSERT INTO chats (
              external_id, conversation_url, company, status, applied_at,
              last_response_at, last_message_at, last_message_direction,
              new_message_at, message_preview, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
          : `INSERT INTO chats (
              external_id, conversation_url, company, status, applied_at,
              last_response_at, last_message_at, last_message_direction,
              new_message_at, message_preview, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
        const values = [
          chat.externalId,
          chat.conversationUrl,
          chat.company,
          chat.status,
          chat.appliedAt,
          chat.lastResponseAt,
          chat.lastMessageAt,
          chat.lastMessageDirection,
          chat.newMessageAt,
          chat.messagePreview,
        ];
        if (chat.createdAt) values.push(chat.createdAt);
        db.run(insertSql, values, function (error) {
          if (error) reject(error);
          else resolve({ action: 'imported', id: this.lastID });
        });
        return;
      }

      db.run(
        `UPDATE chats SET
          conversation_url=?, company=?, status=?, applied_at=?,
          last_response_at=?, last_message_at=?, last_message_direction=?,
          new_message_at=?, message_preview=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [
          chat.conversationUrl,
          chat.company,
          chat.status,
          chat.appliedAt,
          chat.lastResponseAt,
          chat.lastMessageAt,
          chat.lastMessageDirection,
          chat.newMessageAt,
          chat.messagePreview,
          existing.id,
        ],
        (error) => {
          if (error) reject(error);
          else resolve({ action: 'updated', id: existing.id });
        },
      );
    };

    if (!chat.externalId) {
      updateExisting(null);
      return;
    }

    db.get(
      'SELECT id FROM chats WHERE external_id=?',
      [chat.externalId],
      (error, existing) => {
        if (error) reject(error);
        else updateExisting(existing);
      },
    );
  });
}

app.post('/api/chats/import', async (req, res) => {
  const rawChats = Array.isArray(req.body) ? req.body : req.body?.chats;
  if (!Array.isArray(rawChats) || rawChats.length === 0) {
    return res.status(400).json({ error: 'Передайте непустой массив chats' });
  }
  if (rawChats.length > 2000) {
    return res.status(400).json({ error: 'За один импорт можно передать не более 2000 чатов' });
  }

  try {
    const imported = [];
    const errors = [];
    for (const [index, rawChat] of rawChats.entries()) {
      try {
        const result = await upsertChat(normalizeChatInput(rawChat));
        imported.push({ index, ...result });
      } catch (error) {
        errors.push({ index, error: error.message });
      }
    }

    const chats = await getChats();
    const summary = summarizeChats(chats);
    let notification = null;
    if (
      process.env.NOTIFICATION_WEBHOOK_URL &&
      process.env.NOTIFY_ON_CHAT_IMPORT !== 'false'
    ) {
      try {
        notification = await sendNotificationReport(summary);
      } catch (error) {
        serverLog.warn(`⚠️ Отчёт после импорта не отправлен: ${error.message}`);
      }
    }

    res.json({
      success: errors.length === 0,
      imported: imported.filter((item) => item.action === 'imported').length,
      updated: imported.filter((item) => item.action === 'updated').length,
      errors,
      summary,
      notification: notification
        ? { provider: notification.provider, sent: true }
        : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/notification-config', (req, res) => {
  const settings = getNotificationSettings();
  res.json({
    configured: Boolean(settings.webhookUrl),
    provider: settings.provider,
    telegramChatIdConfigured: Boolean(settings.telegramChatId),
  });
});

app.post('/api/notifications/send', async (req, res) => {
  try {
    const chats = await getChats();
    const summary = summarizeChats(chats);
    const result = await sendNotificationReport(summary, req.body || {});
    res.json({
      success: true,
      provider: result.provider,
      summary,
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ============================================================
// API ДЛЯ ПРОВЕРКИ ДАННЫХ КОМПАНИИ НА САЙТЕ
// ============================================================

app.post('/api/company/check', async (req, res) => {
  const { website } = req.body;
  
  if (!website) {
    return res.status(400).json({ error: 'Укажите URL сайта' });
  }

  try {
    const agent = new RegistrationAgent();
    await agent.initialize();
    
    const data = await agent.parseWebsiteData(website);
    await agent.cleanup();

    // Проверяем, какие поля заполнены реальными данными (не дефолтными)
    const fields = [
      { key: 'name', label: 'Название компании', value: data.name },
      { key: 'description', label: 'Описание', value: data.description },
      { key: 'address', label: 'Адрес', value: data.address },
      { key: 'phone', label: 'Телефон', value: data.phone },
      { key: 'email', label: 'Email', value: data.email },
      { key: 'inn', label: 'ИНН', value: data.inn },
      { key: 'city', label: 'Город', value: data.city },
      { key: 'industry', label: 'Сфера деятельности', value: data.industry },
      { key: 'logoUrl', label: 'Логотип', value: data.logoUrl },
    ];

    const results = fields.map(f => ({
      ...f,
      found: f.value && f.value !== 'Неизвестно' && f.value !== 'Не определено' && f.value !== null && f.value !== ''
    }));

    const allFound = results.every(r => r.found);

    res.json({
      success: true,
      allFound,
      data,
      results
    });
  } catch (error) {
    serverLog.error(`❌ Ошибка проверки компании: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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

// Старый экспорт регистраций оставлен отдельно, чтобы не ломать архив
// результатов регистрации.
app.get('/export/registrations-excel', (req, res) => {
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

function writeChatSheet(workbook, sheetName, rows, styles) {
  const worksheet = workbook.addWorksheet(sheetName);
  const headers = [
    'ID',
    'Компания / from',
    'Статус',
    'Приоритет',
    'Причина',
    'Дата отклика',
    'Последний ответ',
    'Последнее сообщение',
    'Направление',
    'Текст сообщения',
    'Ссылка на чат',
    'Название вакансии'
  ];
  headers.forEach((header, index) => {
    worksheet.cell(1, index + 1).string(header).style(styles.header);
  });

  const reasonLabels = {
    INTERVIEW: 'Собеседование',
    NO_RESPONSE_3_DAYS: 'Нет ответа более 3 дней',
    NEW_MESSAGE_24_HOURS: 'Новое сообщение за 24 часа',
  };

  rows.forEach((row, rowIndex) => {
    const line = rowIndex + 2;
    const rowStyle = row.isHot ? styles.hot : styles.archive;
    const values = [
      String(row.id || ''),
      row.company || row.from || '',
      row.status || '',
      row.isHot ? 'Горячий' : 'Архив',
      (row.priorityReasons || []).map((reason) => reasonLabels[reason] || reason).join(', '),
      row.applied_at || '',
      row.last_response_at || '',
      row.last_message_at || '',
      row.last_message_direction || '',
      row.message_preview || '',
      row.conversation_url || '',
      row.vacancy || '',
    ];
    values.forEach((value, index) => {
      worksheet.cell(line, index + 1).string(String(value)).style(rowStyle);
    });
  });

  headers.forEach((header, index) => {
    const wide = ['Текст сообщения', 'Ссылка на чат', 'Причина'].includes(header);
    worksheet.column(index + 1).setWidth(wide ? 34 : 18);
  });
  worksheet.row(1).setHeight(24);
  return worksheet;
}

// Экспорт чатов в Excel с обязательными листами «Приоритетные» и «Архив».
// Экспорт чатов в Excel с листами по приоритету и статусам.
app.get('/export/excel', async (req, res) => {
  try {
    const chats = await getChats();
    const workbook = new excel.Workbook();
    const styles = {
      header: workbook.createStyle({
        font: { bold: true, color: '#FFFFFF', size: 12 },
        fill: { type: 'pattern', patternType: 'solid', fgColor: '#4472C4' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        },
      }),
      hot: workbook.createStyle({
        font: { size: 11 },
        fill: { type: 'pattern', patternType: 'solid', fgColor: '#FFF2CC' },
        alignment: { vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        },
      }),
      archive: workbook.createStyle({
        font: { size: 11 },
        fill: { type: 'pattern', patternType: 'solid', fgColor: '#F2F2F2' },
        alignment: { vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        },
      }),
      all: workbook.createStyle({
        font: { size: 11 },
        fill: { type: 'pattern', patternType: 'solid', fgColor: '#FFFFFF' },
        alignment: { vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        },
      }),
      applied: workbook.createStyle({
        font: { size: 11 },
        fill: { type: 'pattern', patternType: 'solid', fgColor: '#DDEBF7' },
        alignment: { vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        },
      }),
      interview: workbook.createStyle({
        font: { size: 11 },
        fill: { type: 'pattern', patternType: 'solid', fgColor: '#E2EFDA' },
        alignment: { vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        },
      }),
      refusal: workbook.createStyle({
        font: { size: 11 },
        fill: { type: 'pattern', patternType: 'solid', fgColor: '#FCE4D6' },
        alignment: { vertical: 'center', wrapText: true },
        border: {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        },
      }),
    };

    // 1. Все чаты — единый лист
    writeChatSheet(workbook, 'Все чаты', chats, { ...styles, hot: styles.all, archive: styles.all });

    // 2. Приоритетные (горячие)
    writeChatSheet(workbook, 'Приоритетные', chats.filter((chat) => chat.isHot), styles);

    // 3. Архив (не горячие)
    writeChatSheet(workbook, 'Архив', chats.filter((chat) => !chat.isHot), styles);

    // 4. По статусам
    const statusMap = {
      'APPLIED':    { sheet: 'Отклики',       styleKey: 'applied' },
      'INTERVIEW':  { sheet: 'Собеседования', styleKey: 'interview' },
      'REFUSAL':    { sheet: 'Отказы',        styleKey: 'refusal' },
    };

    for (const [statusKey, cfg] of Object.entries(statusMap)) {
      const filtered = chats.filter(
        (chat) => (chat.status || '').toUpperCase() === statusKey,
      );
      if (filtered.length > 0) {
        writeChatSheet(workbook, cfg.sheet, filtered, {
          ...styles,
          hot: styles[cfg.styleKey],
          archive: styles[cfg.styleKey],
        });
      }
    }

    // 5. Прочие статусы (всё, что не попало в APPLIED / INTERVIEW / REFUSAL)
    const knownStatuses = new Set(Object.keys(statusMap));
    const others = chats.filter(
      (chat) => !knownStatuses.has((chat.status || '').toUpperCase()),
    );
    if (others.length > 0) {
      writeChatSheet(workbook, 'Прочие', others, { ...styles, hot: styles.all, archive: styles.all });
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=chat_report_${Date.now()}.xlsx`,
    );
    const buffer = await workbook.writeToBuffer();
    res.end(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
// ЭКСПОРТ ЗАЯВОК ПО ФОРМАТУ УИИ (applications)
// ============================================================

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function formatDateRu(dateString) {
  if (!dateString) return '';
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return String(dateString);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function extractResourceFromUrl(url) {
  if (!url) return '-';
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname;
    // Для Telegram показываем канал: t.me/pydevjob
    if (host === 't.me' && urlObj.pathname.split('/').filter(Boolean).length > 0) {
      return `t.me/${urlObj.pathname.split('/')[1]}`;
    }
    return host;
  } catch {
    return String(url);
  }
}

// ============================================================
// ЭКСПОРТ ЗАЯВОК ПО ФОРМАТУ УИИ (applications)
// ============================================================

// Создаём таблицу applications, если её ещё нет
db.run(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vacancy TEXT NOT NULL,
      company TEXT NOT NULL,
      is_viewed INTEGER DEFAULT 0,
      employer_status TEXT DEFAULT 'Не просмотрен',
      response_rate INTEGER DEFAULT 0,
      chat_id INTEGER,
      chat_url TEXT,
      boost_url TEXT,
      applied_at TEXT NOT NULL,
      applied_dt TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
    )
  `, (err) => {
  if (err) serverLog.error('❌ Не удалось создать таблицу applications:', err.message);
  else serverLog.info('✅ Таблица applications готова');
});

// Вспомогательная функция: номер недели в году (ISO 8601)
function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

// Вспомогательная функция: форматирование даты в ДД.ММ.ГГГГ
function formatDateRu(dateString) {
  if (!dateString) return '';
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return String(dateString);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

// Вспомогательная функция: извлечение ресурса из URL
function extractResourceFromUrl(url) {
  if (!url) return '-';
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname;
    if (host === 't.me' && urlObj.pathname.split('/').filter(Boolean).length > 0) {
      return `t.me/${urlObj.pathname.split('/')[1]}`;
    }
    return host;
  } catch {
    return String(url);
  }
}

// Группировка заявок по неделям на основе applied_dt
function groupApplicationsByWeek(applications) {
  const sorted = [...applications].sort(
    (a, b) => new Date(a.applied_dt || a.applied_at) - new Date(b.applied_dt || b.applied_at),
  );

  const grouped = {};
  for (const app of sorted) {
    const dateStr = app.applied_dt || app.applied_at;
    if (!dateStr) continue;
    const dateObj = new Date(dateStr);
    if (Number.isNaN(dateObj.getTime())) continue;
    const year = dateObj.getFullYear();
    const week = getWeekNumber(dateObj);
    const weekKey = `${year}-W${String(week).padStart(2, '0')}`;
    if (!grouped[weekKey]) {
      grouped[weekKey] = { label: `Неделя ${week} (${year})`, items: [], year, week };
    }
    grouped[weekKey].items.push(app);
  }
  return grouped;
}

// Экспорт заявок в Excel по формату УИИ
app.get('/export/applications-excel', async (req, res) => {
  try {
    const applications = await dbAll(
      'SELECT * FROM applications ORDER BY applied_dt ASC, applied_at ASC',
    );

    if (!applications.length) {
      return res.status(404).json({ error: 'Нет данных для экспорта' });
    }

    const grouped = groupApplicationsByWeek(applications);

    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('Отклики');

    // Стили
    const headerStyle = workbook.createStyle({
      font: { bold: true, color: '#FFFFFF', size: 12 },
      fill: { type: 'pattern', patternType: 'solid', fgColor: '#4472C4' },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      },
    });

    const weekHeaderStyle = workbook.createStyle({
      font: { bold: true, size: 12, color: '#FFFFFF' },
      fill: { type: 'pattern', patternType: 'solid', fgColor: '#38761D' },
      alignment: { horizontal: 'left', vertical: 'center' },
      border: {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      },
    });

    const cellStyle = workbook.createStyle({
      font: { size: 11 },
      alignment: { vertical: 'center' },
      border: {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      },
    });

    const summaryStyle = workbook.createStyle({
      font: { bold: true, size: 11, color: '#1F4E79' },
      fill: { type: 'pattern', patternType: 'solid', fgColor: '#DDEBF7' },
      alignment: { vertical: 'center' },
      border: {
        top: { style: 'medium' },
        bottom: { style: 'medium' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      },
    });

    // Заголовки таблицы
    const headers = [
      'Отклики',
      'Дата отклика',
      'Ресурс',
      'Ссылка на вакансию',
      'Название вакансии',
      'Резюме',
      'СП отправлено',
      'Результат',
    ];

    let rowIndex = 1;

    // Шапка таблицы
    headers.forEach((header, index) => {
      worksheet.cell(rowIndex, index + 1).string(header).style(headerStyle);
    });
    worksheet.row(rowIndex).setHeight(24);
    rowIndex++;

    // Счётчик накопительным итогом
    let cumulativeCount = 0;

    // Данные по неделям
    for (const [, weekData] of Object.entries(grouped)) {
      // Заголовок недели (объединяем ячейки A:H)
      worksheet
        .cell(rowIndex, 1, rowIndex, headers.length, true)
        .string(weekData.label)
        .style(weekHeaderStyle);
      rowIndex++;

      // Данные откликов внутри недели
      weekData.items.forEach((app, index) => {
        const resource = extractResourceFromUrl(app.chat_url || app.boost_url);
        const vacancyLink = app.boost_url || app.chat_url || '-';
        const cpSent = (app.employer_status && app.employer_status !== 'Не просмотрен')
          ? 'TRUE' : 'FALSE';

        worksheet.cell(rowIndex, 1).number(index + 1).style(cellStyle);
        worksheet.cell(rowIndex, 2).string(formatDateRu(app.applied_dt || app.applied_at)).style(cellStyle);
        worksheet.cell(rowIndex, 3).string(resource).style(cellStyle);
        worksheet.cell(rowIndex, 4).string(vacancyLink).style(cellStyle);
        worksheet.cell(rowIndex, 5).string(app.vacancy || '-').style(cellStyle);
        worksheet.cell(rowIndex, 6).string('TRUE').style(cellStyle);
        worksheet.cell(rowIndex, 7).string(cpSent).style(cellStyle);
        worksheet.cell(rowIndex, 8).string(app.employer_status || '-').style(cellStyle);
        rowIndex++;
      });

      // Накопительный итог
      cumulativeCount += weekData.items.length;

      // Подсчёт «выполнено за месяц» — все заявки того же года и месяца,
      // что первая дата недели
      const firstDate = new Date(weekData.items[0].applied_dt || weekData.items[0].applied_at);
      const monthYearKey = `${firstDate.getFullYear()}-${firstDate.getMonth()}`;
      let monthCount = 0;
      for (const [, otherWeek] of Object.entries(grouped)) {
        for (const item of otherWeek.items) {
          const itemDate = new Date(item.applied_dt || item.applied_at);
          if (`${itemDate.getFullYear()}-${itemDate.getMonth()}` === monthYearKey) {
            monthCount++;
          }
        }
      }

      // Строка итогов недели
      worksheet.cell(rowIndex, 1).string('Выполнено').style(summaryStyle);
      worksheet.cell(rowIndex, 2).number(cumulativeCount).style(summaryStyle);
      worksheet.cell(rowIndex, 3).string('Выполнено за неделю').style(summaryStyle);
      worksheet.cell(rowIndex, 4).number(weekData.items.length).style(summaryStyle);
      worksheet.cell(rowIndex, 5).string('Выполнено за месяц').style(summaryStyle);
      worksheet.cell(rowIndex, 6).number(monthCount).style(summaryStyle);
      worksheet.cell(rowIndex, 7).string('').style(summaryStyle);
      worksheet.cell(rowIndex, 8).string('').style(summaryStyle);
      rowIndex++;

      // Пустая строка между неделями
      rowIndex++;
    }

    // Ширина колонок
    const colWidths = [10, 15, 20, 35, 30, 10, 14, 20];
    colWidths.forEach((width, index) => {
      worksheet.column(index + 1).setWidth(width);
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=applications_checklist_${Date.now()}.xlsx`,
    );
    const buffer = await workbook.writeToBuffer();
    res.end(buffer);
  } catch (error) {
    serverLog.error(`❌ Ошибка экспорта applications: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
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

// ============================================================
// API ДЛЯ АКТИВНЫХ ЗАДАЧ
// ============================================================

// Получить все задачи регистрации (GET /api/tasks)
app.get('/api/tasks', (req, res) => {
  const activeTasksArray = taskManager.getAllTasks();
  
  // Получаем все регистрации из БД, сортируем по дате (новые первые)
  db.all(
    `SELECT 
       r.id,
       r.website,
       r.email,
       r.company,
       r.catalog,
       r.status,
       r.error,
       r.created_at,
       r.profile_url
     FROM registrations r
     ORDER BY r.created_at DESC
     LIMIT 100`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      // Преобразуем статусы в понятные форматы
      const dbTasks = rows.map(row => ({
        id: row.id,
        website: row.website,
        email: row.email,
        company: row.company,
        catalog: row.catalog,
        status: mapRegistrationStatus(row.status),
        error: row.error,
        created_at: row.created_at,
        profile_url: row.profile_url,
        isHistorical: true
      }));
      
      // Объединяем активные задачи и исторические (без дубликатов)
      const activeIds = new Set(activeTasksArray.map(t => t.tempId));
      const allTasks = [...activeTasksArray, ...dbTasks.filter(t => !activeIds.has(t.tempId))];
      
      res.json({ tasks: allTasks, count: allTasks.length });
    }
  );
});

// SSE STREAM — ПОДПИСКА НА ЗАДАЧИ В РЕАЛЬНОМ ВРЕМЕНИ
app.get('/api/tasks-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Отправляем текущие задачи сразу
  taskManager.sendInitialTasks(res);
  
  // Добавляем клиент
  taskManager.addTaskStreamClient(res);
});

// Преобразование статусов регистрации в статусы задач
function mapRegistrationStatus(status) {
  if (status === 'success') return 'success';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'pending' || status === 'in_progress') return 'active';
  if (status === 'captcha_required') return 'captcha_pending';
  if (status === 'queued') return 'queued';
  // По умолчанию считаем активными
  return 'active';
}

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
  serverLog.info(`📋 API задач:       http://localhost:${PORT}/api/tasks`);
  serverLog.info(`📡 SSE задач:       http://localhost:${PORT}/api/tasks-stream`);
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
