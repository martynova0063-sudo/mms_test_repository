const sqlite3 = require('sqlite3').verbose();

class RegistrationDB {
  constructor(dbPath = './registrations.db') {
    this.db = new sqlite3.Database(dbPath);
    this._initialized = this._init();
  }

  async init() {
    return this._initialized;
  }

  _init() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`
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
          )
        `, (err) => {
          if (err) return reject(err);
        });
        
        this.db.run(`
          CREATE TABLE IF NOT EXISTS directories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            captcha_status TEXT DEFAULT 'Не проверен',
            is_active INTEGER DEFAULT 1,
            favicon_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) return reject(err);
        });
        
        resolve();
      });
    });
  }

  async saveRegistrationData(website, email, login, password, profileUrl, status, company, directoryUrl, error) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO registrations (website, email, login, password, profile_url, status, company, catalog, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(website, email, login, password, profileUrl, status, company, directoryUrl, error, function(err) {
        stmt.finalize();
        if (err) {
          // Если INSERT не удался, пробуем UPDATE
          this.db.run(`
            UPDATE registrations 
            SET login=?, password=?, profile_url=?, status=?, company=?, catalog=?, error=?
            WHERE email=? AND catalog=?
          `, [login, password, profileUrl, status, company, directoryUrl, error, email, directoryUrl], function(updateErr) {
            if (updateErr) {
              reject(updateErr);
            } else {
              resolve(this.lastID || 0);
            }
          });
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

module.exports = RegistrationDB;
