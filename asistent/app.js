const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const RegistrationAgent = require('./registration-agent');


const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));


// Инициализация базы данных
const db = new sqlite3.Database('./registrations.db');

// Маршруты
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/start-registration', async (req, res) => {
  const { website, email, apppassword, imapHost, port, directories} = req.body;
  console.log('Получены данные:', { website, email, apppassword, imapHost, port });

  try {
    const agent = new RegistrationAgent();
    const result = await agent.runRegistration(website, email, imapHost, port, apppassword, directories);

    res.json({
      success: true,
      message: 'Регистрация завершена',
      result
    });
  } catch (error) {
    console.error('Ошибка при запуске регистрации:', error);
    res.status(500).json({
      success: false,
      message: 'Ошибка при запуске регистрации',
      error: error.message
    });
  }
});

app.get('/results', (req, res) => {
  db.all('SELECT * FROM registrations ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
  console.log('Откройте браузер и перейдите на http://localhost:3000');
});
