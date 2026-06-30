const Imap = require('imap');
const { simpleParser } = require('mailparser');

class EmailParser {
  /**
   * Получает код подтверждения из почты через IMAP.
   * @param {string} email - Email для проверки
   * @param {string} imapHost - IMAP хост
   * @param {string} port - Порт IMAP
   * @param {string} apppassword - Пароль приложения
   * @param {string} directoryType - Тип каталога (для специфических паттернов)
   */
  static async getConfirmationCode(email, imapHost, port, apppassword, directoryType = null) {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: email,
        password: 'jwgw bjlm rqzq wlzs',
        host: imapHost,
        port: port,
        tls: true,
        connTimeout: 20000,
        tlsOptions: { rejectUnauthorized: false },
      });

      imap.once('error', (err) => {
        console.error('Ошибка подключения к IMAP:', err);
        reject(err);
      });

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            console.error('Ошибка открытия папки INBOX:', err);
            reject(err);
            return;
          }
          // Критерии поиска зависят от типа каталога
          let searchCriteria;
          if (directoryType === 'b2b-center') {
            searchCriteria = [
              'UNSEEN',
              ['SUBJECT', ['b2b-center', 'B2B', 'подтверждение', 'verification', 'код', 'activate', 'register']],
              ['SINCE', new Date(Date.now() - 24 * 60 * 60 * 1000)],
            ];
          }
      else if (directoryType === 'irecommend') {
        searchCriteria = [
          'UNSEEN',
          ['SUBJECT', ['irecommend', 'IRecommend', 'подтверждение', 'verification', 'код', 'activate', 'register', 'email', 'confirm']],
          ['SINCE', new Date(Date.now() - 24 * 60 * 60 * 1000)],
        ];
          }
          else {
            searchCriteria = [
              'UNSEEN',
              ['SUBJECT', ['confirmation', 'код', 'verification', 'подтверждение']],
              ['SINCE', new Date(Date.now() - 24 * 60 * 60 * 1000)],
            ];
          }

          imap.search(searchCriteria, (err, results) => {
            if (err || !results || results.length === 0) {
              console.log('Письма с кодом не найдены по критериям. Ищем последнее письмо...');
              imap.search(['ALL', 'UNSEEN'], (errAll, allResults) => {
                if (errAll || !allResults || allResults.length === 0) {
                  console.log('Подходящих писем не найдено');
                  imap.end();
                  resolve(null);
                  return;
                }
                const latestEmailId = allResults[allResults.length - 1];
                EmailParser._fetchAndExtractCode(imap, latestEmailId, resolve, directoryType);
              });
            } else {
              const latestEmailId = results[results.length - 1];
              EmailParser._fetchAndExtractCode(imap, latestEmailId, resolve, directoryType);
            }
          });
        });
      });

      imap.connect();
    });
  }

  /**
   * Внутренняя функция: fetch письма и извлечение кода
   */
  static _fetchAndExtractCode(imap, emailId, resolve, directoryType = null) {
    const f = imap.fetch(emailId, { bodies: '' });

    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString();
        });
        stream.on('end', async () => {
          try {
            const parsed = await simpleParser(buffer);
            const text = parsed.text || parsed.html;
            const code = EmailParser.extractCodeFromEmail(text, directoryType);

            if (code) {
              console.log(`Найден код подтверждения: ${code}`);
              imap.end();
              resolve(code);
            } else {
              console.log('Код не найден в письме');
              imap.end();
              resolve(null);
            }
          } catch (parseErr) {
            console.error('Ошибка парсинга письма:', parseErr);
            imap.end();
            resolve(null);
          }
        });
      });
    });

    f.once('end', () => {
      // ничего не делаем — результат уже обработан
    });
  }

  /**
   * Извлекает код из текста письма.
   * @param {string} text - Текст письма
   * @param {string} directoryType - Тип каталога
   */
  static extractCodeFromEmail(text, directoryType = null) {
    if (!text) return null;

    // Специфические паттерны для B2B Center
    if (directoryType === 'b2b-center') {
      // B2B Center может использовать разные форматы кода
      const patterns = [
        /\b\d{4,8}\b/,           // 4-8 цифр
        /code[:\s]*(\d{4,8})/i,  // Code: 123456
        /код[:\s]*(\d{4,8})/i,   // Код: 123456
        /activate[:\s]*([A-Z0-9]{4,8})/i,  // Activate: ABC123
        /verification[:\s]*([A-Z0-9]{4,8})/i,
      ];
      
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          // Возвращаем группу захвата, если она есть, или полное совпадение
          return match[1] || match[0];
        }
      }
    }

    // Специфические паттерны для iRecommend
    if (directoryType === 'irecommend') {
      // iRecommend обычно отправляет код в разных форматах
      const patterns = [
        /\b\d{4,6}\b/,                      // 4-6 цифр
        /code[:\s]*(\d{4,6})/i,            // Code: 123456
        /код[:\s]*(\d{4,6})/i,             // Код: 123456
        /verification[:\s]*(\d{4,6})/i,    // Verification: 123456
        /confirm[:\s]*(\d{4,6})/i,         // Confirm: 123456
        /your code is[:\s]*(\d{4,6})/i,    // Your code is: 123456
        /your confirmation code is[:\s]*(\d{4,6})/i,
        /code:\s*(\d{4,6})/i,              // Code: 123456
        /(\d{4,6})\s*для\s*подтверждения/i, // 123456 для подтверждения
      ];
      
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          return match[1] || match[0];
        }
      }
    }

    // Стандартный паттерн — 6 цифр
    const codeRegex = /\b\d{6}\b/;
    const match = text.match(codeRegex);
    return match ? match[0] : null;
  }
}

module.exports = EmailParser;
