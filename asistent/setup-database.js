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
    // Начальные данные
  const stmt = db.prepare(`INSERT INTO directories (name, url, captcha_status, is_active, is_test) VALUES (?, ?, ?, ?, ?)`);
  const initialDirs = [
    ['Отзовик', 'https://otzovik.com/signup.php', 'Капча', 1, 0],
    ['Тестовая страница', 'https://martynova0063-sudo.github.io/mms_test_repository/', 'Без капчи', 1, 1],
    ['Orgpage.ru', 'https://www.orgpage.ru/Cabinet/Create/', 'Без капчи', 1, 0],
    ['Cataloxy.ru', 'https://www.cataloxy.ru/reg.htm', 'Капча', 1, 0],
    ['Flado', 'https://my.flado.ru/registration', 'Без капчи', 1, 0],
   // ['Orgpage.ru', 'C:/Users/63_ma/OrgpageДобавление%20компании.html', 'Без капчи', 1],
   // ['Отзовик', 'file:///C:/Users/63_ma/Отзовик%20-%20Регистрация%20на%20сайте.html', 'Капча', 1],
   //  ['Cataloxy.ru', 'C:/Users/63_ma/Регистрация%20на%20Cataloxy.ru.html', 'Не проверен', 1],
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

