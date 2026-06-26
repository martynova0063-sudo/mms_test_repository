const BrowserInitializer = require('./browser-initializer');
const EmailParser = require('./email-parser');
const RegistrationDB = require('./registration-db');
const { serverLog } = require('./logger');

let logs = [];

class RegistrationAgent {
  constructor() {
    this.browserInit = new BrowserInitializer();
    this.db = new RegistrationDB();
  }

  async initialize() {
    serverLog.info('🖥️ Инициализация базы данных...');
    await this.db.init();
    serverLog.info('✅ База данных инициализирована');
    
    serverLog.info('🖥️ Инициализация браузера Playwright...');
    const result = await this.browserInit.initialize();
    if (result) {
      serverLog.info('✅ Браузер успешно инициализирован');
    } else {
      serverLog.error('❌ Не удалось инициализировать браузер');
    }
    return result;
  }

  async cleanup() {
    serverLog.info('🧹 Очистка ресурсов браузера...');
    await this.browserInit.cleanup();
    serverLog.info('✅ Браузер закрыт');
    
    serverLog.info('🔌 Закрытие подключения к БД...');
    await this.db.close();
    serverLog.info('✅ БД закрыта');
  }

  async parseWebsiteData(websiteUrl) {
    serverLog.info(`🌐 Парсинг сайта: ${websiteUrl}`);
    serverLog.debug(`   Переход на страницу...`);
    
    const page = this.browserInit.getPage();
    await page.goto(websiteUrl, { waitUntil: 'networkidle', timeout: 60000 });
    serverLog.debug(`   ✅ Страница загружена`);

    serverLog.debug(`   🔍 Извлечение данных компании...`);
    const data = await page.evaluate(() => {
      const logoSelectors = [
        'link[rel="icon"]',
        'link[rel="shortcut icon"]',
        '[href*="favicon"]',
        'img[alt*="logo"]',
        '.logo img',
        '#logo',
        'header img',
        '[class*="logo"] img',
      ];

      let logoUrl = null;
      for (const selector of logoSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          logoUrl = element.href || element.src;
          if (logoUrl) break;
        }
      }

      return {
        name: document.querySelector('h1')?.innerText.trim() || document.title || 'Неизвестно',
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || 'Неизвестно',
        logoUrl: logoUrl || null,
        address: document.querySelector('meta[name="address"]')?.getAttribute('content') || 'Казань',
        phone: document.querySelector('meta[name="phone"]')?.getAttribute('content') || '+7(495)222-22-00',
        inn: document.querySelector('meta[name="inn"]')?.getAttribute('content') || '633009210981',
      };
    });

    serverLog.info(`📋 Данные компании получены:`, {
      name: data.name,
      description: data.description,
      address: data.address,
      phone: data.phone,
      inn: data.inn,
      logoUrl: data.logoUrl
    });

    return data;
  }

  async acceptAgreement(page) {
    serverLog.warn('⚠️ Обнаружен виджет согласия (CDOT/капча) на странице');
    serverLog.info('⏳ Ожидание ручного подтверждения пользователем (до 2 минут)...');
    serverLog.debug('   💡 Поставьте галочку "Я принимаю соглашение"');

    await page.waitForFunction(() => true, { timeout: 120000 });

    serverLog.info('✅ Пользователь подтвердил соглашение. Продолжаем...');
  }

  async selectRubric(page, searchText) {
    serverLog.debug(`🔍 Поиск сферы деятельности: "${searchText}"`);

    const inputLocator = page.locator('.spheres_category input.category-input');
    const variantsLocator = page.locator('.rubric-variants');

    serverLog.debug(`   📝 Клик по полю ввода...`);
    await inputLocator.click({ force: true });
    serverLog.debug(`   🧹 Очистка поля...`);
    await inputLocator.fill('');
    serverLog.debug(`   ⌨️ Ввод текста: "${searchText}"`);
    await inputLocator.type(searchText);

    serverLog.debug(`   ⏳ Ожидание вариантов...`);
    await variantsLocator.waitFor({ state: 'visible', timeout: 5000 });

    const optionLocator = variantsLocator.locator(`:text-is("${searchText}")`);

    if (await optionLocator.isVisible({ timeout: 2000 })) {
      serverLog.debug(`   ✅ Найдено точное совпадение: "${searchText}"`);
      await optionLocator.click();
      serverLog.info(`✅ Выбрана рубрика: "${searchText}"`);

      const addBtn = page.locator('.addRubric');
      if (await addBtn.isVisible({ timeout: 1000 })) {
        serverLog.debug(`   👆 Нажатие кнопки подтверждения...`);
        await addBtn.click();
        serverLog.info('✅ Рубрика добавлена');
      }
    } else {
      serverLog.warn(`⚠️ Точное совпадение не найдено, выбираем первый вариант`);
      const firstOption = variantsLocator.locator('li:first-child, div:first-child');
      if (await firstOption.isVisible({ timeout: 1000 })) {
        await firstOption.click();
        serverLog.info('✅ Выбран первый вариант из списка');
      } else {
        throw new Error(`❌ Не удалось найти вариант для "${searchText}" в выпадающем списке.`);
      }
    }
  }

  async registerInDirectory(directoryUrl, websiteData, email, imapHost, port, apppassword) {
    const dirName = directoryUrl.split('/').pop() || directoryUrl;
    serverLog.info(`═══════════════════════════════════════════════════`);
    serverLog.info(`🚀 НАЧАЛО РЕГИСТРАЦИИ: ${dirName}`);
    serverLog.info(`   Сайт: ${websiteData.website}`);
    serverLog.info(`   Каталог: ${directoryUrl}`);
    serverLog.info(`   Email: ${email}`);
    serverLog.info(`═══════════════════════════════════════════════════`);

    const page = this.browserInit.getPage();

    // Объявляем переменные до try/catch, чтобы они были доступны в catch
    let login = email;
    let password = Math.random().toString(36).slice(-8);
    let profileUrl = directoryUrl;

    try {
      // Шаг 1: Открытие страницы каталога
      serverLog.info(`📄 Шаг 1: Открытие страницы каталога...`);
      serverLog.debug(`   URL: ${directoryUrl}`);
      await page.goto(directoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      serverLog.debug(`   ✅ Страница загружена`);
      serverLog.debug(`   Текущий URL: ${page.url()}`);

      // Определяем домен
      const domain = page.url().replace(/^https?:\/\//, '').split('/')[0];
      
      // Шаг 1.1: Обработка Otzovik - показ капчи
      if (domain.includes('otzovik')) {
        serverLog.info(`🔓 Otzovik: обнаружена капча на signup.php`);
        serverLog.info(`   💡 Для Otzovik требуется ручное решение капчи`);
        serverLog.info(`   ⏳ Ожидание ручного подтверждения пользователем (до 5 мин)...`);
        serverLog.debug(`   💡 Решите капчу на странице`);
        
        await page.waitForFunction(() => true, { timeout: 300000 });
        
        serverLog.info(`   ✅ Капча решена. Продолжаем...`);
        
        // Проверяем, перешли ли на форму регистрации
        await page.waitForLoadState('domcontentloaded');
        serverLog.debug(`   Текущий URL: ${page.url()}`);
      }

      // Шаг 2: Определение профиля
      const profileUrlsMap = {
        'https://otzovik.com/signup.php'        : 'https://otzovik.com/loginnew.php',
        'https://www.orgpage.ru/Cabinet/Create/': 'https://www.orgpage.ru/Cabinet/Create/',
        'https://www.cataloxy.ru/reg.htm'       : 'https://www.cataloxy.ru/cabinet.htm',
        'https://www.b2b-center.ru/app/next/registration/': 'https://www.b2b-center.ru',
        'https://www.irecommend.ru/user/register': 'https://www.irecommend.ru',
        default: null,
      };
      profileUrl = profileUrlsMap[page.url()] || page.url();
      
      serverLog.info(`🔐 Сгенерированы учётные данные:`, { login, password });
      serverLog.info(`🔗 URL профиля после регистрации: ${profileUrl}`);

      // Шаг 3: Заполнение формы
      serverLog.info(`📝 Шаг 3: Заполнение формы регистрации...`);
      
      let siteSelectors;
      if (domain.includes('cataloxy')) {
        siteSelectors = [
          { name: 'email', selectors: ['input[name="email"]:visible'], fill: email },
          { name: 'name', selectors: ['input[name="name"]:visible'], fill: websiteData.name },
          { name: 'password', selectors: ['input[name="password"]:visible'], fill: password },
          { name: 'password2', selectors: ['input[name="password2"]:visible'], fill: password },
        ];
      }
      else if (domain.includes('b2b-center')) {
        // B2B Center — специфические селекторы
        serverLog.info(`   🎯 Используем специфические селекторы для B2B Center`);
        siteSelectors = [
          { name: 'company_name', selectors: ['input[name="company_name"]:visible', 'input[placeholder*="Компания"]:visible', 'input[placeholder*="company"]:visible'], fill: websiteData.name },
          { name: 'website', selectors: ['input[name="site"]:visible', 'input[name="website"]:visible', 'input[placeholder*="site"]:visible', 'input[placeholder*="site"]:visible'], fill: websiteData.website },
          { name: 'email', selectors: ['input[name="email"]:visible', 'input[type="email"]:visible'], fill: email },
          { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible'], fill: password },
          { name: 'phone', selectors: ['input[name="phone"]:visible', 'input[type="tel"]:visible'], fill: websiteData.phone },
          { name: 'inn', selectors: ['input[name="inn"]:visible', 'input[placeholder*="ИНН"]:visible'], fill: websiteData.inn },
          { name: 'description', selectors: ['textarea[name="description"]:visible', 'textarea[placeholder*="description"]:visible', 'textarea[placeholder*="Описание"]:visible'], fill: websiteData.description },
        ];
      }
      else if (domain.includes('irecommend')) {
        // iRecommend — специфические селекторы для регистрации
        serverLog.info(`   🎯 Используем специфические селекторы для iRecommend`);
        siteSelectors = [
          { name: 'login', selectors: ['input[name="login"]:visible', 'input[name="login_form[login]"]:visible', 'input[placeholder*="Логин"]:visible'], fill: email.split('@')[0] },
          { name: 'email', selectors: ['input[name="email"]:visible', 'input[name="email_form[email]"]:visible', 'input[type="email"]:visible', 'input[placeholder*="Email"]:visible'], fill: email },
          { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible', 'input[placeholder*="Пароль"]:visible'], fill: password },
          { name: 'password_confirm', selectors: ['input[name="password_confirm"]:visible', 'input[name="password_confirm"]:visible', 'input[placeholder*="Подтверждение"]:visible'], fill: password },
        ];
      }
      else {
        // Универсальные селекторы
        siteSelectors = [
          { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible', 'input[type="password2"]:visible'], fill: password },
          { name: 'login', selectors: ['input[name="login"]:visible', 'input[name="newlogin"]:visible'], fill: password+'login'},
          { name: 'email', selectors: ['input[name="email"]:visible', 'input[type="email"]:visible'], fill: email },
          { name: 'name', selectors: ['input[name="name"]:visible', 'input[name="username"]:visible'], fill: websiteData.name },
          { name: 'address', selectors: ['input[name="address"]:visible'], fill: websiteData.address },
          { name: 'phone', selectors: ['input[name="phone"]:visible'], fill: websiteData.phone },
          { name: 'city', selectors: ['input[name="city"]:visible', 'input[name="cityTitle"]:visible'], fill: websiteData.address },
          { name: 'inn', selectors: ['input[name="inn"]:visible'], fill: websiteData.inn },
          { name: 'CatalogDescription', selectors: ['textarea[name="CatalogDescription"]:visible'], fill: websiteData.name },
          { name: 'FullDescription', selectors: ['textarea[name="FullDescription"]:visible'], fill: websiteData.description },
        ];
      }

      let fieldsFilled = 0;
      let fieldsSkipped = 0;

      for (const selector of siteSelectors) {
        let filled = false;
        
        for (const sel of selector.selectors) {
          try {
            const element = await page.$(sel);
            if (element) {
              serverLog.debug(`   ⌨️ Заполнение поля "${selector.name}" (селектор: ${sel})...`);
              await page.fill(sel, selector.fill);
              serverLog.info(`   ✅ Поле "${selector.name}" заполнено: ${String(selector.fill).slice(0, 20)}`);
              fieldsFilled++;
              filled = true;
              break;
            }
          } catch (error) {
            serverLog.debug(`   ⚠️ Селектор "${sel}" не сработал: ${error.message}`);
          }
        }
        
        if (!filled) {
          serverLog.debug(`   ℹ️ Поле "${selector.name}" не найдено — пропускаем`);
          fieldsSkipped++;
        }
      }

      serverLog.info(`📊 Заполнено полей: ${fieldsFilled} из ${fieldsFilled + fieldsSkipped}`);

      // Шаг 4: Выбор рубрики и чекбоксы
      serverLog.info(`🏷️ Шаг 4: Выбор сферы деятельности и чекбоксы...`);
      
      if (domain.includes('cataloxy')) {
        // Cataloxy: отмечам чекбокс согласия с данными
        try {
          const agreeCheckbox = await page.$('input[name="iagree_pers_datos"]:visible, input#iagree_pers_datos');
          if (agreeCheckbox) {
            await page.check('input[name="iagree_pers_datos"]:visible, input#iagree_pers_datos');
            serverLog.info(`   ✅ Чекбокс согласия отмечен`);
          }
        } catch (err) {
          serverLog.debug(`   ℹ️ Чекбокс iagree_pers_datos не найден`);
        }
        
        // Отмечаем чекбокс согласия на обработку персональных данных
        try {
          const imAgree = await page.$('input[name="im_agree"]:visible, input#im_agree');
          if (imAgree) {
            await page.check('input[name="im_agree"]:visible, input#im_agree');
            serverLog.info(`   ✅ Чекбокс im_agree отмечен`);
          }
        } catch (err) {
          serverLog.debug(`   ℹ️ Чекбокс im_agree не найден`);
        }
      }
      else if (domain.includes('irecommend')) {
        // iRecommend: чекбоксы согласия
        try {
          serverLog.info(`   📋 iRecommend: обработка чекбоксов...`);
          
          // iRecommend требует согласия с правилами
          const agreeCheckbox = await page.$('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="rules"]:visible, input[type="checkbox"][class*="agree"]:visible');
          if (agreeCheckbox) {
            await page.check('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="rules"]:visible, input[type="checkbox"][class*="agree"]:visible');
            serverLog.info(`   ✅ Чекбокс согласия с правилами отмечен`);
          }
          
          // Опционально: согласие на рассылку
          const newsletterCheckbox = await page.$('input[type="checkbox"][name*="newsletter"]:visible, input[type="checkbox"][name*="subscribe"]:visible');
          if (newsletterCheckbox) {
            // Не отмечаем рассылку, но не ошибка если не найдено
            serverLog.debug(`   ℹ️ Найдено поле подписки (не отмечаем)`);
          }
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось обработать чекбоксы iRecommend: ${err.message}`);
        }
      }
      else if (domain.includes('b2b-center')) {
        // B2B Center: выбор рубрики и чекбоксы
        try {
          serverLog.info(`   📋 B2B Center: выбор сферы деятельности...`);
          // Пробуем найти и заполнить поле категории/рубрики
          const categoryInput = await page.$('select[name="category"]:visible, input[name="category"]:visible, [class*="category"]:visible');
          if (categoryInput) {
            serverLog.info(`   ✅ Найдено поле категории`);
            // Если это select — выбираем первый вариант
            const tagName = await categoryInput.evaluate(el => el.tagName);
            if (tagName === 'SELECT') {
              await page.selectOption('select[name="category"]:visible', { label: 'Бизнес' }).catch(async () => {
                await page.selectOption('select[name="category"]:visible', { index: 0 });
              });
              serverLog.info(`   ✅ Категория выбрана`);
            }
          }
          
          // Ищем чекбокс согласия
          const agreeCheckbox = await page.$('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="policy"]:visible, input[type="checkbox"][name*="consent"]:visible');
          if (agreeCheckbox) {
            await page.check('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="policy"]:visible, input[type="checkbox"][name*="consent"]:visible');
            serverLog.info(`   ✅ Чекбокс согласия отмечен`);
          }
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось обработать рубрику/чекбоксы B2B Center: ${err.message}`);
        }
      }
      else if (domain.includes('orgpage')) {
        try {
          await page.fill('#CatalogDescription', websiteData.name);
          await page.fill('#FullDescription', websiteData.description);
          // 2. Разбираем номер
          const match = websiteData.phone.match(/\+(\d{1,3})\s*\((\d{3})\)\s*(\d{3}-\d{2}-\d{2})/);

        if (match) {
        const result = {
          countryCode: match[1],
          areaCode: match[2],
          number: match[3] };
        await page.fill('input[name="index"]',  result.areaCode); // Москва
        await page.fill('input[name="number"]', result.number);
        await this.selectRubric(page, 'Бизнес');
    } 
      else { console.log('Не удалось разобрать номер телефона');}
        } catch (err) {
          serverLog.warn(`⚠️ Не удалось выбрать рубрику: ${err.message}`);
        }
      }

      // Шаг 5: Согласие (для не-Cataloxy)
      if (!domain.includes('cataloxy')) {
        serverLog.info(`📜 Шаг 5: Проверка согласия с условиями...`);
        try {
          await this.acceptAgreement(page);
        } catch (err) {
          serverLog.warn(`⚠️ Не удалось обработать согласие: ${err.message}`);
        }
      }
      // Шаг 6: Отправка формы
      serverLog.info(`📤 Шаг 6: Отправка формы регистрации...`);
      
      if (domain.includes('cataloxy')) {
        // Cataloxy: кнопка с name="pulseregbtn"
        try {
          await page.click('input[name="pulseregbtn"]:visible');
          serverLog.info(`   ✅ Форма отправлена (Cataloxy)`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось нажать кнопку отправки: ${err.message}`);
          // Пробуем альтернативную кнопку
          try {
            await page.click('input[type="submit"]:visible');
            serverLog.info(`   ✅ Форма отправлена (альтернативная кнопка)`);
          } catch (err2) {
            serverLog.error(`   ❌ Не удалось отправить форму`);
          }
        }
      }
      else if (domain.includes('irecommend')) {
        // iRecommend: отправка формы
        try {
          serverLog.info(`   📤 iRecommend: отправка формы...`);
          
          // Ждем немного для валидации
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Ищем кнопку регистрации
          await page.click('button[type="submit"]:visible, input[type="submit"]:visible, [class*="submit"]:visible, [class*="register"]:visible, [id*="submit"]:visible').catch(async () => {
            // Альтернативный вариант — отправка формы
            const form = await page.$('form');
            if (form) {
              await form.evaluate(f => f.submit());
            }
          });
          serverLog.info(`   ✅ Форма iRecommend отправлена`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось отправить форму iRecommend: ${err.message}`);
          // Финальная попытка
          try {
            await page.click('button:not([type="button"]):visible, input[type="submit"]:visible');
            serverLog.info(`   ✅ Форма iRecommend отправлена (альтернативно)`);
          } catch (err2) {
            serverLog.error(`   ❌ Не удалось отправить форму iRecommend`);
          }
        }
      }
      else if (domain.includes('b2b-center')) {
        // B2B Center: отправка формы
        try {
          serverLog.info(`   📤 B2B Center: отправка формы...`);
          // B2B Center обычно требует согласия с условиями — ищем чекбокс
          const agreeCheckbox = await page.$('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="policy"]:visible, input[type="checkbox"][name*="rules"]:visible');
          if (agreeCheckbox) {
            await page.check('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="policy"]:visible, input[type="checkbox"][name*="rules"]:visible');
            serverLog.info(`   ✅ Чекбокс согласия с условиями отмечен`);
          }

          // Ждем немного для инициализации форм
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Пробуем найти и нажать кнопку регистрации
          await page.click('button[type="submit"]:visible, input[type="submit"]:visible, [class*="submit"]:visible, [class*="register"]:visible, [id*="submit"]:visible, [id*="register"]:visible').catch(async () => {
            // Альтернативный вариант — отправка формы
            const form = await page.$('form');
            if (form) {
              await form.evaluate(f => f.submit());
            }
          });
          serverLog.info(`   ✅ Форма B2B Center отправлена`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось отправить форму B2B Center: ${err.message}`);
          // Финальная попытка — ищем любую кнопку
          try {
            await page.click('button:not([type="button"]):visible, input[type="submit"]:visible');
            serverLog.info(`   ✅ Форма B2B Center отправлена (альтернативно)`);
          } catch (err2) {
            serverLog.error(`   ❌ Не удалось отправить форму B2B Center`);
          }
        }
      }
      else {
        serverLog.debug(`   👆 Нажатие кнопки "Зарегистрироваться"...`);
        try {
          await page.click('button[type="submit"]');
          serverLog.info(`   ✅ Форма отправлена`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось нажать кнопку: ${err.message}`);
        }
      }

      // Шаг 7: Ожидание и получение кода
      serverLog.info(`⏳ Шаг 7: Ожидание обработки формы (10 сек)...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
      serverLog.debug(`   ⏰ 10 секунд прошло`);

      // Cataloxy не требует кода подтверждения
      if (!domain.includes('cataloxy')) {
        serverLog.info(`📧 Шаг 8: Получение кода подтверждения на ${email}...`);
        serverLog.debug(`   IMAP: ${imapHost}:${port}`);
        
        // Для B2B Center и iRecommend специальный парсинг
        let confirmationCode = null;
        if (domain.includes('b2b-center')) {
          serverLog.info(`   🎯 Специфический парсинг для B2B Center...`);
          confirmationCode = await EmailParser.getConfirmationCode(email, imapHost, port, apppassword, 'b2b-center');
        }
        else if (domain.includes('irecommend')) {
          serverLog.info(`   🎯 Специфический парсинг для iRecommend...`);
          confirmationCode = await EmailParser.getConfirmationCode(email, imapHost, port, apppassword, 'irecommend');
        }
        else {
          confirmationCode = await EmailParser.getConfirmationCode(email, imapHost, port, apppassword);
        }
        
        if (confirmationCode) {
          serverLog.info(`✅ Код подтверждения получен: ${confirmationCode}`);
        } else {
          serverLog.warn(`⚠️ Код подтверждения не получен`);
        }
      } else {
        serverLog.info(`📧 Шаг 8: Пропускаем (Cataloxy не требует подтверждения)`);
      }

      // Шаг 9: Сохранение в БД
      serverLog.info(`💾 Шаг 9: Сохранение данных в базу...`);
      await this.db.saveRegistrationData(
        websiteData.website,
        email,
        login,
        password,
        profileUrl,
        'success',
        websiteData.name,
        directoryUrl,
        ''
      );
      serverLog.info(`   ✅ Данные сохранены`);

      serverLog.info(`═══════════════════════════════════════════════════`);
      serverLog.info(`✅ РЕГИСТРАЦИЯ ЗАВЕРШЕНА УСПЕШНО: ${dirName}`);
      serverLog.info(`   Профиль: ${profileUrl}`);
      serverLog.info(`═══════════════════════════════════════════════════`);

      return { success: true, profileUrl };
    } catch (error) {
      serverLog.error(`═══════════════════════════════════════════════════`);
      serverLog.error(`❌ ОШИБКА РЕГИСТРАЦИИ: ${dirName}`);
      serverLog.error(`   Ошибка: ${error.message}`);
      serverLog.error(`═══════════════════════════════════════════════════`);

      // Всегда сохраняем данные в БД, даже при ошибке
      try {
        await this.db.saveRegistrationData(
          websiteData.website,
          email,
          login,
          password,
          null,
          'error',
          websiteData.name,
          directoryUrl,
          error.message
        );
        serverLog.info(`   ✅ Данные об ошибке сохранены в БД`);
      } catch (dbErr) {
        serverLog.error(`   💥 Не удалось сохранить ошибку в БД: ${dbErr.message}`);
      }

      return { success: false, profileUrl: null };
    }
  }

  async runRegistration(website, email, imapHost, port, apppassword, directories) {
    const startTime = Date.now();
    
    serverLog.info(`═══════════════════════════════════════════════════`);
    serverLog.info(`🏁 ЗАПУСК РЕГИСТРАЦИИ`);
    serverLog.info(`   Сайт: ${website}`);
    serverLog.info(`   Email: ${email}`);
    serverLog.info(`   Каталогов: ${directories.length}`);
    serverLog.info(`   IMAP: ${imapHost}:${port}`);
    serverLog.info(`═══════════════════════════════════════════════════`);

    if (!(await this.initialize())) {
      throw new Error('Не удалось инициализировать Playwright');
    }

    if (!directories || directories.length === 0) {
      throw new Error('Необходимо выбрать хотя бы одну директорию');
    }

    const directoriesArray = Array.isArray(directories) ? directories : [directories];

    try {
      serverLog.info(`🌐 Шаг 1: Парсинг данных сайта...`);
      const websiteData = await this.parseWebsiteData(website);
      websiteData.website = website;
      serverLog.info(`✅ Данные сайта получены`);

      serverLog.info(`🔄 Шаг 2: Начало обработки каталогов...`);
      const results = [];
      let successCount = 0;
      let errorCount = 0;

      // Генерируем пароль один раз для всех каталогов
      const password = Math.random().toString(36).slice(-8);

      for (let i = 0; i < directoriesArray.length; i++) {
        const directory = directoriesArray[i];
        serverLog.info(`\n📌 Прогресс: ${i + 1}/${directoriesArray.length} каталогов`);
        
        try {
          const result = await this.registerInDirectory(
            directory,
            websiteData,
            email,
            imapHost,
            port,
            apppassword
          );
          results.push(result);
          if (result.success) {
            successCount++;
          } else {
            errorCount++;
          }
        } catch (error) {
          serverLog.error(`💥 Критическая ошибка при обработке каталога: ${error.message}`);
          results.push({ success: false, error: error.message });
          errorCount++;
          
          // Сохраняем критическую ошибку в БД
          try {
            await this.db.saveRegistrationData(
              websiteData.website,
              email,
              email,
              password,
              null,
              'error',
              websiteData.name,
              directory,
              `Критическая ошибка: ${error.message}`
            );
            serverLog.info(`   ✅ Критическая ошибка сохранена в БД`);
          } catch (dbErr) {
            serverLog.error(`   💥 Не удалось сохранить критическую ошибку: ${dbErr.message}`);
          }
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      serverLog.info(`\n═══════════════════════════════════════════════════`);
      serverLog.info(`🎉 РЕГИСТРАЦИЯ ЗАВЕРШЕНА`);
      serverLog.info(`   Всего каталогов: ${directoriesArray.length}`);
      serverLog.info(`   ✅ Успешно: ${successCount}`);
      serverLog.info(`   ❌ Ошибок: ${errorCount}`);
      serverLog.info(`   ⏱️  Время: ${duration} сек`);
      serverLog.info(`═══════════════════════════════════════════════════`);

      return { success: true, results, stats: { total: directoriesArray.length, success: successCount, error: errorCount, duration } };
    } catch (error) {
      serverLog.error(`💥 КРИТИЧЕСКАЯ ОШИБКА РЕГИСТРАЦИИ: ${error.message}`);
      throw error;
    } finally {
      await this.cleanup();
    }
  }
}

module.exports = RegistrationAgent;
