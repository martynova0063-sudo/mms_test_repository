const { serverLog } = require('./logger');

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
            is_test INTEGER DEFAULT 0,
            favicon_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) return reject(err);
        });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            external_id TEXT NOT NULL UNIQUE,
            conversation_url TEXT NOT NULL,
            company TEXT,
            status TEXT DEFAULT 'UNKNOWN',
            applied_at TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) return reject(err);
        });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            sender TEXT,
            text TEXT,
            content TEXT,
            created_at DATETIME DEFAULT (datetime('now')),
            FOREIGN KEY (chat_id) REFERENCES chats (id)
          )
        `, (err) => {
          if (err) return reject(err);
        });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vacancy TEXT NOT NULL,
            company TEXT NOT NULL,
            is_viewed INTEGER DEFAULT 0,
            employer_status TEXT DEFAULT 'Не просмотрен',
            response_rate INTEGER DEFAULT 0,
            chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
            chat_url TEXT,
            boost_url TEXT,
            applied_at TEXT NOT NULL,
            applied_dt TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) return reject(err);
          resolve();
        });

        resolve();
      });
    });
  }

  /**
   * Ищет чат по external_id. Возвращает строку или null.
   */
  async findChatByExternalId(external_id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM chats WHERE external_id = ?',
        [external_id],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  }

  /**
   * Ищет отклик по вакансии и компании. Возвращает строку или null.
   */
  async findApplicationByVacancy(vacancy, company) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM applications WHERE vacancy = ? AND company = ?',
        [vacancy, company],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  }

  /**
   * Возвращает множество текстов существующих сообщений для чата.
   */
  async getExistingMessageTexts(chatId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT text FROM chat_messages WHERE chat_id = ?',
        [chatId],
        (err, rows) => {
          if (err) return reject(err);
          const set = new Set((rows || []).map(r => (r.text || '').trim()));
          resolve(set);
        }
      );
    });
  }

  /**
   * Создаёт отклик и связанный чат атомарно.
   */
async createApplicationWithChat(app, chat) {
  return new Promise((resolve, reject) => {
    const self = this;
    self.db.serialize(() => {
      self.db.run('BEGIN TRANSACTION');

      // Чат — applied_at берём из данных, а не из datetime('now')
      self.db.run(
        `INSERT INTO chats
           (external_id, conversation_url, company, status, applied_at, applied_dt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chat.external_id,
          chat.conversation_url,
          chat.company,
          chat.status || 'UNKNOWN',
          chat.applied_at,
          chat.applied_dt || null,
          chat.applied_at,  // created_at = дата отклика
          chat.applied_at   // updated_at = дата отклика
        ],
        function (err) {
          if (err) {
            self.db.run('ROLLBACK');
            return reject(new Error('Ошибка при создании чата: ' + err.message));
          }

          const chatId = this.lastID;

          self.db.run(
            `INSERT INTO applications
               (vacancy, company, is_viewed, employer_status, response_rate,
                chat_id, chat_url, boost_url, applied_at, applied_dt, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              app.vacancy,
              app.company,
              app.is_viewed ? 1 : 0,
              app.employer_status || 'Не просмотрен',
              app.response_rate || 0,
              chatId,
              app.chat_url || null,
              app.boost_url || null,
              app.applied_at,                                                    // applied_at — дата+время отклика
              app.applied_dt || null,                                            // applied_dt — только дата
              app.applied_at,                                                    // created_at — дата отклика
              app.applied_at                                                     // updated_at — дата отклика
            ],
            function (err) {
              if (err) {
                self.db.run('ROLLBACK');
                return reject(new Error('Ошибка при создании отклика: ' + err.message));
              }
              const applicationId = this.lastID;
              self.db.run('COMMIT', (err) => {
                if (err) return reject(err);
                resolve({ chatId, applicationId });
              });
            }
          );
        }
      );
    });
  });
}


  async getAllDirectories() {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM directories ORDER BY name', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
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
