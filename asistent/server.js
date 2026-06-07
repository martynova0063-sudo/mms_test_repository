const express = require('express');
const app = express();
const PORT = 3000;

// 1. СОЗДАЕМ МАССИВ ДЛЯ ЛОГОВ (Глобальная переменная)
// Храним только последние 100 записей, чтобы не забить память
let logs = [];
const MAX_LOGS = 100; 

/**
 * 2. ФУНКЦИЯ ДЛЯ ЗАПИСИ ЛОГА
 * Она делает две вещи:
 * - Добавляет запись в массив logs (чтобы браузер мог её забрать)
 * - Пишет в консоль терминала (чтобы видел ты)
 */
function serverLog(message) {
  const timestamp = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  
  const logEntry = `[${timestamp}] ${message}`;

  // Пишем в черный терминал (для разработчика)
  console.log(logEntry);

  // Добавляем в массив
  logs.push(logEntry);

  // Если логов стало больше лимита, удаляем самые старые (с начала массива)
  if (logs.length > MAX_LOGS) {
    logs.shift(); // Удаляет первый элемент
  }
}

// --- ЗАПУСК И ТЕСТОВЫЕ ЛОГИ ---
serverLog('🚀 Сервер запущен!');
serverLog(`📂 Рабочая папка: ${process.cwd()}`);
serverLog(`🆔 Версия Node: ${process.version}`);

// Отдаем статические файлы (твой HTML)
app.use(express.static(__dirname));

// 3. API ДЛЯ ПОЛУЧЕНИЯ ЛОГОВ (Чтобы браузер их забрал)
app.get('/api/logs', (req, res) => {
  res.json(logs);
});

// Пример эмуляции работы агента
app.post('/api/register', async (req, res) => {
  serverLog('📥 Получен запрос на регистрацию...');
  
  // Допустим, нам прислали список каталогов
  const directories = req.body.directories || []; 

  for (let i = 0; i < directories.length; i++) {
    const dir = directories[i];
    
    // 👇 ВОТ ЗДЕСЬ МЫ ВЫВОДИМ ЛОГ ДЛЯ КАЖДОЙ ДИРЕКТОРИИ 👇
    serverLog(`🚀 Начинаю обработку каталога #${i + 1}: ${dir.name || dir}`);
    
    // Имитация долгой работы (сеть, парсинг и т.д.)
    await new Promise(resolve => setTimeout(resolve, 1500)); 
    
    serverLog(`✅ Каталог #${i + 1} успешно обработан.`);
  }

  serverLog('🎉 Все каталоги обработаны.');
  res.json({ success: true, message: 'Готово' });
});

app.listen(PORT, () => {
  console.log(`🌐 Сервер доступен по адресу: http://localhost:${PORT}`);
});
