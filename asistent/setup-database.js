const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./registrations.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website TEXT NOT NULL,
      email TEXT NOT NULL,
      login TEXT NOT NULL,
      password TEXT NOT NULL,
      profile_url TEXT,
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      company TEXT,
      catalog TEXT,
      error TEXT
    )`);
  db.run(`CREATE TABLE IF NOT EXISTS directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    captcha_status TEXT DEFAULT 'Не проверен',
    is_active INTEGER DEFAULT 1,
    is_test INTEGER DEFAULT 0,
    favicon_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    conversation_url TEXT,
    company TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    applied_at TEXT,
    applied_dt TEXT,
    last_response_at TEXT,
    last_message_at TEXT,
    last_message_direction TEXT DEFAULT 'incoming',
    new_message_at TEXT,
    message_preview TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
    // Таблица откликов — карточка, а не учётка и не переписка
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
  `);
  //Таблица сообщений
  db.run(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender TEXT,
    text TEXT,
    content TEXT,
    msg_date TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (chat_id) REFERENCES chats (id)
  )
`);
  // Индекс для быстрого поиска откликов по чату
  db.run(`CREATE INDEX IF NOT EXISTS idx_applications_chat_id ON applications(chat_id)`);
  // Индекс для поиска по компании
  db.run(`CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company)`);

    // Начальные данные
  const stmt = db.prepare(`INSERT INTO directories (name, url, captcha_status, is_active, is_test) VALUES (?, ?, ?, ?, ?)`);
  const initialDirs = [
    ['Отзовик', 'https://otzovik.com/signup.php', 'Капча', 1, 0],
    ['Тестовая страница', 'https://martynova0063-sudo.github.io/mms_test_repository/', 'Без капчи', 1, 1],
    ['HH.ru', 'https://samara.hh.ru/account/login?role=applicant&backurl=%2F&hhtmFrom=main', 'Без капчи', 1, 0],
    ['Orgpage.ru', 'https://www.orgpage.ru/Cabinet/Create/', 'Без капчи', 1, 0],
    ['Cataloxy.ru', 'https://www.cataloxy.ru/reg.htm', 'Капча', 1, 0],
    ['Flado', 'https://my.flado.ru/registration', 'Без капчи', 1, 0],
    ['Flagma', 'https://flagma.ru/registration', 'Капча', 1, 0],
   // ['Orgpage.ru', 'C:/Users/63_ma/OrgpageДобавление%20компании.html', 'Без капчи', 1],
   // ['Отзовик', 'file:///C:/Users/63_ma/Отзовик%20-%20Регистрация%20на%20сайте.html', 'Капча', 1],
   // ['Cataloxy.ru', 'C:/Users/63_ma/Регистрация%20на%20Cataloxy.ru.html', 'Не проверен', 1],
    ['B2B-Center', 'https://www.b2b-center.ru/app/next/registration/', 'Не проверен', 1, 0],
    ['Irecommend.ru', 'https://irecommend.ru/user/register', 'Капча', 1, 0]/*,
    ['Blizko.ru', 'https://blizko.ru', 'Не проверен', 1],
    ['business.ngs.ru', 'https://business.ngs.ru', 'Капча', 1],
    ['Spravker.ru', 'https://www.spravker.ru', 'Не проверен', 1],
    ['Firmika.ru', 'https://firmika.ru', 'Не проверен', 1],
    ['Moneyveo', 'https://www.moneyveo.ru', 'Не проверен', 1],
    ['Kompas.ru', 'https://kompas.ru', 'Капча', 1],
    ['Rusprofile.ru', 'https://rusprofile.ru', 'Капча', 1],
    ['Exportbase', 'https://exportbase.ru', 'Не проверен', 1],
    ['Flamp.ru', 'https://flamp.ru', 'Капча', 1],
    ['Tripadvisor', 'https://www.tripadvisor.ru', 'Капча', 1],
    ['Yell.ru', 'https://www.yell.ru', 'Не проверен', 1],
    ['Zoon.ru', 'https://zoon.ru', 'Капча', 1],
    ['Google Мой бизнес', 'https://business.google.com', 'Капча', 1],
    ['Яндекс Бизнес', 'https://business.yandex.ru', 'Капча', 1],
    ['2GIS', 'https://2gis.ru', 'Капча', 1]*/
  ];
  initialDirs.forEach(([name, url, captcha, active, test]) => {
    stmt.run(name, url, captcha, active ? 1 : 0, test ? 1 : 0);
  });
  stmt.finalize(() => {
    console.log('📁 Таблица каталогов инициализирована');
  });

  console.log('База данных инициализирована!');
  db.close((err) => {
    if (err) {
      console.error('Ошибка при закрытии БД:', err);
      process.exit(1);
    }
    console.log('Соединение с БД закрыто.');
    process.exit(0);
  });
});

