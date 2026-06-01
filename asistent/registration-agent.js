const { chromium } = require('playwright');
const sqlite3 = require('sqlite3').verbose();
const Imap = require('imap');
const { SimpleParser } = require('mailparser');

class RegistrationAgent {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.db = new sqlite3.Database('./registrations.db');
  }

  async initialize() {
    try {
      console.log('Запуск браузера...');
      this.browser = await chromium.launch({
        headless: false,
        slowMo: 100,
        args: ['--start-maximized']
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 }
      });

      this.page = await this.context.newPage();
      console.log('Браузер успешно запущен');
      return true;
    } catch (error) {
      console.error('Ошибка инициализации Playwright:', error);
      await this.cleanup();
      return false;
    }
  }

  async cleanup() {
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
  }


  async parseWebsiteData(websiteUrl) {
    await this.page.goto(websiteUrl, { waitUntil: 'networkidle', timeout: 60000 });

      const data = await this.page.evaluate(() => {
     // Поиск логотипа по распространённым селекторам
      const logoSelectors = [
        'link[rel="icon"]',
        'link[rel="shortcut icon"]',
        '[href*="favicon"]', // любой href с "favicon"
        'img[alt*="logo"]',
        '.logo img',
        '#logo',
        'header img',
        '[class*="logo"] img'];

      let logoUrl = null;
      for (const selector of logoSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          // Для link получаем href, для img — src
          logoUrl = element.href || element.src;
          if (logoUrl) break;}
        }

      return {
        name: document.querySelector('h1')?.innerText.trim() ||
               document.title || 'Неизвестно',
        description: document.querySelector('meta[name="description"]')
          ?.getAttribute('content') || 'Неизвестно',
        logoUrl: logoUrl || null // сохраняем URL логотипа
          };
      });
    console.log('Имя компаниии', data.name);

    return data;
  }

  async getConfirmationCode(email, imapHost, port, apppassword) {
    console.log(`Поиск кода подтверждения в почте: ${email}`);

      return new Promise((resolve, reject) => {
        const imap = new Imap({
          user: email,
          password: apppassword,
          host: imapHost,
          port: port,
          tls: true,
          connTimeout: 15000, // 15 секунд таймаут
          tlsOptions: { rejectUnauthorized: false } // Отключаем проверку сертификата
        });
    
        // Обработка ошибок подключения
        imap.once('error', (err) => {
          console.error('Ошибка подключения к Gmail:', err);
          reject(err);
        });
        // Когда подключение установлено
        imap.once('ready', () => {
        // Открываем папку INBOX
        imap.openBox('INBOX', false, async (err, box) => {
          if (err) {
            console.error('Ошибка открытия папки INBOX:', err);
            reject(err);
            return; }
          console.log('Ищем последнее письмо с кодом подтверждения...');
          // Критерии поиска: непрочитанные письма за последние 24 часа с ключевыми словами
          const searchCriteria = [
           'UNSEEN',
            ['SUBJECT', ['confirmation', 'код', 'verification', 'подтверждение']],
            ['SINCE', new Date(Date.now() - 24 * 60 * 60 * 1000)] // за последние 24 часа
                 ];
          imap.search(searchCriteria, async (err, results) => {
            if (err || !results || results.length === 0) {
             console.log('Письма с кодом не найдены по критериям. Ищем последнее письмо...');
             // Если не нашли по критериям, берём последнее полученное письмо
             imap.search(['ALL', 'UNSEEN'], (errAll, allResults) => {
                if (errAll || !allResults || allResults.length === 0) {
                  console.log('Подходящих писем не найдено');
                  imap.end();
                  resolve(null);
                  return;  }
                // Берём самое свежее письмо
                const latestEmailId = allResults[allResults.length - 1];
                this.fetchAndExtractCode(imap, latestEmailId, resolve);
             });
             } else {
               // Берём самое свежее письмо из найденных по критериям
               const latestEmailId = results[results.length - 1];
               this.fetchAndExtractCode(imap, latestEmailId, resolve);
          }
        });
      });
    });
       // Запускаем подключение
       imap.connect();
  });  
 }

fetchAndExtractCode = (imap, emailId, resolve) => {
  const f = imap.fetch(emailId, { bodies: '' });

  f.on('message', (msg) => {
    msg.on('body', async (stream) => {
      let buffer = '';
      stream.on('data', (chunk) => { buffer += chunk.toString(); });
      stream.on('end', async () => {
        try {
          const { simpleParser } = require('mailparser');
          const parsed = await simpleParser(buffer);
          const code = this.extractCodeFromEmail(parsed.text || parsed.html);

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
    console.log('Поиск кода завершён');
  });
}

  extractCodeFromEmail(text) {
  // Регулярное выражение для поиска 6‑значного кода
  const codeRegex = /\b\d{6}\b/;
  const match = text.match(codeRegex);
  return match ? match[0] : null;}

  async registerInDirectory(directoryUrl, websiteData, email, imapHost, port, apppassword) {
    console.log(`Регистрация на ${directoryUrl}...`);
    await this.page.goto(directoryUrl);
    // Заполнение формы регистрации

    try {         
      await this.page.waitForSelector('input[name="termofuse"]', { timeout: 1000 });
      await this.page.evaluate(() => {
      const checkbox = document.querySelector('input[name="termofuse"]');
      if (checkbox) {
        checkbox.disabled = false; // снимаем блокировку
        checkbox.checked = true; } // ставим галочку  
      });
      console.log(`Принимаем соглашение`);  
      } catch (error) {console.log('Отметка о соглашении не найдена - пропускаем');}    

    // Сохранение данных
    const profileUrl = this.page.url();
    const login = email;
    const password = Math.random().toString(36).slice(-8); // простой пароль

const selectors = [
  'input[name="password"]:visible',
  'input[name="pass"]:visible',
  'input[name="login"]:visible',
  'input[name="newlogin"]:visible',
  'input[name="email"]:visible',
  'input[name="name"]:visible',
  'input[name="address"]:visible',
  'input[name="phone"]:visible'
];

for (const selector of selectors) {
  const element = await this.page.$$(selector);
  if (element.length > 0) {
    try {
      if (selector.includes('password') || selector.includes('pass')) {
        await this.page.fill(selector, password);
        console.log(`Заполнили password успешно ${password}...`);
      } else if (selector.includes('login') || selector.includes('newlogin')) {
        await this.page.fill(selector, password+'login');
      } else if (selector.includes('email')){
          await this.page.fill('input[name="email"]:visible', email);
         // console.log(`Заполнили email успешно ${directoryUrl}...`);
      } else if (websiteData.name && selector.includes('name')) {
        await this.page.fill('input[name="name"]:visible', websiteData.name);
        console.log(`Заполнили имя компании успешно ${directoryUrl}...`);
      } else if (websiteData.name && selector.includes('name')) {
        await this.page.fill('input[name="address"]:visible', websiteData.address);
       // console.log(`Заполнили имя компании успешно ${directoryUrl}...`);
      } else if (websiteData.name && selector.includes('name')) {
        await this.page.fill('input[name="phone"]:visible', websiteData.phone);
       // console.log(`Заполнили имя компании успешно ${directoryUrl}...`);
      }
      console.log(`Заполнено поле: ${selector}`);
    } catch (error) {
      console.log(`Ошибка при заполнении ${selector}:`, error.message);
    }
  } else {
    console.log(`Элемент ${selector} не найден - пропускаем`);
  }
}  

    // Нажимаем кнопку «Получить код»
    console.log('Нажимаем кнопку "Получить код"...');
    await this.page.click('button[type="submit"]');

    // Добавляем задержку 10 секунд после нажатия кнопки
    console.log('Ждём 10 секунд после отправки формы...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Получаем код подтверждения из Gmail
    const confirmationCode = await this.getConfirmationCode(email, imapHost, port, apppassword);

    await this.saveRegistrationData(websiteData.website, 
                                    email, 
                                    login, 
                                    password, 
                                    profileUrl, 
                                    'success', 
                                    websiteData.name,
                                    websiteData.address,
                                    websiteData.phone);

    console.log(`Регистрация завершена: ${profileUrl}`);
    return { success: true, profileUrl };
  }

  async saveRegistrationData(website, email, login, password, profileUrl, status, company, address, phone) {
    const stmt = this.db.prepare(`
      INSERT INTO registrations (website, email, login, password, profile_url, status, company, address, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(website, email, login, password, profileUrl, status, company, address, phone);
    stmt.finalize();
  }

  async runRegistration(website, email, imapHost, port, apppassword, directories) {
    if (!(await this.initialize())) {
      throw new Error('Не удалось инициализировать Playwright');
    }
      // Валидация: хотя бы одна директория выбрана
    if (!directories || directories.length === 0) {
       return res.status(400).json({
        success: false,
        error: 'Необходимо выбрать хотя бы одну директорию'
      });
     }

    // Гарантируем, что directories — массив (на случай выбора одного элемента)
    const directoriesArray = Array.isArray(directories) ? directories : [directories];

    try {
      // Парсим данные с сайта
      const websiteData = await this.parseWebsiteData(website);
      websiteData.website = website;

      // Список каталогов для регистрации, список платформ куда нужно зарегистрировать website
     // const directories = [
       // 'https://www.liveinternet.ru/add_url.html',
      // 'https://top100.rambler.ru/submit/',
      //  'https://martynova0063-sudo.github.io/mms_test_repository/', 
      //  'https://otzovik.com/signup.php'
     // ];
  
      const results = [];
      for (const directory of directoriesArray) {
        try {
          const result = await this.registerInDirectory(directory, websiteData, email, imapHost, port, apppassword);
          results.push(result);
        } catch (error) {
          console.error(`Ошибка регистрации в ${directory}:`, error);
          results.push({ success: false, error: error.message });
        }
      }

      return { success: true, results };
    } catch (error) {
      console.error('Критическая ошибка:', error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }
}

module.exports = RegistrationAgent;
