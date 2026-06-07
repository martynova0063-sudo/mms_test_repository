const { chromium } = require('playwright');
const sqlite3 = require('sqlite3').verbose();
const Imap = require('imap');
const { SimpleParser } = require('mailparser');
let logs = [];

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
      logs.push('Запуск браузера...');
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
      logs.push('Браузер успешно запущен');
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
      console.log(document.querySelector('[id="phone"] p'));
        

      return {
        name: document.querySelector('h1')?.innerText.trim() ||
               document.title || 'Неизвестно',
        description: document.querySelector('meta[name="description"]')
          ?.getAttribute('content') || 'Неизвестно',
        logoUrl: logoUrl || null, // сохраняем URL логотипа
        address:  document.querySelector('meta[name="address"]')
          ?.getAttribute('content') ||'Казань', 
        phone: document.querySelector('meta[name="phone"]')
          ?.getAttribute('content') || '+7(495)222-22-00'
          };
      });
    console.log('Имя компаниии', data.phone);
    //await page.$eval('#phone p', el => el.textContent.trim())

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
          connTimeout: 20000, // 15 секунд таймаут
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

   /* try {         
      await this.page.waitForSelector('input[name="termofuse"]', { timeout: 10 });
      await this.page.evaluate(() => {
      const checkbox = document.querySelector('input[name="termofuse"]');
      if (checkbox) {
        checkbox.disabled = false; // снимаем блокировку
        checkbox.checked = true; } // ставим галочку  
      });
      console.log(`Принимаем соглашение`);  
      } catch (error) {console.log('Отметка о соглашении не найдена - пропускаем');}   
*/
    
   // await this.page.fill('input[name="cityTitle"]', websiteData.address);    
   // await this.page.waitForSelector('.ui-autocomplete .ui-menu-item', { timeout: 10000 });
   // await this.page.click('.ui-autocomplete .ui-menu-item:has-text(`Регистрация на ${websiteData.address}...`)');

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
  'input[name="phone"]:visible',
  'input[name="city"]:visible', 
  'input[name="cityTitle"]:visible', 
  'input[name="index"]:visible', 
  'textarea[name="CatalogDescription"]:visible', 
  '#CatalogDescription',
  'textarea[name="FullDescription"]:visible', 
  '#FullDescription',
  'input[name="termofuse"]:visible'
];

for (const selector of selectors) {
  const element = await this.page.$$(selector);
  if (element.length > 0) {
    try {
      if (selector.includes('name')) {
        await this.page.fill(selector, websiteData.name);
        console.log(`Заполнили имя компании успешно ${directoryUrl}...`);
      } 
      if (selector.includes('CatalogDescription')) {
        await this.page.locator('#CatalogDescription').fill(websiteData.name);
      } 
      if (selector.includes('FullDescription')) {
          await this.page.locator('#FullDescription').fill(websiteData.description);
      }
      if (selector.includes('password') || selector.includes('pass')) {
        await this.page.fill(selector, password);
        console.log(`Заполнили password успешно ${password}...`);
      } 
      if (selector.includes('login') || selector.includes('newlogin')) {
        await this.page.fill(selector, password+'login');
      } 
      if (selector.includes('email')){
          await this.page.fill(selector, email);
      } 
      if (selector.includes('address')) {   
        await this.page.fill(selector,  websiteData.address);
        console.log(`Заполнили адресс компании успешно ${directoryUrl}...`);
      } 
      if (selector.includes('city')) {   
        await this.page.fill(selector,  websiteData.address);
        console.log(`Заполнили город компании успешно ${directoryUrl}...`);
      } 
      if (websiteData.phone && selector.includes('phone')) {
        await this.page.fill(selector, websiteData.phone);
      } 
      if (selector.includes('index')) {   
        // 2. Разбираем номер
        const match = websiteData.phone.match(/\+(\d{1,3})\s*\((\d{3})\)\s*(\d{3}-\d{2}-\d{2})/);

        if (match) {
          const result = {
           countryCode: match[1],
           areaCode: match[2],
           number: match[3] };
           await this.page.fill('input[name="index"]', result.areaCode); 
           await this.page.fill('input[name="number"]', result.number);
          }
      } 
      if (selector.includes('termofuse')) {   
         console.log(`✅ - Вход.Заполнено поле: termofuse`);
         const checkbox = document.querySelector('input[name="termofuse"]');
        if (checkbox) {
        checkbox.disabled = false; // снимаем блокировку
        checkbox.checked = true; } // ставим галочку  
      }

      console.log(`✅ - Заполнено поле: ${selector}`);
    } catch (error) {
      console.log(`⚠️ - Ошибка при заполнении ${selector}:`, error.message);
    }
  } else {
    console.log(`ℹ️ - Элемент ${selector} не найден - пропускаем`);
  }
}  
    await new Promise(resolve => setTimeout(resolve, 20000));
    // Нажимаем кнопку «Получить код»
    console.log('Нажимаем кнопку "Получить код"...');
    await this.page.click('button[type="submit"]');

    // Добавляем задержку 10 секунд после нажатия кнопки
    console.log('Ждём 10 секунд после отправки формы...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Получаем код подтверждения из Gmail
    try{
     const confirmationCode = this.getConfirmationCode(email, imapHost, port, apppassword); 
     await this.saveRegistrationData(websiteData.website, 
                                    email, 
                                    login, 
                                    password, 
                                    profileUrl, 
                                    'success', 
                                    websiteData.name,
                                    directoryUrl,
                                    '');
      
     console.log(`Регистрация завершена: ${profileUrl}`);                              
    } 
     catch (error) {
     // Сохраняем ошибку в базу данных
     this.saveRegistrationData(websiteData.website, 
                                    email, 
                                    login, 
                                    password, 
                                    profileUrl, 
                                    'error', 
                                    websiteData.name,
                                    directoryUrl,
                                    error.message);
    }
    return { success: true, profileUrl };
  }

  async saveRegistrationData(website, email, login, password, profileUrl, status, company, directoryUrl, error) {
    const stmt = this.db.prepare(`
      INSERT INTO registrations (website, email, login, password, profile_url, status, company, catalog, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(website, email, login, password, profileUrl, status, company, directoryUrl, error);
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

    const directoriesArray = Array.isArray(directories) ? directories : [directories];

    try {
      // Парсим данные с сайта
      const websiteData = await this.parseWebsiteData(website);
      websiteData.website = website;

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
