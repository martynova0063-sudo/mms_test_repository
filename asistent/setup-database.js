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
      address TEXT,
      phone TEXT 
    )
  `);

  console.log('База данных инициализирована!');
});

db.close();
