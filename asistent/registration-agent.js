const BrowserInitializer = require('./browser-initializer');
const EmailParser = require('./email-parser');
const RegistrationDB = require('./registration-db');
const { serverLog } = require('./logger');
const Tesseract = require('tesseract.js');

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
    
    // Для Flado ждём полной загрузки (включая favicon и картинки)
    if (websiteUrl.includes('flado')) {
      serverLog.debug(`   ⏳ Для Flado ждём полную загрузку страницы...`);
      await page.goto(websiteUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(3000); // Дополнительно ждём рендеринг
    } else {
      await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);
    }
    serverLog.debug(`   ✅ Страница загружена`);

    serverLog.debug(`   🔍 Извлечение данных компании...`);
    const data = await page.evaluate(() => {
      // Функция исправления падежей городов
      const fixCityCase = (city) => {
        if (!city) return city;
        const cases = {
          'Самаре': 'Самара', 'Москве': 'Москва', 'Петербурге': 'Петербург',
          'Казани': 'Казань', 'Екатеринбурге': 'Екатеринбург', 'Новосибирске': 'Новосибирск',
          'Саратове': 'Саратов', 'Тольятти': 'Тольятти', 'Ижевске': 'Ижевск',
          'Уфе': 'Уфа', 'Челябинске': 'Челябинск', 'Омске': 'Омск',
          'Ростове': 'Ростов', 'Ульяновске': 'Ульяновск', 'Воронеже': 'Воронеж',
          'Перми': 'Пермь', 'Волгограде': 'Волгоград', 'Красноярске': 'Красноярск',
          'Сочи': 'Сочи', 'Краснодаре': 'Краснодар', 'Туле': 'Тула',
          'Калуге': 'Калуга', 'Ярославле': 'Ярославль', 'Владимире': 'Владимир',
          'Твери': 'Тверь', 'Орле': 'Орёл', 'Белгороде': 'Белгород',
          'Махачкале': 'Махачкала', 'Владикавказе': 'Владикавказ',
          'Пензе': 'Пенза', 'Липецке': 'Липецк', 'Кирове': 'Киров',
          'Чебоксарах': 'Чебоксары', 'Тюмени': 'Тюмень', 'Севастополе': 'Севастополь',
        };
        if (cases[city]) return cases[city];
        if (city.endsWith('е') && city.length > 3) return city.slice(0, -1);
        if (city.endsWith('и') && city.length > 3) return city.slice(0, -1) + 'ь';
        return city;
      };

      // 1. JSON-LD структурированные данные (самый надёжный источник)
      let found = {};
      try {
        const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
        jsonLdScripts.forEach(s => {
          try {
            const data = JSON.parse(s.textContent);
            const processJsonLd = (obj) => {
              if (!obj) return;
              if (Array.isArray(obj)) { obj.forEach(processJsonLd); return; }
              if (typeof obj !== 'object') return;
              
              const type = (obj['@type'] || obj.type || '').toLowerCase();
              if (!type.includes('organization') && !type.includes('localbusiness') && !type.includes('corporation')) return;

              // Название
              if (!found.name) {
                if (obj.name && typeof obj.name === 'string') found.name = obj.name.trim();
                else if (obj.alternateName && typeof obj.alternateName === 'string') found.name = obj.alternateName.trim();
              }

              // Телефон
              if (!found.phone) {
                if (obj.telephone && typeof obj.telephone === 'string') found.phone = obj.telephone.replace(/[\s()-]/g, '');
                else if (obj.phone && typeof obj.phone === 'string') found.phone = obj.phone.replace(/[\s()-]/g, '');
              }

              // Адрес
              if (!found.address) {
                if (obj.address && typeof obj.address === 'object') {
                  const parts = [];
                  if (obj.address.streetAddress) parts.push(obj.address.streetAddress);
                  if (obj.address.addressLocality) parts.push(obj.address.addressLocality);
                  if (obj.address.addressRegion) parts.push(obj.address.addressRegion);
                  if (obj.address.postalCode) parts.push(obj.address.postalCode);
                  if (parts.length) found.address = parts.join(', ');
                } else if (obj.address && typeof obj.address === 'string') {
                  found.address = obj.address.trim();
                }
              }

              // Город
              if (!found.city) {
                if (obj.address && typeof obj.address === 'object') {
                  found.city = obj.address.addressLocality || obj.address.addressRegion || null;
                }
              }

              // Глобальный поиск addressLocality в JSON-LD
              if (!found.city) {
                const jsonLdCity = JSON.stringify(obj).match(/"addressLocality"\s*:\s*"([^"]+)"/);
                if (jsonLdCity) found.city = jsonLdCity[1];
              }

              // ИНН из TaxIdentification (отдельный блок)
              if (!found.inn) {
                const type = (obj['@type'] || obj.type || '').toLowerCase();
                if (type.includes('taxidentification')) {
                  if (obj.taxID && /^\d{10,12}$/.test(obj.taxID)) found.inn = obj.taxID;
                  else if (obj.identifier && typeof obj.identifier === 'string' && /^\d{10,12}$/.test(obj.identifier)) found.inn = obj.identifier;
                  else if (obj.value && /^\d{10,12}$/.test(obj.value)) found.inn = obj.value;
                }
              }
              
              // ИНН из identifier.name === "ИНН"
              if (!found.inn && obj.identifier) {
                const ids = Array.isArray(obj.identifier) ? obj.identifier : [obj.identifier];
                for (const id of ids) {
                  if (id.name && id.name.toLowerCase().includes('inn') && id.value && /^\d{10,12}$/.test(id.value)) {
                    found.inn = id.value;
                    break;
                  }
                  if (id.taxID && /^\d{10,12}$/.test(id.taxID)) {
                    found.inn = id.taxID;
                    break;
                  }
                }
              }

              // ИНН
              if (!found.inn) {
                if (obj.identifier) {
                  const ids = Array.isArray(obj.identifier) ? obj.identifier : [obj.identifier];
                  for (const id of ids) {
                    if (id.value && /^\d{10,12}$/.test(id.value)) { found.inn = id.value; break; }
                    if (id.taxID && /^\d{10,12}$/.test(id.taxID)) { found.inn = id.taxID; break; }
                  }
                }
              }

              // Рекурсия
              for (const key of Object.keys(obj)) {
                if (typeof obj[key] === 'object' && obj[key] !== null) processJsonLd(obj[key]);
              }
            };
            processJsonLd(data);
          } catch (e) {}
        });
      } catch (e) {}

      // JSON-LD: глобальный поиск ИНН (fallback)
      if (!found.inn) {
        try {
          const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
          jsonLdScripts.forEach(s => {
            if (found.inn) return;
            const text = s.textContent;
            // Ищем "taxID": "1234567890" или "value": "1234567890" рядом с "ИНН" или "identifier"
            const innPattern = /"taxID"\s*:\s*"(\d{10,12})"/;
            const m = innPattern.exec(text);
            if (m) { found.inn = m[1]; return; }
            
            // Ищем "identifier" с "name": "ИНН" и "value"
            const idPattern = /"name"\s*:\s*"([^"]*ИНН[^"]*)"[^}]*"value"\s*:\s*"(\d{10,12})"/;
            const m2 = idPattern.exec(text);
            if (m2) { found.inn = m2[2]; return; }
          });
        } catch (e) {}
      }

      // 2. Open Graph теги
      document.querySelectorAll('meta[property], meta[name]').forEach(meta => {
        const prop = meta.getAttribute('property') || meta.getAttribute('name');
        const content = meta.getAttribute('content');
        if (!prop || !content) return;
        if (prop === 'og:site_name' && !found.name) found.name = content.trim();
        if (prop === 'og:description' && !found.description) found.description = content.trim();
      });

      // 3. Обычные мета-теги
      document.querySelectorAll('meta[name]').forEach(meta => {
        const name = meta.getAttribute('name');
        const content = meta.getAttribute('content');
        if (!name || !content) return;
        if (name === 'address' && !found.address) found.address = content.trim();
        if (name === 'phone' && !found.phone) found.phone = content.trim();
        if (name === 'inn' && !found.inn) found.inn = content.trim();
        if (name === 'email' && !found.email) found.email = content.trim();
      });

      // 3.1. Извлекаем email из ссылок mailto:
      if (!found.email) {
        document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
          const val = a.getAttribute('href').replace('mailto:', '').trim();
          if (val && !found.email) found.email = val;
        });
      }

      // 3.2. Извлекаем email из текста страницы (fallback)
      if (!found.email) {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const allText = document.body ? document.body.textContent : '';
        const matches = allText.match(emailRegex);
        if (matches && matches.length > 0) {
          // Берём первый валидный email, исключая служебные
          for (const m of matches) {
            const cleanEmail = m.toLowerCase();
            if (!cleanEmail.includes('noreply') && !cleanEmail.includes('no-reply') && 
                !cleanEmail.includes('admin') && !cleanEmail.includes('postmaster')) {
              found.email = m;
              break;
            }
          }
          // Если все фильтры сработали, берём первый
          if (!found.email && matches.length > 0) {
            found.email = matches[0];
          }
        }
      }
        
      // 4. Парсинг текста страницы
      const bodyText = document.body ? document.body.textContent : '';
      
      // Телефоны
      if (!found.phone) {
        const telLinks = document.querySelectorAll('a[href^="tel:"]');
        telLinks.forEach(a => {
          const val = a.getAttribute('href').replace('tel:', '').trim();
          if (val) { found.phone = val.replace(/[\s()-]/g, ''); }
        });
      }
      if (!found.phone) {
        const phoneRegex = /(\+7|8)\s*[\(]?\d{3}[\)]?\s*[-]?\d{3}[-]?\d{2}[-]?\d{2}/g;
        const matches = bodyText.match(phoneRegex);
        if (matches) {
          const normalized = matches[0].replace(/^8\s*/, '+7').replace(/\s/g, '');
          found.phone = normalized;
        }
      }

      // Город
      if (!found.city) {
        const commonWords = ['ремонт', 'строительство', 'квартир', 'домов', 'услуг', 'работ', 'услуги', 'удобное', 'удобный', 'выбор', 'выбрать', 'заказ', 'заказать', 'проект', 'цена', 'стоимость', 'расчет', 'получите', 'получить', 'интернет', 'магазин', 'товары', 'продаж', 'сервис', 'сервиса', 'корпорат', 'компани', 'бизнес', 'центр', 'офис', 'продаж', 'предложен', 'каталог', 'регистрац', 'регистрации', 'регистрац', 'регистрац', 'информаци', 'информация', 'доставк', 'услуги', 'сервис', 'онлайн', 'онлайн', 'сервис', 'сервиса', 'сервиса', 'сервис', 'сервис', 'сервис'];
        
        // Паттерн 1: "в г. Казань", "город Казань", "г. Казань"
        const cityWithPrefix = bodyText.match(/(?:в\s+)?(?:г\.?|город)\s+([А-ЯЁ][А-ЯЁа-яё]{2,40})/gi);
        if (cityWithPrefix) {
          for (const match of cityWithPrefix) {
            const cityMatch = match.match(/(?:г\.?|город)\s+([А-ЯЁ][А-ЯЁа-яё]{2,40})/);
            if (cityMatch) {
              const city = cityMatch[1];
              if (city.length > 2 && !commonWords.includes(city.toLowerCase())) {
                found.city = city;
                break;
              }
            }
          }
        }
        
        // Паттерн 2: "в Казани", "из Казани" — предложный падеж
        if (!found.city) {
          const cityInCase = bodyText.match(/(?:в|из|по)\s+([А-ЯЁ][А-ЯЁа-яё]{3,40})/gi);
          if (cityInCase) {
            for (const match of cityInCase) {
              const cityMatch = match.match(/(?:в|из|по)\s+([А-ЯЁ][А-ЯЁа-яё]{3,40})/);
              if (cityMatch) {
                const city = cityMatch[1];
                if (city.length > 2 && !commonWords.includes(city.toLowerCase())) {
                  found.city = fixCityCase(city);
                  break;
                }
              }
            }
          }
        }
        
        // Паттерн 3: JSON-LD (если не нашли из структурированных данных выше)
        if (!found.city) {
          const jsonLdCity = bodyText.match(/"addressLocality"\s*:\s*"([^"]+)"/);
          if (jsonLdCity) {
            found.city = jsonLdCity[1];
          }
        }
      }

      // Адрес (если не найден из JSON-LD)
      if (!found.address) {
        // Сначала ищем полные адреса с почтовым индексом (самый надёжный паттерн)
        const fullAddressPattern = /(\d{6},\s*[^\n]{10,300})/g;
        const fullMatches = bodyText.match(fullAddressPattern);
        if (fullMatches) {
          for (const m of fullMatches) {
            // Берём первый подходящий адрес с индексом
            found.address = m.trim();
            break;
          }
        }

        // Fallback: ищем адрес по паттернам улицы/проспекта
        if (!found.address) {
          const addressPatterns = [
            /г\.?\s*[А-ЯЁа-яё\s\-]{2,50}\s*(ул\.|улица|пр\.|проспект|пр-т|площад\.|пл\.|пер\.|переулок|д\.|дом|стр\.|корп\.|букв\.)[\s,.\n\d\-]+/gi,
            /ул\.\s*[А-ЯЁа-яё\s\-]{2,50}(?:\s*(?:д\.|дом|стр\.|корп\.|букв\.)\s*[\d\-]+)?/gi,
            /проспект\s+[А-ЯЁа-яё\s\-]{2,50}(?:\s*(?:д\.|дом|стр\.|корп\.|букв\.)\s*[\d\-]+)?/gi,
            /пр(?:-т)?\.?\s+[А-ЯЁа-яё\s\-]{2,50}(?:\s*(?:д\.|дом|стр\.|корп\.|букв\.)\s*[\d\-]+)?/gi,
            /улица\s+[А-ЯЁа-яё\s\-]{2,50}(?:\s*(?:д\.|дом|стр\.|корп\.|букв\.)\s*[\d\-]+)?/gi,
          ];
          for (const pattern of addressPatterns) {
            const matches = bodyText.match(pattern);
            if (matches && matches.length > 0) {
              // Берём самый длинный (полный) адрес
              found.address = matches.reduce((a, b) => a.length > b.length ? a : b).trim();
              break;
            }
          }
        }
      }
        
      // ИНН из текста (улучшенный поиск)
      if (!found.inn) {
        // Паттерн 1: "ИНН 1234567890" или "ИНН: 1234567890" или "ИНН-КПП 1234567890/1234567890"
        const innDirect = bodyText.match(/ИНН\s*[:\-\/\s]?\s*(\d{10,12})/i);
        if (innDirect) found.inn = innDirect[1];
        
        // Паттерн 2: JSON-LD identifier.value
        if (!found.inn) {
          const innJsonLd = bodyText.match(/"value"\s*:\s*"(\d{10,12})"/);
          if (innJsonLd) {
            // Проверяем, что это рядом с "ИНН" или "taxID" или "identifier"
            const context = bodyText.substring(
              Math.max(0, innJsonLd.index - 300),
              Math.min(bodyText.length, innJsonLd.index + 300)
            );
            if (context.toLowerCase().includes('inn') || context.toLowerCase().includes('taxid') || context.includes('identifier')) {
              found.inn = innJsonLd[1];
            }
          }
        }
        
        // Паттерн 3: taxID в JSON-LD
        if (!found.inn) {
          const innFromLd = bodyText.match(/"taxID"\s*:\s*"(\d{10,12})"/);
          if (innFromLd) found.inn = innFromLd[1];
        }
        
        // Паттерн 4: КПП рядом (проверяем пару ИНН-КПП)
        if (!found.inn) {
          const innKpp = bodyText.match(/ИНН\s+(\d{10,12})[^,\d]{0,20}КПП\s+(\d{9})/i);
          if (innKpp) found.inn = innKpp[1];
        }
        
        // Паттерн 5: 10-12 цифр подряд в контактах (fallback)
        if (!found.inn) {
          // Ищем в секциях "Контакты", "О компании", "Реквизиты"
          const contactSection = bodyText.match(/[Рк]онтакт[ыая]?[\s\S]{0,500}(\d{10,12})/i);
          if (contactSection) {
            const num = contactSection[1];
            if (num.length >= 10 && num.length <= 12) found.inn = num;
          }
        }
      }

      // 5. Заголовок как fallback для названия
      if (!found.name) {
        let title = document.title || '';
        title = title.replace(/\s*[|—–\-]\s*.*/g, '').replace(/\s*\d{2}\s*/g, '').trim();
        found.name = title || 'Неизвестно';
      }

      // Описание
      if (!found.description) {
        const descMeta = document.querySelector('meta[name="description"]');
        found.description = descMeta ? descMeta.getAttribute('content') : 'Неизвестно';
      }

      // Логотип и favicon
      let logoUrl = null;
      const logoSelectors = [
        'link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]',
        '[href*="favicon"]',
        'img[alt*="logo"]', '.logo img', '#logo', 'header img', '[class*="logo"] img',
      ];
      for (const selector of logoSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          // Для <link> используем href, для <img> — src
          logoUrl = element.href || element.src || element.getAttribute('href');
          if (logoUrl) {
            // Если это относительный URL, делаем абсолютным
            if (logoUrl.startsWith('/')) {
              logoUrl = new URL(logoUrl, document.baseURI).href;
            } else if (logoUrl.startsWith('./')) {
              logoUrl = new URL(logoUrl, document.baseURI).href;
            }
            break;
          }
        }
      }

      // Fallback 1: пробуем все link теги с href, содержащим icon/favicon
      if (!logoUrl) {
        const allLinks = document.querySelectorAll('link[href]');
        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          const rel = (link.getAttribute('rel') || '').toLowerCase();
          if (rel.includes('icon') || href.includes('favicon') || href.includes('logo')) {
            try {
              logoUrl = new URL(href, document.baseURI).href;
              break;
            } catch (e) {}
          }
        }
      }
        
      // Fallback 2: пробуем стандартные пути favicon
      if (!logoUrl) {
        const standardPaths = ['/favicon.ico', '/favicon.png', '/favicon.svg', '/images/favicon.ico', '/assets/favicon.ico'];
        for (const path of standardPaths) {
          try {
            logoUrl = new URL(path, document.baseURI).href;
            break;
          } catch (e) {}
        }
      }
      
      // Fallback 3: Google Favicon API как последний вариант
      if (!logoUrl) {
        try {
          const domain = new URL(document.baseURI).hostname;
          logoUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
        } catch (e) {}
      }

      // Сфера деятельности
      let industry = 'Не определено';
      const textLower = bodyText.toLowerCase();
      const industryKeywords = {
        '🏗 Строительство и ремонт': ['ремонт квартир', 'строительство', 'строительн', 'отделк', 'дизайн интерьер', 'ремонт под ключ', 'монтаж', 'бетон', 'крыш', 'фасад'],
        '🚗 Автомобильные услуги': ['автосервис', 'автомойк', 'детейлинг', 'ремонт авто', 'шиномонтаж', 'запчаст', 'эвакуатор'],
        '💻 IT и разработка': ['разработка', 'программир', 'it-услуги', 'веб-сайт', 'сайт', 'интернет', 'digital', 'технологии', 'frontend', 'backend'],
        '🎓 Образование': ['обучение', 'курсы', 'университет', 'школ', 'образован', 'репетитор', 'тренинг'],
        '🏥 Здоровье и медицина': ['медицинск', 'клиник', 'больниц', 'врач', 'здоровье', 'стоматолог', 'диагностик', 'лечени'],
        '🍽 Ресторанный бизнес': ['ресторан', 'кафе', 'бар', 'доставка еды', 'кухня', 'пицц', 'кофейн', 'суши'],
        '🛒 Торговля и ритейл': ['магазин', 'торговл', 'интернет-магазин', 'маркетплейс', 'продукты', 'одежд', 'мебель', 'товары'],
        '💅 Красота и здоровье': ['салон красоты', 'парикмахерск', 'маникюр', 'брови', 'косметолог', 'спа', 'массаж'],
        '🧹 Услуги и сервис': ['клининг', 'уборк', 'переезд', 'курьер', 'такси', 'аренд', 'прокат', 'юридическ', 'бухгалтерск'],
        '🏠 Недвижимость': ['недвижимост', 'квартир', 'домов', 'застройщик', 'ипотека', 'риелтор'],
        '📸 Фото и видео': ['фотограф', 'видеосъёмк', 'фотостудия', 'фотосессия', 'монтаж', 'анимаци'],
        '🎨 Дизайн и творчество': ['дизайн', 'логотип', 'брендинг', 'полиграфия', 'иллюстраци', 'арт'],
        '🚚 Логистика и транспорт': ['логистик', 'грузоперевозк', 'транспорт', 'доставк', 'экспресс', 'почт'],
        '💰 Финансы и банки': ['банк', 'кредит', 'ипотека', 'инвестици', 'страховани', 'финансов', 'налог'],
        '🌾 Сельское хозяйство': ['фермер', 'сельскохозяйственн', 'урожай', 'животновод', 'растениевод', 'зерно', 'молоко'],
        '🎮 Развлечения и досуг': ['развлечени', 'досуг', 'аниматор', 'праздник', 'квест', 'парк', 'кино', 'театр'],
      };
      let maxScore = 0;
      for (const [ind, keywords] of Object.entries(industryKeywords)) {
        let score = 0;
        for (const kw of keywords) {
          if (textLower.includes(kw)) score++;
        }
        if (score > maxScore) {
          maxScore = score;
          industry = ind;
        }
      }

      return {
        name: found.name || 'Неизвестно',
        description: found.description || 'Неизвестно',
        address: found.address || null,
        phone: found.phone || null,
        email: found.email || null,
        inn: found.inn || null,
        city: fixCityCase(found.city) || null,
        industry: industry,
        logoUrl: logoUrl || null,
      };
    });

    serverLog.info(`📋 Данные компании получены:`, {
      name: data.name,
      description: data.description,
      address: data.address,
      phone: data.phone,
      email: data.email,
      inn: data.inn,
      city: data.city,
      industry: data.industry,
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

      // Определяем домен (СРАЗУ после загрузки)
      const domain = page.url().replace(/^https?:\/\//, '').split('/')[0];
      
      // Для Flado ждём полной загрузки (включая favicon и картинки)
      if (domain.includes('flado')) {
        serverLog.debug(`   ⏳ Для Flado ждём полную загрузку (favicon, картинки)...`);
        await page.reload({ waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(2000);
        serverLog.debug(`   ✅ Полная загрузка завершена`);
      }
      
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
        'https://my.flado.ru/registration'      : 'https://my.flado.ru/',
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
      else if (domain.includes('orgpage')) {
        // Orgpage.ru — медленная загрузка, увеличенные таймауты
        serverLog.info(`   🎯 Используем специфические селекторы для Orgpage.ru`);
        
        // Orgpage загружается медленно — ждём до 60 секунд
        serverLog.info(`   ⏳ Orgpage: ожидание загрузки формы (до 60 секунд)...`);
        
        try {
          // Ждём появления основных полей формы
          await page.waitForSelector('input[name="Company"]:visible, input[name="Email"]:visible', { timeout: 60000 });
          serverLog.info(`   ✅ Форма Orgpage загружена`);
        } catch (e) {
          serverLog.warn(`   ⚠️ Форма не появилась за 60 секунд, пробуем продолжить...`);
          await page.waitForTimeout(5000);
        }
        
        // Дополнительная задержка для полной загрузки всех элементов
        await page.waitForTimeout(2000);
        
        // Orgpage использует специфичные name атрибутов (с большой буквы):
        // - Company, Email, Password, Password2, Phone, Site
        siteSelectors = [
          { name: 'company', selectors: ['input[name="Company"]:visible', 'input[placeholder*="Компания"]:visible'], fill: websiteData.name },
          { name: 'email', selectors: ['input[name="Email"]:visible', 'input[type="email"]:visible'], fill: email },
          { name: 'password', selectors: ['input[name="Password"]:visible', 'input[type="password"]:visible'], fill: password },
          { name: 'password2', selectors: ['input[name="Password2"]:visible', 'input[name="password2"]:visible'], fill: password },
          { name: 'phone', selectors: ['input[name="Phone"]:visible', 'input[type="tel"]:visible'], fill: websiteData.phone },
          { name: 'site', selectors: ['input[name="Site"]:visible', 'input[name="site"]:visible'], fill: websiteData.website },
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
        
        // Ждём появления формы регистрации (до 15 секунд)
        try {
          await page.waitForSelector('form', { timeout: 15000 });
          serverLog.info(`   ✅ Форма найдена`);
        } catch (e) {
          serverLog.warn(`   ⚠️ Форма не появилась за 15 секунд, пробуем продолжить...`);
          await page.waitForTimeout(3000);
        }
        
        // Дополнительная задержка для загрузки всех элементов формы
        await page.waitForTimeout(1000);
        
        // iRecommend использует специфичные name атрибутов:
        // - login → name="name" (type="text")
        // - email → name="mail" (type="text", НЕ "email"!)
        // - password → name="pass[pass1]" (type="password")
        // - password_confirm → name="pass[pass2]" (type="password")
        
        siteSelectors = [
          { name: 'login', selectors: ['input[name="name"]:visible', '#edit-name:visible', 'input[type="text"][id="edit-name"]:visible'], fill: email.split('@')[0] },
          { name: 'email', selectors: ['input[name="mail"]:visible', '#edit-mail:visible', 'input[type="text"][id="edit-mail"]:visible'], fill: email },
          { name: 'password', selectors: ['input[name="pass[pass1]"]:visible', '#edit-pass-pass1:visible', 'input[type="password"][id="edit-pass-pass1"]:visible'], fill: password },
          { name: 'password_confirm', selectors: ['input[name="pass[pass2]"]:visible', '#edit-pass-pass2:visible', 'input[type="password"][id="edit-pass-pass2"]:visible'], fill: password },
        ];
      }
      else if (domain.includes('flado')) {
        // Flado — специфические селекторы для регистрации
        serverLog.info(`   🎯 Используем специфические селекторы для Flado`);
        // Извлекаем имя из email (часть до @)
        const emailName = email.split('@')[0];
        siteSelectors = [
          { name: 'email', selectors: ['input[name="email"]:visible', 'input[type="email"]:visible', 'input[placeholder*="Email"]:visible', '#email', '.email-input'], fill: email },
          { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible', 'input[placeholder*="Пароль"]:visible', '#password', '.password-input'], fill: password },
          // Подтверждение пароля — ищем по label "Подтверждение пароля"
          { name: 'password_confirm', selectors: [], fill: password, customFind: true },
          // Имя — извлекаем из email, ищем по множеству селекторов
          { name: 'name', selectors: ['input[name="name"]:visible', 'input[name="username"]:visible', 'input[placeholder*="Имя"]:visible', 'input[placeholder*="Name"]:visible', 'input[placeholder*="Ваше имя"]:visible', '#name', '.name-input', 'input[type="text"][aria-label*="Имя"]', 'input[type="text"][aria-label*="Name"]'], fill: emailName },
          { name: 'phone', selectors: ['input[name="phone"]:visible', 'input[type="tel"]:visible', 'input[placeholder*="Телефон"]:visible', '#phone', '.phone-input'], fill: websiteData.phone },
          { name: 'company_name', selectors: ['input[name="company_name"]:visible', 'input[name="org_name"]:visible', 'input[placeholder*="Организация"]:visible', 'input[placeholder*="Компания"]:visible', '#company_name', '.company-name'], fill: websiteData.name },
          { name: 'description', selectors: ['textarea[name="description"]:visible', 'textarea[placeholder*="Описание"]:visible', '#description', '.description-input'], fill: websiteData.description },
          { name: 'category', selectors: ['select[name="category"]:visible', 'input[name="category"]:visible', '[class*="category-select"]:visible'], fill: null },
          { name: 'confirmation_code', selectors: ['input[name="code"]:visible', 'input[name="confirmation_code"]:visible', 'input[placeholder*="Код"]:visible', 'input[name="confirm_code"]:visible', '.code-input', '#code', '#confirmation_code', 'input[type="text"][maxlength="4"]', 'input[type="text"][maxlength="6"]'], fill: null },
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

      // Для iRecommend и Orgpage используем замедленное заполнение
      const isIRecommend = domain.includes('irecommend');
      const isOrgpage = domain.includes('orgpage');
      const isSlowSite = isIRecommend || isOrgpage;
      const fillDelay = isIRecommend ? 0 : (isOrgpage ? 0 : 0);

      for (const selector of siteSelectors) {
        let filled = false;
        
        // Обработка customFind (например, поиск через label)
        if (selector.customFind) {
          let customFilled = false;
          try {
            serverLog.debug(`   🔍 Поиск поля "${selector.name}" через label...`);
            
            // Для password_confirm ищем label с текстом "Подтверждение пароля" или "Повторите пароль"
            if (selector.name === 'password_confirm') {
              // Способ 1: Ищем label с текстом "Подтверждение пароля", "Повторите пароль", "Confirm password"
              const confirmLabels = [
                'Подтверждение пароля',
                'Повторите пароль', 
                'Confirm password',
                'Подтвердите пароль',
                'Пароль еще раз',
                'confirm',
                'confirmation'
              ];
              
              for (const labelText of confirmLabels) {
                const confirmLabel = await page.$(`label:has-text("${labelText}")`);
                if (confirmLabel) {
                  const input = await confirmLabel.$('input[type="password"]');
                  if (input) {
                    await input.click();
                    await page.waitForTimeout(fillDelay);
                    await input.fill('');
                    await page.waitForTimeout(fillDelay);
                    await input.fill(selector.fill);
                    serverLog.info(`   ✅ Поле "${selector.name}" заполнено через label "${labelText}": ${String(selector.fill).slice(0, 20)}`);
                    fieldsFilled++;
                    customFilled = true;
                    break;
                  }
                }
              }
              
              // Способ 2: Если не нашли через label, ищем второй password input на странице
              if (!customFilled) {
                serverLog.debug(`   🔍 Поиск второго поля password...`);
                const passwordInputs = await page.$$('input[type="password"]:visible');
                if (passwordInputs && passwordInputs.length >= 2) {
                  // Берём второй input (первый - пароль, второй - подтверждение)
                  const confirmInput = passwordInputs[1];
                  await confirmInput.click();
                  await page.waitForTimeout(fillDelay);
                  await confirmInput.fill('');
                  await page.waitForTimeout(fillDelay);
                  await confirmInput.fill(selector.fill);
                  serverLog.info(`   ✅ Поле "${selector.name}" заполнено (второй password input): ${String(selector.fill).slice(0, 20)}`);
                  fieldsFilled++;
                  customFilled = true;
                }
              }
              
              // Способ 3: Ищем по name/autocomplete атрибутам
              if (!customFilled) {
                const confirmInput = await page.$('input[name="password_confirm"]:visible, input[name="confirm_password"]:visible, input[name="password_confirmation"]:visible, input[name="password2"]:visible, input[autocomplete="new-password"]:visible');
                if (confirmInput) {
                  await confirmInput.click();
                  await page.waitForTimeout(fillDelay);
                  await confirmInput.fill('');
                  await page.waitForTimeout(fillDelay);
                  await confirmInput.fill(selector.fill);
                  serverLog.info(`   ✅ Поле "${selector.name}" заполнено через name/autocomplete: ${String(selector.fill).slice(0, 20)}`);
                  fieldsFilled++;
                  customFilled = true;
                }
              }
              
              if (!customFilled) {
                serverLog.warn(`   ⚠️ Поле "${selector.name}" не найдено`);
                fieldsSkipped++;
              }
            }
            // Для name (Flado) ищем label с текстом "Имя"
            else if (selector.name === 'name') {
              // Способ 1: Ищем label с текстом "Имя", "Ваше имя", "Name"
              const nameLabels = [
                'Имя *',
                'Имя',
                'Ваше имя',
                'Name',
                'Your name',
                'First name',
                'Имя пользователя'
              ];
              
              for (const labelText of nameLabels) {
                const nameLabel = await page.$(`label:has-text("${labelText}")`);
                if (nameLabel) {
                  const input = await nameLabel.$('input[type="text"], input[type="name"], input[name="name"], input[name="username"]');
                  if (input) {
                    await input.click();
                    await page.waitForTimeout(fillDelay);
                    await input.fill('');
                    await page.waitForTimeout(fillDelay);
                    await input.fill(selector.fill);
                    serverLog.info(`   ✅ Поле "${selector.name}" заполнено через label "${labelText}": ${String(selector.fill).slice(0, 20)}`);
                    fieldsFilled++;
                    customFilled = true;
                    break;
                  }
                }
              }
              
              // Способ 2: Если не нашли через label, ищем по стандартным селекторам
              if (!customFilled) {
                for (const sel of selector.selectors) {
                  try {
                    const element = await page.$(sel);
                    if (element) {
                      await page.fill(sel, selector.fill);
                      serverLog.info(`   ✅ Поле "${selector.name}" заполнено (селектор): ${String(selector.fill).slice(0, 20)}`);
                      fieldsFilled++;
                      customFilled = true;
                      break;
                    }
                  } catch (error) {
                    serverLog.debug(`   ⚠️ Селектор "${sel}" не сработал: ${error.message}`);
                  }
                }
              }
              
              if (!customFilled) {
                serverLog.warn(`   ⚠️ Поле "${selector.name}" не найдено`);
                fieldsSkipped++;
              }
            }
          } catch (error) {
            serverLog.debug(`   ⚠️ Ошибка customFind для "${selector.name}": ${error.message}`);
            fieldsSkipped++;
          }
          continue;
        }
        
        for (const sel of selector.selectors) {
          try {
            const element = await page.$(sel);
            if (element) {
              serverLog.debug(`   ⌨️ Заполнение поля "${selector.name}" (селектор: ${sel})...`);
              
              // Для iRecommend и Orgpage используем пошаговое заполнение с кликом
              if (isIRecommend) {
                await element.click();
                await page.waitForTimeout(300);
                await element.fill('');
                await page.waitForTimeout(200);
              } else if (isOrgpage) {
                // Orgpage требует медленного заполнения
                await element.click();
                await page.waitForTimeout(400);
                await element.fill('');
                await page.waitForTimeout(300);
              }
              
              await page.fill(sel, selector.fill);
              serverLog.info(`   ✅ Поле "${selector.name}" заполнено: ${String(selector.fill).slice(0, 20)}`);
              fieldsFilled++;
              filled = true;
              
              // Dispatch input/change events для активации валидации
              if (isIRecommend) {
                await element.dispatchEvent('input');
                await element.dispatchEvent('change');
                await element.dispatchEvent('blur');
                await page.waitForTimeout(fillDelay);
              } else if (isOrgpage) {
                await element.dispatchEvent('input');
                await element.dispatchEvent('change');
                await page.waitForTimeout(fillDelay);
              }
              
              break;
            }
          } catch (error) {
            serverLog.debug(`   ⚠️ Селектор "${sel}" не сработал: ${error.message}`);
          }
        }
        
        // Для iRecommend: если не нашли по селектору, пробуем найти через label
        if (!filled && isIRecommend) {
          try {
            // iRecommend использует специфичные name атрибутов:
            // - login → name="name" (label: "Имя пользователя: *")
            // - email → name="mail" (label: "E-mail адрес: *")
            // - password → name="pass[pass1]" (label: "Пароль: *")
            // - password_confirm → name="pass[pass2]" (label: "Повторите пароль: *")
            
            const labelPatterns = {
              'login': ['Имя пользователя', 'Имя', 'Username', 'Login'],
              'email': ['E-mail адрес', 'E-mail', 'Email', 'Электронная почта', 'Почта'],
              'password': ['Пароль', 'Password'],
              'password_confirm': ['Повторите пароль', 'Подтверждение', 'Confirm', 'Password confirm']
            };
            
            const patterns = labelPatterns[selector.name];
            if (patterns) {
              for (const pattern of patterns) {
                const label = await page.$(`label:has-text("${pattern}")`);
                if (label) {
                  const input = await label.$('input[type="text"], input[type="email"], input[type="password"]');
                  if (input) {
                    await input.click();
                    await page.waitForTimeout(300);
                    await input.fill('');
                    await page.waitForTimeout(200);
                    await input.fill(selector.fill);
                    await input.dispatchEvent('input');
                    await input.dispatchEvent('change');
                    await input.dispatchEvent('blur');
                    serverLog.info(`   ✅ Поле "${selector.name}" заполнено через label "${pattern}": ${String(selector.fill).slice(0, 20)}`);
                    fieldsFilled++;
                    filled = true;
                    break;
                  }
                }
              }
            }
            
            // Fallback: пробуем заполнить по ID для iRecommend
            if (!filled) {
              const idMap = {
                'login': '#edit-name',
                'email': '#edit-mail',
                'password': '#edit-pass-pass1',
                'password_confirm': '#edit-pass-pass2'
              };
              
              const id = idMap[selector.name];
              if (id) {
                const input = await page.$(id);
                if (input) {
                  await input.click();
                  await page.waitForTimeout(300);
                  await input.fill('');
                  await page.waitForTimeout(200);
                  await input.fill(selector.fill);
                  await input.dispatchEvent('input');
                  await input.dispatchEvent('change');
                  await input.dispatchEvent('blur');
                  serverLog.info(`   ✅ Поле "${selector.name}" заполнено через ID "${id}": ${String(selector.fill).slice(0, 20)}`);
                  fieldsFilled++;
                  filled = true;
                }
              }
            }
          } catch (labelErr) {
            serverLog.debug(`   ⚠️ Не удалось найти через label: ${labelErr.message}`);
          }
        }
              
        if (!filled) {
          serverLog.debug(`   ℹ️ Поле "${selector.name}" не найдено — пропускаем`);
          fieldsSkipped++;
        }
      }

      // Дополнительное заполнение для iRecommend через JavaScript
      if (isIRecommend) {
        serverLog.info(`   🔧 iRecommend: дополнительное заполнение через JavaScript...`);
        
        try {
          const loginValue = email.split('@')[0];
          const filledFields = await page.evaluate(({ loginValue, email, password }) => {
            const result = { login: false, email: false, password: false, passwordConfirm: false };
            
            // ========== ЗАПОЛНЕНИЕ LOGIN (name="name") ==========
            const loginInput = document.querySelector('input[name="name"], #edit-name');
            if (loginInput && loginInput.type === 'text') {
              loginInput.focus();
              loginInput.value = loginValue;
              loginInput.dispatchEvent(new Event('input', { bubbles: true }));
              loginInput.dispatchEvent(new Event('change', { bubbles: true }));
              loginInput.dispatchEvent(new Event('blur', { bubbles: true }));
              result.login = true;
              console.log('Login заполнен:', loginValue);
            }
            
            // ========== ЗАПОЛНЕНИЕ EMAIL (name="mail") ==========
            const emailInput = document.querySelector('input[name="mail"], #edit-mail');
            if (emailInput && emailInput.type === 'text') {
              emailInput.focus();
              emailInput.value = email;
              emailInput.dispatchEvent(new Event('input', { bubbles: true }));
              emailInput.dispatchEvent(new Event('change', { bubbles: true }));
              emailInput.dispatchEvent(new Event('blur', { bubbles: true }));
              result.email = true;
              console.log('Email заполнен:', email);
            }
            
            // ========== ЗАПОЛНЕНИЕ PASSWORD (name="pass[pass1]") ==========
            const passwordInput = document.querySelector('input[name="pass[pass1]"], #edit-pass-pass1');
            if (passwordInput) {
              passwordInput.value = password;
              passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
              passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
              passwordInput.dispatchEvent(new Event('blur', { bubbles: true }));
              result.password = true;
              console.log('Password заполнен');
            }
            
            // ========== ЗАПОЛНЕНИЕ PASSWORD_CONFIRM (name="pass[pass2]") ==========
            const passwordConfirmInput = document.querySelector('input[name="pass[pass2]"], #edit-pass-pass2');
            if (passwordConfirmInput) {
              passwordConfirmInput.value = password;
              passwordConfirmInput.dispatchEvent(new Event('input', { bubbles: true }));
              passwordConfirmInput.dispatchEvent(new Event('change', { bubbles: true }));
              passwordConfirmInput.dispatchEvent(new Event('blur', { bubbles: true }));
              result.passwordConfirm = true;
              console.log('Password Confirm заполнен');
            }
            
            return result;
          }, { loginValue, email, password });
          
          if (filledFields.login) {
            serverLog.info(`   ✅ Login заполнен через JavaScript: ${loginValue}`);
            fieldsFilled++;
          } else {
            serverLog.warn(`   ⚠️ Не удалось заполнить Login`);
          }
          
          if (filledFields.email) {
            serverLog.info(`   ✅ Email заполнен через JavaScript: ${email}`);
            fieldsFilled++;
          } else {
            serverLog.warn(`   ⚠️ Не удалось заполнить Email`);
          }
          
          if (filledFields.password) {
            serverLog.info(`   ✅ Password заполнен через JavaScript`);
            fieldsFilled++;
          }
          if (filledFields.passwordConfirm) {
            serverLog.info(`   ✅ Password Confirm заполнен через JavaScript`);
            fieldsFilled++;
          }
          
          // Делаем скриншот для проверки
          await page.screenshot({ path: 'irecommend-filled.png', fullPage: false });
          serverLog.info(`   📸 Скриншот заполненной формы: irecommend-filled.png`);
          
        } catch (err) {
          serverLog.error(`   ⚠️ Ошибка JavaScript заполнения: ${err.message}`);
          await page.screenshot({ path: 'irecommend-error.png', fullPage: false });
        }
      }

      // Дополнительное заполнение для Orgpage через JavaScript
      if (isOrgpage) {
        serverLog.info(`   🔧 Orgpage: дополнительное заполнение через JavaScript...`);
        
        try {
          // Ждём полной загрузки формы
          await page.waitForTimeout(2000);
          
          const filledFields = await page.evaluate(({ websiteData, email, password }) => {
            const result = { company: false, email: false, password: false, password2: false, phone: false, site: false };
            
            // ========== ЗАПОЛНЕНИЕ COMPANY ==========
            const companyInput = document.querySelector('input[name="Company"]');
            if (companyInput) {
              companyInput.focus();
              companyInput.value = websiteData.name;
              companyInput.dispatchEvent(new Event('input', { bubbles: true }));
              companyInput.dispatchEvent(new Event('change', { bubbles: true }));
              result.company = true;
              console.log('Company заполнен:', websiteData.name);
            }
            
            // ========== ЗАПОЛНЕНИЕ EMAIL ==========
            const emailInput = document.querySelector('input[name="Email"]');
            if (emailInput) {
              emailInput.focus();
              emailInput.value = email;
              emailInput.dispatchEvent(new Event('input', { bubbles: true }));
              emailInput.dispatchEvent(new Event('change', { bubbles: true }));
              result.email = true;
              console.log('Email заполнен:', email);
            }
            
            // ========== ЗАПОЛНЕНИЕ PASSWORD ==========
            const passwordInput = document.querySelector('input[name="Password"]');
            if (passwordInput) {
              passwordInput.value = password;
              passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
              passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
              result.password = true;
              console.log('Password заполнен');
            }
            
            // ========== ЗАПОЛНЕНИЕ PASSWORD2 ==========
            const password2Input = document.querySelector('input[name="Password2"], input[name="password2"]');
            if (password2Input) {
              password2Input.value = password;
              password2Input.dispatchEvent(new Event('input', { bubbles: true }));
              password2Input.dispatchEvent(new Event('change', { bubbles: true }));
              result.password2 = true;
              console.log('Password2 заполнен');
            }
            
            // ========== ЗАПОЛНЕНИЕ PHONE ==========
            const phoneInput = document.querySelector('input[name="Phone"]');
            if (phoneInput && websiteData.phone) {
              phoneInput.value = websiteData.phone;
              phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
              phoneInput.dispatchEvent(new Event('change', { bubbles: true }));
              result.phone = true;
              console.log('Phone заполнен');
            }
            
            // ========== ЗАПОЛНЕНИЕ SITE ==========
            const siteInput = document.querySelector('input[name="Site"]');
            if (siteInput && websiteData.website) {
              siteInput.value = websiteData.website;
              siteInput.dispatchEvent(new Event('input', { bubbles: true }));
              siteInput.dispatchEvent(new Event('change', { bubbles: true }));
              result.site = true;
              console.log('Site заполнен');
            }
            
            return result;
          }, { websiteData, email, password });
          
          if (filledFields.company) {
            serverLog.info(`   ✅ Company заполнен через JavaScript`);
            fieldsFilled++;
          }
          if (filledFields.email) {
            serverLog.info(`   ✅ Email заполнен через JavaScript`);
            fieldsFilled++;
          }
          if (filledFields.password) {
            serverLog.info(`   ✅ Password заполнен через JavaScript`);
            fieldsFilled++;
          }
          if (filledFields.password2) {
            serverLog.info(`   ✅ Password2 заполнен через JavaScript`);
            fieldsFilled++;
          }
          if (filledFields.phone) {
            serverLog.info(`   ✅ Phone заполнен через JavaScript`);
            fieldsFilled++;
          }
          if (filledFields.site) {
            serverLog.info(`   ✅ Site заполнен через JavaScript`);
            fieldsFilled++;
          }
          
          // Делаем скриншот для проверки
          await page.screenshot({ path: 'orgpage-filled.png', fullPage: false });
          serverLog.info(`   📸 Скриншот заполненной формы: orgpage-filled.png`);
          
        } catch (err) {
          serverLog.error(`   ⚠️ Ошибка JavaScript заполнения: ${err.message}`);
          await page.screenshot({ path: 'orgpage-error.png', fullPage: false });
        }
      }

      serverLog.info(`📊 Заполнено полей: ${fieldsFilled} из ${fieldsFilled + fieldsSkipped}`);

      // Дополнительное заполнение для Flado - поле "Имя" через label
      if (domain.includes('flado')) {
        try {
          serverLog.info(`   🔍 Flado: дополнительный поиск поля "Имя *"...`);
          const emailName = email.split('@')[0];
          let nameFilled = false;
          
          // Способ 1: Ищем input рядом с label "Имя *"
          const nameLabel = await page.$('label:has-text("Имя *"), label:has-text("Имя")');
          if (nameLabel) {
            const nameInput = await nameLabel.$('input[type="text"]');
            if (nameInput) {
              await nameInput.click();
              await page.waitForTimeout(200);
              await nameInput.fill('');
              await page.waitForTimeout(200);
              await nameInput.fill(emailName);
              serverLog.info(`   ✅ Поле "Имя *" заполнено через label: ${emailName}`);
              nameFilled = true;
            }
          }
          
          // Способ 2: Ищем input после label "Имя *" через DOM навигацию
          if (!nameFilled) {
            const nameInput = await page.$('label:has-text("Имя *") + input[type="text"], label:has-text("Имя") + input[type="text"]');
            if (nameInput) {
              await nameInput.click();
              await page.waitForTimeout(200);
              await nameInput.fill('');
              await page.waitForTimeout(200);
              await nameInput.fill(emailName);
              serverLog.info(`   ✅ Поле "Имя *" заполнено (способ 2): ${emailName}`);
              nameFilled = true;
            }
          }
          
          // Способ 3: Ищем input с aria-label или placeholder "Имя *"
          if (!nameFilled) {
            const nameInput = await page.$('input[aria-label*="Имя"]:visible, input[placeholder*="Имя *"]:visible, input[placeholder*="Введите имя"]:visible');
            if (nameInput) {
              await nameInput.click();
              await page.waitForTimeout(200);
              await nameInput.fill('');
              await page.waitForTimeout(200);
              await nameInput.fill(emailName);
              serverLog.info(`   ✅ Поле "Имя *" заполнено через aria-label/placeholder: ${emailName}`);
              nameFilled = true;
            }
          }
          
          // Способ 4: Ищем все text input и проверяем их контекст
          if (!nameFilled) {
            const allInputs = await page.$$('input[type="text"]:visible');
            for (const input of allInputs) {
              try {
                const ariaLabel = await input.getAttribute('aria-label');
                const placeholder = await input.getAttribute('placeholder');
                const id = await input.getAttribute('id');
                const name = await input.getAttribute('name');
                
                // Проверяем наличие "Имя" в атрибутах
                if ((ariaLabel && ariaLabel.includes('Имя')) ||
                    (placeholder && placeholder.includes('Имя')) ||
                    (id && id.toLowerCase().includes('name')) ||
                    (name && name.toLowerCase().includes('name'))) {
                  await input.click();
                  await page.waitForTimeout(200);
                  await input.fill('');
                  await page.waitForTimeout(200);
                  await input.fill(emailName);
                  serverLog.info(`   ✅ Поле "Имя *" заполнено через атрибут: ${emailName}`);
                  nameFilled = true;
                  break;
                }
              } catch (e) {
                // Продолжаем поиск
              }
            }
          }
              
          // Способ 5: Ищем input после email через CSS селектор
          if (!nameFilled) {
            const nameInput = await page.$('input[type="email"] + input[type="text"]:not([name="email"]), input[name="email"] + input[type="text"]');
            if (nameInput) {
              await nameInput.click();
              await page.waitForTimeout(200);
              await nameInput.fill('');
              await page.waitForTimeout(200);
              await nameInput.fill(emailName);
              serverLog.info(`   ✅ Поле "Имя *" заполнено (после email): ${emailName}`);
              nameFilled = true;
            }
          }
          
          // Способ 6: Заполняем первый text input после email через JavaScript
          if (!nameFilled) {
            const found = await page.evaluate((emailName) => {
              const emailInput = document.querySelector('input[type="email"], input[name="email"]');
              if (emailInput) {
                let next = emailInput.nextElementSibling;
                while (next) {
                  if (next.tagName === 'INPUT' && next.type === 'text') {
                    next.value = emailName;
                    next.dispatchEvent(new Event('input', { bubbles: true }));
                    next.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                  next = next.nextElementSibling;
                }
              }
              return false;
            }, emailName);
            
            if (found) {
              serverLog.info(`   ✅ Поле "Имя *" заполнено через JavaScript: ${emailName}`);
              nameFilled = true;
            }
          }
          
          if (!nameFilled) {
            serverLog.warn(`   ⚠️ Не удалось найти поле "Имя *"`);
          }
        } catch (err) {
          serverLog.debug(`   ℹ️ Не удалось заполнить "Имя *" дополнительно: ${err.message}`);
        }
      }

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
      else if (domain.includes('orgpage')) {
        // Orgpage: чекбоксы согласия и CAPTCHA
        try {
          serverLog.info(`   📋 Orgpage: обработка чекбоксов...`);
          
          // Ждём появления чекбоксов
          await page.waitForTimeout(1500);
          
          // ========== ЧЕКБОКС "Я НЕ РОБОТ" (CAPTCHA) ==========
          serverLog.info(`   🤖 Orgpage: поиск чекбокса "Я не робот"...`);
          
          let captchaChecked = false;
          
          // Способ 1: Ищем reCAPTCHA v2 (обычный чекбокс)
          try {
            const recaptchaCheckbox = await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 5000 });
            if (recaptchaCheckbox) {
              serverLog.info(`   🖼️ Найден reCAPTCHA iframe, пытаемся кликнуть...`);
              
              // Переключаемся на iframe reCAPTCHA
              const frame = page.frameLocator('iframe[src*="recaptcha"]');
              const checkbox = frame.locator('.recaptcha-checkbox-border');
              
              if (await checkbox.count() > 0) {
                await checkbox.click();
                serverLog.info(`   ✅ reCAPTCHA отмечена`);
                captchaChecked = true;
                
                // Ждём подтверждения (зелёная галочка)
                await page.waitForTimeout(2000);
              }
            }
          } catch (e) {
            serverLog.debug(`   ℹ️ reCAPTCHA iframe не найден: ${e.message}`);
          }
          
          // Способ 2: Ищем чекбокс "Я не робот" по тексту
          if (!captchaChecked) {
            const captchaLabel = await page.$('label:has-text("Я не робот"), label:has-text("I\'m not a robot"), label:has-text("Не робот")');
            if (captchaLabel) {
              const checkbox = await captchaLabel.$('input[type="checkbox"]');
              if (checkbox) {
                await checkbox.check();
                serverLog.info(`   ✅ Чекбокс "Я не робот" отмечен`);
                captchaChecked = true;
                await page.waitForTimeout(1000);
              }
            }
          }
          
          // Способ 3: Ищем чекбокс по классам/атрибутам reCAPTCHA
          if (!captchaChecked) {
            const recaptchaCheck = await page.$('.recaptcha-checkbox:not(.recaptcha-checkbox-checked), input[type="checkbox"][name*="recaptcha"], [data-recaptcha-version]');
            if (recaptchaCheck) {
              await recaptchaCheck.click();
              serverLog.info(`   ✅ reCAPTCHA чекбокс отмечен (по классу)`);
              captchaChecked = true;
              await page.waitForTimeout(2000);
            }
          }
          
          // Способ 4: Ищем все чекбоксы рядом с текстом "робот"
          if (!captchaChecked) {
            const allCheckboxes = await page.$$('input[type="checkbox"]:visible');
            for (const cb of allCheckboxes) {
              try {
                const parent = await cb.evaluateHandle(el => el.parentElement);
                if (parent) {
                  const parentText = await parent.evaluate(el => el.textContent || '');
                  if (parentText.toLowerCase().includes('робот') || 
                      parentText.toLowerCase().includes('captcha') ||
                      parentText.toLowerCase().includes('not a robot')) {
                    await cb.check();
                    serverLog.info(`   ✅ Чекбокс "Я не робот" отмечен (по тексту рядом)`);
                    captchaChecked = true;
                    await page.waitForTimeout(1000);
                    break;
                  }
                }
              } catch (e) {
                // Продолжаем поиск
              }
            }
          }
              
          // Способ 5: JavaScript fallback для reCAPTCHA
          if (!captchaChecked) {
            const clicked = await page.evaluate(() => {
              // Ищем iframe reCAPTCHA
              const recaptchaIframe = document.querySelector('iframe[src*="recaptcha"]');
              if (recaptchaIframe) {
                // Пытаемся кликнуть через postMessage (работает не всегда)
                console.log('reCAPTCHA iframe найден, но требуется ручное подтверждение');
                return 'iframe_found';
              }
              
              // Ищем чекбокс по тексту
              const labels = Array.from(document.querySelectorAll('label'));
              for (const label of labels) {
                const text = label.textContent || '';
                if (text.includes('Я не робот') || 
                    text.includes("I'm not a robot") ||
                    text.includes('Не робот')) {
                  const checkbox = label.querySelector('input[type="checkbox"]');
                  if (checkbox) {
                    checkbox.checked = true;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
              }
              return false;
            });
            
            if (clicked === true) {
              serverLog.info(`   ✅ Чекбокс "Я не робот" отмечен через JavaScript`);
              captchaChecked = true;
            } else if (clicked === 'iframe_found') {
              serverLog.warn(`   ⚠️ reCAPTCHA требует ручного подтверждения`);
            }
          }
          
          if (!captchaChecked) {
            serverLog.warn(`   ⚠️ Чекбокс "Я не робот" не найден или требует ручного подтверждения`);
            serverLog.info(`   💡 Введите CAPTCHA вручную, если появится`);
          }
          
          // ========== ЧЕКБОКС СОГЛАСИЯ С ПРАВИЛАМИ ==========
          serverLog.info(`   📋 Orgpage: поиск чекбокса согласия с правилами...`);
          
          let agreeChecked = false;
          
          // Способ 1: Ищем чекбокс по тексту метки
          const agreeLabel = await page.$('label:has-text("Я согласен"), label:has-text("согласие на обработку"), label:has-text("правилами сайта"), label:has-text("Пользовательское соглашение"), label:has-text("Я принимаю")');
          if (agreeLabel) {
            const checkbox = await agreeLabel.$('input[type="checkbox"]');
            if (checkbox) {
              await checkbox.check();
              serverLog.info(`   ✅ Чекбокс согласия отмечен`);
              agreeChecked = true;
            }
          }
          
          // Способ 2: Ищем чекбокс по name/id
          if (!agreeChecked) {
            const agreeCheckbox = await page.$('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="policy"]:visible, input[type="checkbox"][name*="consent"]:visible, input[type="checkbox"][name*="rules"]:visible, input[type="checkbox"][id*="agree"]:visible');
            if (agreeCheckbox) {
              await agreeCheckbox.check();
              serverLog.info(`   ✅ Чекбокс согласия отмечен (по name/id)`);
              agreeChecked = true;
            }
          }
          
          // Способ 3: Ищем все чекбоксы и отмечаем подходящий
          if (!agreeChecked) {
            const allCheckboxes = await page.$$('input[type="checkbox"]:visible');
            for (const cb of allCheckboxes) {
              try {
                const parent = await cb.evaluateHandle(el => el.parentElement);
                if (parent) {
                  const parentText = await parent.evaluate(el => el.textContent || '');
                  if (parentText.includes('согласен') || 
                      parentText.includes('согласие') || 
                      parentText.includes('правила') ||
                      parentText.includes('персональных данных') ||
                      parentText.includes('обработкой')) {
                    await cb.check();
                    serverLog.info(`   ✅ Чекбокс согласия отмечен (в форме)`);
                    agreeChecked = true;
                    break;
                  }
                }
              } catch (e) {
                // Продолжаем поиск
              }
            }
          }
          
          // Способ 4: Fallback через JavaScript
          if (!agreeChecked) {
            const clicked = await page.evaluate(() => {
              const labels = Array.from(document.querySelectorAll('label'));
              for (const label of labels) {
                const text = label.textContent || '';
                if (text.includes('согласен') || 
                    text.includes('согласие') || 
                    text.includes('правила') ||
                    text.includes('персональных данных')) {
                  const checkbox = label.querySelector('input[type="checkbox"]');
                  if (checkbox) {
                    checkbox.checked = true;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
              }
              return false;
            });
            
            if (clicked) {
              serverLog.info(`   ✅ Чекбокс согласия отмечен через JavaScript`);
              agreeChecked = true;
            }
          }
          
          if (!agreeChecked) {
            serverLog.debug(`   ℹ️ Чекбокс согласия не найден`);
          }
          
          // Делаем скриншот для проверки
          await page.screenshot({ path: 'orgpage-checkboxes.png', fullPage: false });
          serverLog.info(`   📸 Скриншот чекбоксов: orgpage-checkboxes.png`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось обработать чекбоксы Orgpage: ${err.message}`);
        }
      }
      else if (domain.includes('irecommend')) {
        // iRecommend: чекбоксы согласия и CAPTCHA
        try {
          serverLog.info(`   📋 iRecommend: обработка чекбоксов...`);
          
          // ========== УВЕЛИЧЕННОЕ ОЖИДАНИЕ ==========
          serverLog.info(`   ⏳ Ожидание загрузки чекбоксов (7 секунд)...`);
          await page.waitForTimeout(7000);
          
          // ========== ЧЕКБОКС "Я НЕ РОБОТ" (CAPTCHA) ==========
          serverLog.info(`   🤖 iRecommend: поиск и отметка "Я не робот"...`);
          
          let captchaChecked = false;
          let captchaAttempts = 0;
          const maxCaptchaAttempts = 5;
          
          while (!captchaChecked && captchaAttempts < maxCaptchaAttempts) {
            captchaAttempts++;
            serverLog.info(`   🔍 Попытка отметить CAPTCHA #${captchaAttempts} из ${maxCaptchaAttempts}...`);
          
            // Способ 1: Пробуем кликнуть через iframe reCAPTCHA
            try {
              const recaptchaIframe = await page.waitForSelector('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]', { timeout: 3000 });
              if (recaptchaIframe) {
                serverLog.info(`   🖼️ Найден reCAPTCHA iframe`);
                
                // Получаем iframe для взаимодействия
                const frame = page.frames().find(f => f.url().includes('recaptcha') || f.url().includes('google.com'));
                
                if (frame) {
                  try {
                    // Ждём появления чекбокса в iframe
                    await frame.waitForSelector('.recaptcha-checkbox-border, .recaptcha-checkbox', { timeout: 3000 });
                    
                    // Кликаем по чекбоксу в iframe
                    const checkbox = await frame.$('.recaptcha-checkbox-border, .recaptcha-checkbox');
                    if (checkbox) {
                      await checkbox.click();
                      serverLog.info(`   ✅ Клик по reCAPTCHA выполнен`);
                      
                      // Ждём подтверждения
                      serverLog.info(`   ⏳ Ожидание подтверждения reCAPTCHA (5 секунд)...`);
                      await page.waitForTimeout(5000);
                      
                      // Проверяем, что галочка появилась
                      const isConfirmed = await page.evaluate(() => {
                        return !!document.querySelector('.recaptcha-checkbox-checked');
                      });
                      
                      if (isConfirmed) {
                        serverLog.info(`   ✅ reCAPTCHA подтверждена (зелёная галочка)`);
                        captchaChecked = true;
                      } else {
                        serverLog.warn(`   ⚠️ reCAPTCHA не подтверждена, пробуем ещё раз`);
                      }
                    }
                  } catch (frameErr) {
                    serverLog.debug(`   ⚠️ Ошибка взаимодействия с iframe: ${frameErr.message}`);
                  }
                }
                
                // Альтернативный способ через frameLocator
                if (!captchaChecked) {
                  try {
                    const frameLocator = page.frameLocator('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]');
                    const checkbox = frameLocator.locator('.recaptcha-checkbox-border, .recaptcha-checkbox').first();
                    await checkbox.click();
                    serverLog.info(`   ✅ reCAPTCHA отмечена через frameLocator`);
                    await page.waitForTimeout(5000);
                    captchaChecked = true;
                  } catch (flErr) {
                    serverLog.debug(`   ⚠️ Ошибка frameLocator: ${flErr.message}`);
                  }
                }
              }
            } catch (e) {
              serverLog.debug(`   ℹ️ reCAPTCHA iframe не найден: ${e.message}`);
            }
          
            // Способ 2: Ищем чекбокс "Я не робот" по тексту на странице
            if (!captchaChecked) {
              serverLog.debug(`   🔍 Поиск чекбокса по тексту...`);
              
              const captchaElements = await page.$$eval(
                'input[type="checkbox"], label, span, div',
                (elements) => {
                  const results = [];
                  for (const el of elements) {
                    const text = (el.textContent || '').toLowerCase();
                    if (text.includes('не робот') || text.includes('не робот') || text.includes('not a robot') || text.includes('captcha')) {
                      let checkbox = null;
                      
                      if (el.tagName === 'INPUT' && el.type === 'checkbox') {
                        checkbox = { found: true, isInput: true };
                      } else {
                        const input = el.querySelector('input[type="checkbox"]');
                        if (input) {
                          checkbox = { found: true, isInput: false };
                        }
                      }
                      
                      if (checkbox) {
                        results.push({
                          tag: el.tagName,
                          text: text.substring(0, 100),
                          checkbox: checkbox
                        });
                      }
                    }
                  }
                  return results;
                }
              );
              
              if (captchaElements.length > 0) {
                serverLog.info(`   ✅ Найден элемент с текстом CAPTCHA`);
                
                // Пытаемся кликнуть через JavaScript
                const clicked = await page.evaluate(() => {
                  // Ищем label с текстом про робота
                  const labels = Array.from(document.querySelectorAll('label, span, div, p'));
                  for (const label of labels) {
                    const text = (label.textContent || '').toLowerCase();
                    if (text.includes('не робот') || text.includes('not a robot') || text.includes('captcha')) {
                      // Ищем чекбокс внутри или рядом
                      const checkbox = label.querySelector('input[type="checkbox"]');
                      if (checkbox) {
                        checkbox.checked = true;
                        checkbox.dispatchEvent(new Event('click', { bubbles: true }));
                        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                      }
                      
                      // Кликаем по label
                      label.click();
                      return true;
                    }
                  }
                  return false;
                });
                
                if (clicked) {
                  serverLog.info(`   ✅ CAPTCHA отмечена через JavaScript`);
                  captchaChecked = true;
                  await page.waitForTimeout(3000);
                }
              }
            }
          
            // Способ 3: Ищем по классам reCAPTCHA
            if (!captchaChecked) {
              const recaptchaCheck = await page.$('.recaptcha-checkbox:not(.recaptcha-checkbox-checked)');
              if (recaptchaCheck) {
                try {
                  await recaptchaCheck.click();
                  serverLog.info(`   ✅ reCAPTCHA чекбокс отмечен (по классу)`);
                  captchaChecked = true;
                  await page.waitForTimeout(5000);
                } catch (e) {
                  serverLog.debug(`   ⚠️ Ошибка клика по reCAPTCHA: ${e.message}`);
                }
              }
            }
            
            // Если не удалось и это не последняя попытка, ждём
            if (!captchaChecked && captchaAttempts < maxCaptchaAttempts) {
              serverLog.warn(`   ⚠️ Попытка #${captchaAttempts} не удалась, ожидание...`);
              await page.waitForTimeout(4000);
            }
          }
          
          if (captchaChecked) {
            serverLog.info(`   ✅ CAPTCHA успешно отмечена!`);
          } else {
            serverLog.warn(`   ⚠️ Не удалось отметить CAPTCHA после ${maxCaptchaAttempts} попыток`);
            serverLog.info(`   💡 Возможно, требуется ручное подтверждение reCAPTCHA`);
          }
          
          // ========== ЧЕКБОКС СОГЛАСИЯ С ПРАВИЛАМИ ==========
          serverLog.info(`   📋 iRecommend: отметка "Принимаю Пользовательское соглашение"...`);
          
          let agreementChecked = false;
          let agreementAttempts = 0;
          const maxAgreementAttempts = 3;
          
          while (!agreementChecked && agreementAttempts < maxAgreementAttempts) {
            agreementAttempts++;
            serverLog.debug(`   🔍 Попытка отметить соглашение #${agreementAttempts}...`);
          
            // Пробуем разные селекторы
            const agreementSelectors = [
              'input[name="reg_user_agreement"]:visible',
              '#edit-reg-user-agreement:visible',
              'input[type="checkbox"][name*="agreement"]:visible',
              'input[type="checkbox"][id*="agreement"]:visible',
              'label:has-text("Пользовательское соглашение") input[type="checkbox"]',
              'label:has-text("принимаю") input[type="checkbox"]',
              'label:has-text("согласие") input[type="checkbox"]'
            ];
          
            for (const selector of agreementSelectors) {
              try {
                const checkbox = await page.$(selector);
                if (checkbox) {
                  serverLog.info(`   ✅ Найден чекбокс соглашения: ${selector}`);
                  
                  // Проверяем, не отмечен ли уже
                  const isChecked = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    return el ? el.checked : false;
                  }, selector);
                  
                  if (!isChecked) {
                    // Кликаем через JavaScript для надёжности
                    await page.evaluate((sel) => {
                      const checkbox = document.querySelector(sel);
                      if (checkbox) {
                        checkbox.checked = true;
                        checkbox.dispatchEvent(new Event('click', { bubbles: true }));
                        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                        checkbox.dispatchEvent(new Event('input', { bubbles: true }));
                      }
                    }, selector);
                    
                    serverLog.info(`   ✅ Чекбокс соглашения отмечен`);
                    agreementChecked = true;
                    break;
                  } else {
                    serverLog.info(`   ✅ Чекбокс соглашения уже отмечен`);
                    agreementChecked = true;
                    break;
                  }
                }
              } catch (e) {
                serverLog.debug(`   ⚠️ Селектор ${selector} не сработал: ${e.message}`);
              }
            }
          
            // Если не нашли по селекторам, ищем через JavaScript
            if (!agreementChecked) {
              const found = await page.evaluate(() => {
                // Ищем по тексту "Пользовательское соглашение" или "принимаю"
                const labels = Array.from(document.querySelectorAll('label'));
                for (const label of labels) {
                  const text = (label.textContent || '').toLowerCase();
                  if (text.includes('пользовательское соглашение') || 
                      text.includes('принимаю') || 
                      text.includes('условиями') ||
                      text.includes('правилами')) {
                    const checkbox = label.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                      checkbox.checked = true;
                      checkbox.dispatchEvent(new Event('click', { bubbles: true }));
                      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                      return true;
                    }
                  }
                }
                
                // Ищем любой чекбокс с name containing "agreement"
                const checkboxes = document.querySelectorAll('input[type="checkbox"][name*="agreement"], input[type="checkbox"][id*="agreement"]');
                for (const cb of checkboxes) {
                  cb.checked = true;
                  cb.dispatchEvent(new Event('click', { bubbles: true }));
                  cb.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }
                
                return false;
              });
              
              if (found) {
                serverLog.info(`   ✅ Чекбокс соглашения найден через JavaScript`);
                agreementChecked = true;
              }
            }
          
            // Проверяем, не сбросился ли чекбокс
            if (agreementChecked) {
              await page.waitForTimeout(1000);
              
              const stillChecked = await page.evaluate(() => {
                const checkbox = document.querySelector('input[name="reg_user_agreement"], #edit-reg-user-agreement');
                return checkbox ? checkbox.checked : false;
              });
              
              if (!stillChecked) {
                serverLog.warn(`   ⚠️ Чекбокс соглашения сбросился, пробуем ещё раз`);
                agreementChecked = false;
                
                if (agreementAttempts < maxAgreementAttempts) {
                  await page.waitForTimeout(2000);
                }
              }
            }
          }
          
          if (!agreementChecked) {
            serverLog.warn(`   ⚠️ Не удалось отметить чекбокс соглашения после ${maxAgreementAttempts} попыток`);
          }
          
          // ========== ЧЕКБОКС СОГЛАСИЯ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ ==========
          serverLog.info(`   📋 iRecommend: отметка "Соглашаюсь на обработку персональных данных"...`);
          
          let personalChecked = false;
          
          // Способ 1: Ищем по name/id атрибутам
          const personalSelectors = [
            'input[name="reg_personal_data"]:visible',
            '#edit-reg-personal-data:visible',
            'input[type="checkbox"][name*="personal"]:visible',
            'input[type="checkbox"][name*="data"]:visible'
          ];
          
          for (const selector of personalSelectors) {
            try {
              const checkbox = await page.$(selector);
              if (checkbox) {
                const isChecked = await page.evaluate((sel) => {
                  const el = document.querySelector(sel);
                  return el ? el.checked : false;
                }, selector);
                
                if (!isChecked) {
                  await page.evaluate((sel) => {
                    const checkbox = document.querySelector(sel);
                    if (checkbox) {
                      checkbox.checked = true;
                      checkbox.dispatchEvent(new Event('click', { bubbles: true }));
                      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }, selector);
                  serverLog.info(`   ✅ Чекбокс персональных данных отмечен (селектор: ${selector})`);
                  personalChecked = true;
                  break;
                } else {
                  serverLog.info(`   ✅ Чекбокс персональных данных уже отмечен`);
                  personalChecked = true;
                  break;
                }
              }
            } catch (e) {
              // Продолжаем поиск
            }
          }
          
          // Способ 2: Ищем по тексту метки "Соглашаюсь на обработку персональных данных"
          if (!personalChecked) {
            serverLog.info(`   🔍 Поиск чекбокса по тексту метки...`);
            const personalFound = await page.evaluate(() => {
              const labels = Array.from(document.querySelectorAll('label'));
              for (const label of labels) {
                const text = (label.textContent || '').toLowerCase();
                // Ищем по ключевым фразам
                if (text.includes('согласен на обработку персональных данных') || 
                    text.includes('согласие на обработку персональных данных') ||
                    text.includes('персональных данных') ||
                    text.includes('персональные данные')) {
                  const checkbox = label.querySelector('input[type="checkbox"]');
                  if (checkbox) {
                    checkbox.checked = true;
                    checkbox.dispatchEvent(new Event('click', { bubbles: true }));
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                  }
                }
              }
              return false;
            });
            
            if (personalFound) {
              serverLog.info(`   ✅ Чекбокс персональных данных найден по тексту метки`);
              personalChecked = true;
            }
          }
          
          // Способ 3: Ищем все чекбоксы на странице и проверяем их контекст
          if (!personalChecked) {
            serverLog.info(`   🔍 Поиск чекбокса в DOM...`);
            const allCheckboxes = await page.$$('input[type="checkbox"]:visible');
            serverLog.debug(`   📊 Найдено чекбоксов: ${allCheckboxes.length}`);
            
            for (const cb of allCheckboxes) {
              try {
                const parent = await cb.evaluateHandle(el => el.parentElement);
                if (parent) {
                  const parentText = await parent.evaluate(el => el.textContent || '');
                  if (parentText.includes('согласен на обработку') || 
                      parentText.includes('согласие на обработку') || 
                      parentText.includes('персональных данных') ||
                      parentText.includes('политикой конфиденциальности')) {
                    const isChecked = await cb.isChecked();
                    if (!isChecked) {
                      await cb.check();
                      serverLog.info(`   ✅ Чекбокс персональных данных отмечен (в DOM)`);
                    } else {
                      serverLog.info(`   ✅ Чекбокс персональных данных уже отмечен (в DOM)`);
                    }
                    personalChecked = true;
                    break;
                  }
                }
              } catch (e) {
                // Продолжаем поиск
              }
            }
          }
              
          // Способ 4: Прямое нажатие через JavaScript (fallback)
          if (!personalChecked) {
            serverLog.info(`   🔍 Попытка отметить чекбокс через JavaScript...`);
            const clicked = await page.evaluate(() => {
              // Ищем все чекбоксы и отмечаем подходящий
              const checkboxes = document.querySelectorAll('input[type="checkbox"]');
              for (const cb of checkboxes) {
                // Ищем чекбокс рядом с текстом о персональных данных
                let parent = cb.parentElement;
                while (parent && parent.tagName !== 'BODY') {
                  const text = (parent.textContent || '').toLowerCase();
                  if (text.includes('персональных данных') || text.includes('персональные данные')) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    cb.dispatchEvent(new Event('click', { bubbles: true }));
                    return true;
                  }
                  parent = parent.parentElement;
                }
              }
              return false;
            });
            
            if (clicked) {
              serverLog.info(`   ✅ Чекбокс персональных данных отмечен через JavaScript`);
              personalChecked = true;
            }
          }
          
          if (!personalChecked) {
            serverLog.warn(`   ⚠️ Не удалось найти чекбокс персональных данных`);
          }
          
          // ========== ФИНАЛЬНАЯ ПРОВЕРКА ==========
          serverLog.info(`   🔍 Финальная проверка чекбоксов (через 3 секунды)...`);
          await page.waitForTimeout(3000);
          
          const finalCheck = await page.evaluate(() => {
            const agreementEl = document.querySelector('input[name="reg_user_agreement"], #edit-reg-user-agreement');
            const personalEl = document.querySelector('input[name="reg_personal_data"], #edit-reg-personal-data');
            const recaptchaChecked = !!document.querySelector('.recaptcha-checkbox-checked');
            
            return {
              captcha: recaptchaChecked,
              agreement: agreementEl ? agreementEl.checked : false,
              personalData: personalEl ? personalEl.checked : false
            };
          });
          
          serverLog.info(`   📊 Финальный статус: CAPTCHA=${finalCheck.captcha}, Agreement=${finalCheck.agreement}, PersonalData=${finalCheck.personalData}`);
          
          // Делаем скриншот для проверки
          await page.screenshot({ path: 'irecommend-checkboxes.png', fullPage: false });
          serverLog.info(`   📸 Скриншот чекбоксов: irecommend-checkboxes.png`);
          
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось обработать чекбоксы iRecommend: ${err.message}`);
          serverLog.debug(`   Stack: ${err.stack}`);
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
      else if (domain.includes('flado')) {
        // Flado: выбор рубрики и чекбоксы
        try {
          serverLog.info(`   📋 Flado: выбор сферы деятельности...`);
          
          // Пробуем заполнить поле категории/рубрики
          const categoryInput = page.locator('select[name="category"]:visible, input[name="category"]:visible, [class*="category"]:visible, [class*="rubric"]:visible');
          if (await categoryInput.count() > 0) {
            serverLog.info(`   ✅ Найдено поле категории`);
            const tagName = await categoryInput.first().evaluate(el => el.tagName);
            if (tagName === 'SELECT') {
              await page.selectOption('select[name="category"]:visible', { label: 'Бизнес' }).catch(async () => {
                await page.selectOption('select[name="category"]:visible', { index: 0 });
              });
              serverLog.info(`   ✅ Категория выбрана`);
            }
          }
          
          // Ищем чекбокс согласия с правилами Flado
          serverLog.info(`   📋 Flado: поиск чекбокса согласия...`);
          
          let agreeChecked = false;
          
          // Способ 1: Ищем по тексту метки "Я принимаю правила и даю согласие на обработку своих персональных данных"
          const agreeLabel = await page.$('label:has-text("Я принимаю правила"), label:has-text("согласие на обработку"), label:has-text("политикой конфиденциальности"), label:has-text("Я принимаю правила и даю согласие"), label:has-text("принимаю правила и даю согласие")');
          if (agreeLabel) {
            const checkbox = await agreeLabel.$('input[type="checkbox"]');
            if (checkbox) {
              try {
                const isChecked = await checkbox.isChecked();
                if (!isChecked) {
                  await checkbox.check();
                  serverLog.info(`   ✅ Чекбокс согласия с правилами отмечен`);
                  agreeChecked = true;
                } else {
                  serverLog.info(`   ✅ Чекбокс согласия уже отмечен`);
                  agreeChecked = true;
                }
              } catch (e) {
                serverLog.debug(`   ⚠️ Ошибка проверки чекбокса: ${e.message}`);
              }
            }
          }
          
          // Способ 2: Ищем чекбокс по name/id
          if (!agreeChecked) {
            const agreeCheckbox = await page.$('input[type="checkbox"][name*="agree"]:visible, input[type="checkbox"][name*="policy"]:visible, input[type="checkbox"][name*="consent"]:visible, input[type="checkbox"][name*="rules"]:visible, input[type="checkbox"][name*="personal"]:visible, input[type="checkbox"][name*="data"]:visible, input[type="checkbox"][id*="agree"]:visible, input[type="checkbox"][id*="policy"]:visible');
            if (agreeCheckbox) {
              try {
                const isChecked = await agreeCheckbox.isChecked();
                if (!isChecked) {
                  await agreeCheckbox.check();
                  serverLog.info(`   ✅ Чекбокс согласия отмечен (по name/id)`);
                  agreeChecked = true;
                } else {
                  serverLog.info(`   ✅ Чекбокс согласия уже отмечен`);
                  agreeChecked = true;
                }
              } catch (e) {
                serverLog.debug(`   ⚠️ Ошибка проверки чекбокса: ${e.message}`);
              }
            }
          }
          
          // Способ 3: Ищем все чекбоксы на странице и проверяем их рядом с текстом согласия
          if (!agreeChecked) {
            serverLog.info(`   🔍 Поиск чекбокса в форме...`);
            const allCheckboxes = await page.$$('input[type="checkbox"]:visible');
            serverLog.debug(`   📊 Найдено чекбоксов: ${allCheckboxes.length}`);
            
            for (const cb of allCheckboxes) {
              try {
                // Проверяем родительский элемент на наличие текста согласия
                const parent = await cb.evaluateHandle(el => el.parentElement);
                if (parent) {
                  const parentText = await parent.evaluate(el => el.textContent || '');
                  if (parentText.includes('принимаю правила') || 
                      parentText.includes('согласие на обработку') || 
                      parentText.includes('персональных данных') ||
                      parentText.includes('политикой конфиденциальности')) {
                    try {
                      const isChecked = await cb.isChecked();
                      if (!isChecked) {
                        await cb.check();
                        serverLog.info(`   ✅ Чекбокс согласия отмечен (в форме)`);
                        agreeChecked = true;
                      } else {
                        serverLog.info(`   ✅ Чекбокс согласия уже отмечен`);
                        agreeChecked = true;
                      }
                      break;
                    } catch (e) {
                      serverLog.debug(`   ⚠️ Ошибка проверки чекбокса: ${e.message}`);
                    }
                  }
                }
              } catch (e) {
                // Продолжаем поиск
              }
            }
          }
          
          // Способ 4: Fallback - ищем любой чекбокс с class*="agree" или class*="consent"
          if (!agreeChecked) {
            const agreeCheckbox = await page.$('input[type="checkbox"][class*="agree"]:visible, input[type="checkbox"][class*="consent"]:visible, input[type="checkbox"][class*="checkbox"]:visible, input[type="checkbox"][class*="check"]:visible');
            if (agreeCheckbox) {
              try {
                const isChecked = await agreeCheckbox.isChecked();
                if (!isChecked) {
                  await agreeCheckbox.check();
                  serverLog.info(`   ✅ Чекбокс согласия отмечен (fallback)`);
                  agreeChecked = true;
                } else {
                  serverLog.info(`   ✅ Чекбокс согласия уже отмечен`);
                  agreeChecked = true;
                }
              } catch (e) {
                serverLog.debug(`   ⚠️ Ошибка проверки чекбокса: ${e.message}`);
              }
            }
          }
          
          // Способ 5: Прямое нажатие через JavaScript
          if (!agreeChecked) {
            serverLog.info(`   🔍 Попытка отметить чекбокс через JavaScript...`);
            const clicked = await page.evaluate(() => {
              // Ищем чекбокс по тексту рядом
              const labels = Array.from(document.querySelectorAll('label'));
              for (const label of labels) {
                const text = label.textContent || '';
                if (text.includes('принимаю правила') || 
                    text.includes('согласие на обработку') || 
                    text.includes('персональных данных') ||
                    text.includes('политикой конфиденциальности')) {
                  const checkbox = label.querySelector('input[type="checkbox"]');
                  if (checkbox) {
                    checkbox.checked = true;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
              }
              
              // Ищем любой чекбокс в форме
              const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
              for (const cb of allCheckboxes) {
                if (!cb.checked) {
                  cb.checked = true;
                  cb.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }
              }
              
              return false;
            });
            
            if (clicked) {
              serverLog.info(`   ✅ Чекбокс согласия отмечен через JavaScript`);
              agreeChecked = true;
            }
          }
          
          if (!agreeChecked) {
            serverLog.warn(`   ⚠️ Не удалось найти чекбокс согласия`);
          }
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось обработать рубрику/чекбоксы Flado: ${err.message}`);
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
          
          // Пробуем найти и нажать кнопку "Продолжить"
          const continueBtn = await page.$('button:has-text("Продолжить"):visible, button:has-text("Далее"):visible, button:has-text("Next"):visible, [class*="continue"]:visible, [id*="continue"]:visible');
          if (continueBtn) {
            await continueBtn.click();
            serverLog.info(`   ✅ Нажата кнопка "Продолжить"`);
          } else {
            // Альтернативный вариант — ищем обычную кнопку отправки
            await page.click('button[type="submit"]:visible, input[type="submit"]:visible, [class*="submit"]:visible, [class*="register"]:visible, [id*="submit"]:visible, [id*="register"]:visible').catch(async () => {
              // Финальный вариант — отправка формы
              const form = await page.$('form');
              if (form) {
                await form.evaluate(f => f.submit());
              }
            });
            serverLog.info(`   ✅ Форма B2B Center отправлена`);
          }
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
      else if (domain.includes('flado')) {
        // Flado: отправка формы
        try {
          serverLog.info(`   📤 Flado: отправка формы...`);
          
          // Ждем немного для валидации
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Пробуем найти и нажать кнопку регистрации
          await page.click('button[type="submit"]:visible, input[type="submit"]:visible, [class*="submit"]:visible, [class*="register"]:visible, [id*="submit"]:visible, [id*="register"]:visible, button:has-text("Зарегистрироваться"):visible, button:has-text("Регистрация"):visible').catch(async () => {
            // Альтернативный вариант — отправка формы
            const form = await page.$('form');
            if (form) {
              await form.evaluate(f => f.submit());
            }
          });
          serverLog.info(`   ✅ Форма Flado отправлена`);
          
          // Ждем загрузки новой страницы или появления CAPTCHA (до 30 секунд)
          serverLog.debug(`   ⏳ Ожидание загрузки страницы после отправки...`);
          try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
              serverLog.debug(`   ℹ️ Переход по URL не обнаружен, продолжаем на текущей странице`);
            });
          } catch (navErr) {
            serverLog.debug(`   ℹ️ Страница не перенаправлена, продолжаем работу`);
          }
          
          // Даем странице полностью загрузиться
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(2000);
          serverLog.info(`   ✅ Страница загружена`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось отправить форму Flado: ${err.message}`);
          // Финальная попытка
          try {
            await page.click('button:not([type="button"]):visible, input[type="submit"]:visible');
            serverLog.info(`   ✅ Форма Flado отправлена (альтернативно)`);
            
            // Ждем загрузки новой страницы
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(2000);
          } catch (err2) {
            serverLog.error(`   ❌ Не удалось отправить форму Flado`);
          }
        }
      }
      else if (domain.includes('irecommend')) {
        // iRecommend: отправка формы
        try {
          serverLog.info(`   📤 iRecommend: отправка формы...`);
          
          // ========== ДОПОЛНИТЕЛЬНОЕ ОЖИДАНИЕ ==========
          serverLog.info(`   ⏳ Ожидание перед отправкой (7 секунд)...`);
          await page.waitForTimeout(7000);
          
          // Делаем скриншот перед отправкой
          await page.screenshot({ path: 'irecommend-before-submit.png', fullPage: false });
          serverLog.info(`   📸 Скриншот перед отправкой: irecommend-before-submit.png`);
          
          // ========== ФИНАЛЬНАЯ ПРОВЕРКА И ИСПРАВЛЕНИЕ ЧЕКБОКСОВ ==========
          serverLog.info(`   🔍 Финальная проверка чекбоксов перед отправкой...`);
          
          const preSubmitCheck = await page.evaluate(() => {
            const agreementEl = document.querySelector('input[name="reg_user_agreement"], #edit-reg-user-agreement');
            const personalEl = document.querySelector('input[name="reg_personal_data"], #edit-reg-personal-data');
            const recaptchaChecked = !!document.querySelector('.recaptcha-checkbox-checked');
            
            return {
              captcha: recaptchaChecked,
              agreement: agreementEl ? agreementEl.checked : false,
              personalData: personalEl ? personalEl.checked : false
            };
          });
            
          serverLog.info(`   📊 Статус перед отправкой: CAPTCHA=${preSubmitCheck.captcha}, Agreement=${preSubmitCheck.agreement}, PersonalData=${preSubmitCheck.personalData}`);
          
          // Если чекбокс соглашения не отмечен, отмечаем прямо сейчас
          if (!preSubmitCheck.agreement) {
            serverLog.warn(`   ⚠️ Чекбокс соглашения НЕ отмечен! Исправляем...`);
            
            const fixed = await page.evaluate(() => {
              const checkbox = document.querySelector('input[name="reg_user_agreement"], #edit-reg-user-agreement');
              if (checkbox) {
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event('click', { bubbles: true }));
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
              return false;
            });
            
            if (fixed) {
              serverLog.info(`   ✅ Чекбокс соглашения исправлен`);
              await page.waitForTimeout(1000);
            }
          }
          
          // Если чекбокс персональных данных не отмечен, отмечаем
          if (!preSubmitCheck.personalData) {
            serverLog.warn(`   ⚠️ Чекбокс персональных данных НЕ отмечен! Исправляем...`);
            
            const fixed = await page.evaluate(() => {
              const checkbox = document.querySelector('input[name="reg_personal_data"], #edit-reg-personal-data');
              if (checkbox) {
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event('click', { bubbles: true }));
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
              return false;
            });
            
            if (fixed) {
              serverLog.info(`   ✅ Чекбокс персональных данных исправлен`);
              await page.waitForTimeout(1000);
            }
          }
          
          // Повторная проверка
          const finalPreCheck = await page.evaluate(() => {
            const agreementEl = document.querySelector('input[name="reg_user_agreement"], #edit-reg-user-agreement');
            const personalEl = document.querySelector('input[name="reg_personal_data"], #edit-reg-personal-data');
            return {
              agreement: agreementEl ? agreementEl.checked : false,
              personalData: personalEl ? personalEl.checked : false
            };
          });
          
          serverLog.info(`   📊 После исправления: Agreement=${finalPreCheck.agreement}, PersonalData=${finalPreCheck.personalData}`);
          
          // ========== ПОИСК КНОПКИ ОТПРАВКИ ==========
          serverLog.info(`   🔍 Поиск кнопки "Регистрация"/"Зарегистрироваться"...`);
          
          // Способ 1: Ищем по стандартным селекторам
          const submitSelectors = [
            'button[type="submit"]:visible',
            'input[type="submit"]:visible',
            'button:has-text("Зарегистрироваться"):visible',
            'button:has-text("Регистрация"):visible',
            'button:has-text("Создать аккаунт"):visible',
            '.form-submit:visible',
            '#edit-submit:visible',
            '[class*="register-btn"]:visible',
            '[class*="submit-btn"]:visible',
            'input[value="Зарегистрироваться"]:visible',
            'input[value="Регистрация"]:visible'
          ];
          
          let submitBtn = null;
          let usedSelector = '';
          
          for (const selector of submitSelectors) {
            try {
              submitBtn = await page.$(selector);
              if (submitBtn) {
                usedSelector = selector;
                serverLog.info(`   ✅ Найдена кнопка отправки: ${selector}`);
                break;
              }
            } catch (e) {
              // Продолжаем поиск
            }
          }
          
          // Способ 2: Ищем по тексту через JavaScript
          if (!submitBtn) {
            serverLog.info(`   🔍 Поиск кнопки через текст...`);
            submitBtn = await page.evaluateHandle(() => {
              const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
              for (const btn of buttons) {
                const text = (btn.textContent || btn.value || '').toLowerCase();
                if (text.includes('зарегистрироваться') || text.includes('регистрация') || text.includes('создать аккаунт')) {
                  return btn;
                }
              }
              return null;
            });
            
            if (submitBtn) {
              serverLog.info(`   ✅ Найдена кнопка через текст`);
            }
          }
          
          // Способ 3: Ищем форму и отправляем её
          if (!submitBtn) {
            serverLog.info(`   🔍 Поиск формы для отправки...`);
            const form = await page.$('form');
            if (form) {
              const formSubmit = await form.$('button[type="submit"], input[type="submit"]');
              if (formSubmit) {
                submitBtn = formSubmit;
                serverLog.info(`   ✅ Найдена кнопка внутри формы`);
              }
            }
          }
          
          // Нажимаем кнопку или отправляем форму
          if (submitBtn) {
            serverLog.info(`   🖱️ Клик по кнопке отправки...`);
            await submitBtn.click();
            serverLog.info(`   ✅ Кнопка "Регистрация" нажата`);
          } else {
            serverLog.warn(`   ⚠️ Кнопка отправки не найдена, отправляем форму напрямую...`);
            const form = await page.$('form');
            if (form) {
              await form.evaluate(f => f.submit());
              serverLog.info(`   ✅ Форма iRecommend отправлена через JavaScript`);
            } else {
              serverLog.error(`   ❌ Форма не найдена`);
            }
          }
          
          // ========== ОЖИДАНИЕ РЕЗУЛЬТАТА ==========
          serverLog.info(`   ⏳ Ожидание результата (до 20 секунд)...`);
          
          try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
              serverLog.debug(`   ℹ️ Переход по URL не обнаружен`);
            });
          } catch (navErr) {
            serverLog.debug(`   ℹ️ Навигация не обнаружена`);
          }
          
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(5000);
          
          // ========== ПРОВЕРКА НА ОШИБКИ ==========
          serverLog.info(`   🔍 Проверка на ошибки...`);
          
          const errorSelectors = [
            '.error',
            '.error-message',
            '.form-error',
            '[class*="error"]',
            '.messages--error',
            '.form-item__error',
            '.error-text',
            '[class*="alert-danger"]'
          ];
          
          let hasError = false;
          let errorText = '';
          
          for (const selector of errorSelectors) {
            const errorElement = await page.$(selector);
            if (errorElement) {
              const text = await errorElement.textContent();
              if (text && text.trim().length > 0) {
                hasError = true;
                errorText = text.trim();
                serverLog.warn(`   ⚠️ Обнаружена ошибка: ${errorText}`);
                break;
              }
            }
          }
          
          await page.screenshot({ path: 'irecommend-after-submit.png', fullPage: false });
          serverLog.info(`   📸 Скриншот после отправки: irecommend-after-submit.png`);
          
          if (!hasError) {
            serverLog.info(`   ✅ Форма iRecommend успешно отправлена`);
          } else {
            serverLog.warn(`   ⚠️ При отправке формы возникла ошибка`);
          }
          
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось отправить форму iRecommend: ${err.message}`);
          
          try {
            await page.click('button:not([type="button"]):visible, input[type="submit"]:visible');
            serverLog.info(`   ✅ Форма iRecommend отправлена (fallback)`);
            await page.waitForTimeout(5000);
          } catch (err2) {
            serverLog.error(`   ❌ Не удалось отправить форму iRecommend: ${err2.message}`);
          }
        }
      }
      else if (domain.includes('otzovik')) {
        // Otzovik: отправка формы
        try {
          serverLog.info(`   📤 Otzovik: отправка формы...`);
          await page.waitForTimeout(1000);
          
          const submitBtn = await page.$('button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Зарегистрироваться"):visible');
          if (submitBtn) {
            await submitBtn.click();
            serverLog.info(`   ✅ Форма Otzovik отправлена`);
          }
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось отправить форму Otzovik: ${err.message}`);
        }
      }
      else if (domain.includes('orgpage')) {
        // Orgpage: отправка формы с увеличенными таймаутами
        try {
          serverLog.info(`   📤 Orgpage: отправка формы...`);
          
          // Orgpage медленно обрабатывает ввод — ждём дольше
          await page.waitForTimeout(3000);
          
          // Пробуем найти кнопку отправки
          const submitBtn = await page.$('button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Зарегистрироваться"):visible, button:has-text("Продолжить"):visible');
          
          if (submitBtn) {
            await submitBtn.click();
            serverLog.info(`   ✅ Форма Orgpage отправлена`);
          } else {
            serverLog.warn(`   ⚠️ Кнопка отправки не найдена, пробуем альтернативно...`);
            // Пробуем найти форму и отправить её
            const form = await page.$('form');
            if (form) {
              await form.evaluate(f => f.submit());
              serverLog.info(`   ✅ Форма Orgpage отправлена через JavaScript`);
            } else {
              // Последняя попытка - кликаем любую кнопку
              await page.click('button:not([type="button"]):visible').catch(() => {});
              serverLog.info(`   ✅ Форма Orgpage отправлена (альтернативно)`);
            }
          }
          
          // Ждём загрузки следующей страницы (Orgpage может грузиться долго)
          serverLog.info(`   ⏳ Orgpage: ожидание загрузки страницы (до 60 секунд)...`);
          try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {
              serverLog.debug(`   ℹ️ Переход по URL не обнаружен, продолжаем на текущей странице`);
            });
          } catch (navErr) {
            serverLog.debug(`   ℹ️ Страница не перенаправлена, продолжаем работу`);
          }
          
          // Даем странице полностью загрузиться
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(3000);
          serverLog.info(`   ✅ Страница Orgpage загружена`);
          
          // Делаем скриншот для проверки
          await page.screenshot({ path: 'orgpage-submitted.png', fullPage: false });
          serverLog.info(`   📸 Скриншот после отправки: orgpage-submitted.png`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось отправить форму Orgpage: ${err.message}`);
          // Финальная попытка
          try {
            await page.click('button:not([type="button"]):visible, input[type="submit"]:visible');
            serverLog.info(`   ✅ Форма Orgpage отправлена (fallback)`);
            await page.waitForTimeout(5000);
          } catch (err2) {
            serverLog.error(`   ❌ Не удалось отправить форму Orgpage`);
          }
        }
      }
      else {
        // Универсальная отправка формы
        serverLog.debug(`   👆 Нажатие кнопки "Зарегистрироваться"...`);
        try {
          await page.waitForTimeout(500);
          await page.click('button[type="submit"]:visible, input[type="submit"]:visible');
          serverLog.info(`   ✅ Форма отправлена`);
        } catch (err) {
          serverLog.warn(`   ⚠️ Не удалось нажать кнопку: ${err.message}`);
          // Пробуем отправить форму напрямую
          try {
            const form = await page.$('form');
            if (form) {
              await form.evaluate(f => f.submit());
              serverLog.info(`   ✅ Форма отправлена через JavaScript`);
            }
          } catch (err2) {
            serverLog.debug(`   ℹ️ Не удалось отправить форму`);
          }
        }
      }

      // Шаг 7: Для Flado — распознавание CAPTCHA с картинки
      if (domain.includes('flado')) {
        serverLog.info(`🔐 Шаг 7: Распознавание CAPTCHA для Flado...`);
        serverLog.info(`   💡 Если код не распознается автоматически, введите его вручную`);
        
        try {
          // Даем странице полностью загрузиться
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(5000); // Увеличенное время загрузки
          serverLog.debug(`   ⏳ Страница загружена, ищем картинку с кодом...`);
          
          // Делаем скриншот для отладки
          await page.screenshot({ path: 'flado-captcha-check.png', fullPage: false });
          serverLog.debug(`   📸 Скриншот сохранён для проверки`);
          
          // Ищем картинку с кодом - используем более широкие селекторы
          const captchaImg = page.locator('img[src*="captcha"], img[src*="code"], img[src*="verify"], img[src*="kaptcha"], img[class*="captcha"], img[class*="captcha-img"], img[class*="verification"], img[alt*="код"], img[alt*="captcha"], img[alt*="Code"], .captcha img, .verification img').first();
          
          // Ждем появления картинки (до 30 секунд)
          await captchaImg.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
            serverLog.warn(`   ⚠️ Картинка с кодом не появилась за 30 секунд`);
          });
          
          if (await captchaImg.count() > 0) {
            serverLog.info(`   🖼️ Найдена картинка с кодом`);
            
            // Получаем URL изображения
            let imgSrc = await captchaImg.getAttribute('src');
            serverLog.debug(`   📷 URL изображения: ${imgSrc}`);
            
            // Если src относительный, делаем абсолютным
            if (imgSrc && imgSrc.startsWith('/')) {
              imgSrc = 'https://my.flado.ru' + imgSrc;
              serverLog.debug(`   📷 Абсолютный URL: ${imgSrc}`);
            }
            
            // Если base64 — используем напрямую, иначе скачиваем
            let imageData;
            if (imgSrc && imgSrc.startsWith('data:image')) {
              imageData = imgSrc;
            } else if (imgSrc) {
              // Скачиваем изображение через page.evaluate
              const imgResponse = await page.evaluate(async (url) => {
                try {
                  const response = await fetch(url);
                  const blob = await response.blob();
                  return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                  });
                } catch (e) {
                  console.error('Ошибка загрузки изображения:', e);
                  return null;
                }
              }, imgSrc);
              imageData = imgResponse;
            }
            
            if (!imageData) {
              serverLog.error(`   ❌ Не удалось получить изображение CAPTCHA`);
              serverLog.info(`   ⏳ Ждём 10 секунд и пробуем ещё раз...`);
              await page.waitForTimeout(10000);
              
              // Пробуем найти картинку ещё раз
              const captchaImgRetry = page.locator('img[src*="captcha"], img[src*="code"], img[src*="verify"], img[src*="kaptcha"], img[class*="captcha"], img[class*="captcha-img"], img[class*="verification"], img[alt*="код"], img[alt*="captcha"], img[alt*="Code"], .captcha img, .verification img').first();
              if (await captchaImgRetry.count() > 0) {
                let imgSrcRetry = await captchaImgRetry.getAttribute('src');
                serverLog.debug(`   📷 Повторная попытка, URL: ${imgSrcRetry}`);
                if (imgSrcRetry && imgSrcRetry.startsWith('/')) {
                  imgSrcRetry = 'https://my.flado.ru' + imgSrcRetry;
                }
                if (imgSrcRetry && imgSrcRetry.startsWith('data:image')) {
                  imageData = imgSrcRetry;
                } else if (imgSrcRetry) {
                  const imgResponseRetry = await page.evaluate(async (url) => {
                    try {
                      const response = await fetch(url);
                      const blob = await response.blob();
                      return new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(blob);
                      });
                    } catch (e) {
                      return null;
                    }
                  }, imgSrcRetry);
                  imageData = imgResponseRetry;
                }
              }
              
              if (!imageData) {
                serverLog.error(`   ❌ Не удалось получить изображение CAPTCHA (повторно)`);
                await page.screenshot({ path: 'captcha-error.png', fullPage: false });
                return { success: false, profileUrl: null };
              }
            }
            
            // Сохраняем оригинальное изображение для отладки
            const base64Data = imageData.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
            const fs = require('fs');
            fs.writeFileSync('captcha-original.png', base64Data, 'base64');
            serverLog.info(`   📸 CAPTCHA сохранена: captcha-original.png`);
            
            // Предобработка изображения для улучшения распознавания
            serverLog.info(`   🔧 Предобработка изображения...`);
            
            let processedImage = imageData;
            let processedImageAlt = imageData; // Альтернативная обработка
            
            try {
              const sharp = require('sharp');
              const imageBuffer = Buffer.from(base64Data, 'base64');
              
              // Сохраняем оригинал для отладки
              fs.writeFileSync('captcha-orig-buffer.png', imageBuffer);
              
              // ========== ВАРИАНТ 1: Стандартная обработка ==========
              // Увеличиваем масштаб в 4 раза для лучшего распознавания
              const resizedBuffer = await sharp(imageBuffer)
                .resize({ width: 800, height: null, fit: 'inside' })
                .toBuffer();
              
              // Конвертируем в ч/б
              const grayscaleBuffer = await sharp(resizedBuffer)
                .grayscale()
                .toBuffer();
              
              // Повышаем контраст через нормализацию
              const normalizedBuffer = await sharp(grayscaleBuffer)
                .normalize()
                .toBuffer();
              
              // Бинаризация с порогом 135 (оптимально для тёмных цифр на светлом фоне)
              const thresholdBuffer = await sharp(normalizedBuffer)
                .threshold(135)
                .toBuffer();
              
              // Резкое увеличение резкости для чёткости границ
              const sharpenedBuffer = await sharp(thresholdBuffer)
                .sharpen({ sigma: 2, m1: 3, m2: 1.5 })
                .toBuffer();
              
              const processedBase64 = 'data:image/png;base64,' + sharpenedBuffer.toString('base64');
              fs.writeFileSync('captcha-processed.png', sharpenedBuffer);
              serverLog.info(`   📸 Обработанное изображение: captcha-processed.png`);
              
              // ========== ВАРИАНТ 2: Альтернативная обработка (более агрессивная) ==========
              // Увеличиваем масштаб в 5 раз
              const resizedBuffer2 = await sharp(imageBuffer)
                .resize({ width: 1000, height: null, fit: 'inside' })
                .toBuffer();
              
              // Конвертируем в ч/б
              const grayscaleBuffer2 = await sharp(resizedBuffer2)
                .grayscale()
                .toBuffer();
              
              // Сильная нормализация контраста
              const normalizedBuffer2 = await sharp(grayscaleBuffer2)
                .normalize()
                .toBuffer();
              
              // Бинаризация с более низким порогом (для светлых цифр)
              const thresholdBuffer2 = await sharp(normalizedBuffer2)
                .threshold(128)
                .toBuffer();
              
              // Ещё более резкое изображение
              const sharpenedBuffer2 = await sharp(thresholdBuffer2)
                .sharpen({ sigma: 2.5, m1: 4, m2: 2 })
                .toBuffer();
              
              const processedBase64Alt = 'data:image/png;base64,' + sharpenedBuffer2.toString('base64');
              fs.writeFileSync('captcha-processed-alt.png', sharpenedBuffer2);
              serverLog.info(`   📸 Альтернативная обработка: captcha-processed-alt.png`);
              
              // Используем обработанное изображение для распознавания
              processedImage = processedBase64;
              processedImageAlt = processedBase64Alt;
            } catch (e) {
              serverLog.debug(`   ⚠️ Не удалось обработать изображение: ${e.message}`);
              serverLog.info(`   ℹ️ Используем оригинальное изображение`);
            }
            
            // Распознаем текст через Tesseract с оптимизированными настройками
            serverLog.info(`   🔍 Распознавание текста с картинки (Tesseract)...`);
            
            // Функция для распознавания с заданными параметрами
            async function recognizeCaptcha(imgData, psmMode, whitelist = '0123456789') {
              try {
                const { createWorker } = require('tesseract.js');
                const worker = await createWorker('eng', 1);
                
                await worker.setParameters({
                  tessedit_char_whitelist: whitelist,
                  tessedit_pageseg_mode: psmMode.toString(),
                  preserve_interword_spaces: '1',
                  tessedit_char_blacklist: '', // Чёрный список пустой
                  // Дополнительные настройки для улучшения распознавания цифр
                  tessedit_ocr_engine_mode: '1', // LSTM только
                  load_system_dawg: '0', // Не загружать системный словарь
                  load_freq_dawg: '0', // Не загружать частотный словарь
                });
                
                const { data } = await worker.recognize(imgData);
                await worker.terminate();
                
                // Возвращаем только цифры, сохраняя порядок
                const digits = data.text.replace(/[^0-9]/g, '');
                serverLog.debug(`      Распознано: "${data.text.trim()}" → Цифры: "${digits}"`);
                return digits;
              } catch (e) {
                serverLog.debug(`   ⚠️ Ошибка распознавания (PSM ${psmMode}): ${e.message}`);
                return '';
              }
            }
              
            // Функция распознавания с повышенной точностью (использует оба изображения)
            async function recognizeCaptchaEnhanced(imgData1, imgData2, psmMode) {
              const result1 = await recognizeCaptcha(imgData1, psmMode);
              const result2 = await recognizeCaptcha(imgData2, psmMode);
              
              // Возвращаем лучший результат (больше цифр)
              if (result1.length >= result2.length) return result1;
              return result2;
            }
              
            // Пробуем несколько режимов сегментации
            let captchaCode = null;
            let bestDigits = '';
            let allResults = [];
            
            // PSM 6: Assume a single uniform block of text
            serverLog.debug(`   🔍 Попытка 1 (PSM 6 - блок текста)...`);
            const digits1 = await recognizeCaptchaEnhanced(processedImage, processedImageAlt, 6);
            allResults.push({ psm: 6, result: digits1 });
            serverLog.debug(`   📝 Результат 1: "${digits1}" (${digits1.length} цифр)`);
            if (digits1.length >= 4 && digits1.length > bestDigits.length) {
              bestDigits = digits1;
            }
            
            // PSM 8: Assume a single word
            if (bestDigits.length < 4) {
              serverLog.debug(`   🔍 Попытка 2 (PSM 8 - одно слово)...`);
              const digits2 = await recognizeCaptchaEnhanced(processedImage, processedImageAlt, 8);
              allResults.push({ psm: 8, result: digits2 });
              serverLog.debug(`   📝 Результат 2: "${digits2}" (${digits2.length} цифр)`);
              if (digits2.length > bestDigits.length) {
                bestDigits = digits2;
              }
            }
            
            // PSM 7: Assume a single text line
            if (bestDigits.length < 4) {
              serverLog.debug(`   🔍 Попытка 3 (PSM 7 - одна строка)...`);
              const digits3 = await recognizeCaptchaEnhanced(processedImage, processedImageAlt, 7);
              allResults.push({ psm: 7, result: digits3 });
              serverLog.debug(`   📝 Результат 3: "${digits3}" (${digits3.length} цифр)`);
              if (digits3.length > bestDigits.length) {
                bestDigits = digits3;
              }
            }
            
            // PSM 10: Assume a single character
            if (bestDigits.length < 4) {
              serverLog.debug(`   🔍 Попытка 4 (PSM 10 - один символ)...`);
              const digits4 = await recognizeCaptchaEnhanced(processedImage, processedImageAlt, 10);
              allResults.push({ psm: 10, result: digits4 });
              serverLog.debug(`   📝 Результат 4: "${digits4}" (${digits4.length} цифр)`);
              if (digits4.length > bestDigits.length) {
                bestDigits = digits4;
              }
            }
            
            // PSM 13: Assume a single line of text
            if (bestDigits.length < 4) {
              serverLog.debug(`   🔍 Попытка 5 (PSM 13 - одна строка)...`);
              const digits5 = await recognizeCaptchaEnhanced(processedImage, processedImageAlt, 13);
              allResults.push({ psm: 13, result: digits5 });
              serverLog.debug(`   📝 Результат 5: "${digits5}" (${digits5.length} цифр)`);
              if (digits5.length > bestDigits.length) {
                bestDigits = digits5;
              }
            }
            
            // PSM 3: Fully automatic page segmentation with OSD
            if (bestDigits.length < 4) {
              serverLog.debug(`   🔍 Попытка 6 (PSM 3 - авто)...`);
              const digits6 = await recognizeCaptchaEnhanced(processedImage, processedImageAlt, 3);
              allResults.push({ psm: 3, result: digits6 });
              serverLog.debug(`   📝 Результат 6: "${digits6}" (${digits6.length} цифр)`);
              if (digits6.length > bestDigits.length) {
                bestDigits = digits6;
              }
            }
            
            // Пробуем распознать оригинальное изображение (без обработки)
            if (bestDigits.length < 4) {
              serverLog.debug(`   🔍 Попытка 7 (оригинальное изображение, PSM 6)...`);
              const digits7 = await recognizeCaptcha(imageData, 6);
              allResults.push({ psm: 6, result: digits7, processed: false });
              serverLog.debug(`   📝 Результат 7: "${digits7}" (${digits7.length} цифр)`);
              if (digits7.length > bestDigits.length) {
                bestDigits = digits7;
              }
            }

            // Пробуем распознать оригинальное изображение с PSM 8
            if (bestDigits.length < 4) {
              serverLog.debug(`   🔍 Попытка 8 (оригинальное изображение, PSM 8)...`);
              const digits8 = await recognizeCaptcha(imageData, 8);
              allResults.push({ psm: 8, result: digits8, processed: false });
              serverLog.debug(`   📝 Результат 8: "${digits8}" (${digits8.length} цифр)`);
              if (digits8.length > bestDigits.length) {
                bestDigits = digits8;
              }
            }
            
            // Логируем все результаты
            serverLog.info(`   📊 Все попытки: ${JSON.stringify(allResults)}`);
            serverLog.info(`   📊 Лучший результат: "${bestDigits}" (${bestDigits.length} цифр)`);
            
            // Сохраняем все результаты в файл для отладки
            fs.writeFileSync('captcha-results.json', JSON.stringify(allResults, null, 2));
            serverLog.debug(`   📄 Результаты сохранены: captcha-results.json`);
            
            // Функция постобработки результата
            function postProcessDigits(digits) {
              if (!digits) return '';
              
              let result = digits;
              
              // Замена похожих символов на цифры
              result = result.replace(/[OoО]/g, '0'); // O → 0
              result = result.replace(/[IiIl|]/g, '1'); // I, l, | → 1
              result = result.replace(/[Zz]/g, '2'); // Z → 2
              result = result.replace(/[Ss]/g, '5'); // S → 5
              result = result.replace(/[Bb]/g, '8'); // B → 8
              result = result.replace(/[Gg]/g, '6'); // G → 6
              result = result.replace(/[Qq]/g, '9'); // Q → 9
              
              // Удаляем всё кроме цифр
              result = result.replace(/[^0-9]/g, '');
              
              return result;
            }
            
            // Обрабатываем лучший результат
            bestDigits = postProcessDigits(bestDigits);
            
            // Если есть несколько результатов с одинаковой длиной, пробуем их объединить
            if (bestDigits.length < 4) {
              // Собираем все цифры из всех попыток
              const allDigits = allResults.map(r => postProcessDigits(r.result)).filter(r => r.length > 0);
              if (allDigits.length > 0) {
                // Находим наиболее часто встречающиеся цифры на каждой позиции
                const positionCounts = {};
                for (const digits of allDigits) {
                  for (let i = 0; i < Math.min(digits.length, 4); i++) {
                    const char = digits[i];
                    if (!positionCounts[i]) positionCounts[i] = {};
                    positionCounts[i][char] = (positionCounts[i][char] || 0) + 1;
                  }
                }
                
                // Собираем результат из наиболее частых цифр
                let voted = '';
                for (let i = 0; i < 4; i++) {
                  if (positionCounts[i]) {
                    const maxChar = Object.entries(positionCounts[i])
                      .sort((a, b) => b[1] - a[1])[0][0];
                    voted += maxChar;
                  }
                }
                
                if (voted.length >= bestDigits.length) {
                  serverLog.debug(`   🗳️ Голосование: "${voted}"`);
                  bestDigits = voted;
                }
              }
            }
            
            // Обрабатываем результат
            if (bestDigits.length === 4) {
              captchaCode = bestDigits;
              serverLog.info(`   ✅ Код CAPTCHA распознан: ${captchaCode}`);
            } else if (bestDigits.length > 4) {
              // Берём первые 4 цифры
              captchaCode = bestDigits.substring(0, 4);
              serverLog.info(`   ⚠️ Найдено ${bestDigits.length} цифр, используем первые 4: ${captchaCode}`);
            } else if (bestDigits.length > 0 && bestDigits.length < 4) {
              // Дополняем нулями до 4
              captchaCode = bestDigits.padEnd(4, '0');
              serverLog.warn(`   ⚠️ Найдено только ${bestDigits.length} цифр: "${bestDigits}", дополнено до: ${captchaCode}`);
            } else {
              serverLog.error(`   ❌ Не удалось распознать код CAPTCHA`);
              serverLog.info(`   💡 Проверьте captcha-original.png и captcha-processed.png`);
              // Используем заглушку - попробуем 0000
              captchaCode = '0000';
              serverLog.warn(`   ⚠️ Используем код по умолчанию: ${captchaCode}`);
            }
            
            // Если код найден, заполняем поле
            if (captchaCode) {
              serverLog.info(`   ✅ Финальный код CAPTCHA: ${captchaCode}`);
              
              // Заполняем поле кода - ищем по разным селекторам
              serverLog.info(`   🔑 Заполнение поля "Введите код *"...`);
              
              // Пробуем найти поле ввода рядом с картинкой
              let codeInput = null;
              
              // Сначала ищем по label "Введите код *"
              const codeLabel = await page.$('label:has-text("Введите код"), label:has-text("код подтверждения"), label:has-text("Код")');
              if (codeLabel) {
                codeInput = await codeLabel.$('input[type="text"], input[name="code"], input[name="captcha"], input[name="verification_code"]');
              }
              
              // Если не нашли, ищем по placeholder
              if (!codeInput) {
                codeInput = await page.$('input[placeholder*="Введите код"], input[placeholder*="код"], input[placeholder*="Code"]');
              }
              
              // Если не нашли, ищем input рядом с картинкой
              if (!codeInput) {
                const captchaContainer = await captchaImg.evaluateHandle(el => el.parentElement);
                if (captchaContainer) {
                  codeInput = await captchaContainer.$('input[type="text"][maxlength="4"], input[type="text"][maxlength="5"], input[type="text"][maxlength="6"]');
                }
              }
              
              // Fallback: ищем любой input с maxlength 4-6
              if (!codeInput) {
                codeInput = await page.$('input[type="text"][maxlength="4"], input[type="text"][maxlength="5"], input[type="text"][maxlength="6"], input[name="code"], input[name="captcha"], input[name="confirm_code"], input[name="verification_code"]');
              }
              
              if (codeInput) {
                await codeInput.click();
                await codeInput.fill('');
                await page.waitForTimeout(300);
                await codeInput.fill(captchaCode);
                serverLog.info(`   ✅ Код "${captchaCode}" заполнен в поле`);
                
                // Сохраняем скриншот с заполненным полем
                await page.screenshot({ path: 'flado-code-filled.png', fullPage: false });
                
                // Нажимаем кнопку подтверждения
                await new Promise(resolve => setTimeout(resolve, 1500));
                
                // Ищем кнопку подтверждения
                let confirmBtn = await page.$('button:has-text("Подтвердить"):visible, button:has-text("Отправить"):visible, button:has-text("Далее"):visible, button:has-text("Продолжить"):visible');
                
                if (!confirmBtn) {
                  // Ищем кнопку рядом с полем ввода
                  const inputContainer = await codeInput.evaluateHandle(el => el.parentElement);
                  if (inputContainer) {
                    confirmBtn = await inputContainer.$('button[type="submit"], button[type="button"], input[type="submit"]');
                  }
                }
                
                if (!confirmBtn) {
                  // Fallback: любая кнопка
                  confirmBtn = await page.$('button[type="submit"]:visible, input[type="submit"]:visible, [class*="submit"]:visible, [class*="confirm"]:visible');
                }
                
                if (confirmBtn) {
                  await confirmBtn.click();
                  serverLog.info(`   ✅ Нажата кнопка подтверждения`);
                  
                  // Ждём загрузки следующей страницы (до 60 секунд)
                  serverLog.info(`   ⏳ Ожидание завершения регистрации...`);
                  try {
                    await page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => {
                      serverLog.debug(`   ℹ️ Переход не обнаружен, проверяем текущую страницу`);
                    });
                  } catch (navErr) {
                    serverLog.debug(`   ℹ️ Навигация не обнаружена`);
                  }
                  
                  await page.waitForTimeout(5000); // Даём время на загрузку
                  
                  // Сохраняем финальный скриншот
                  await page.screenshot({ path: 'flado-final.png', fullPage: false });
                  serverLog.info(`   📸 Финальный скриншот: flado-final.png`);
                } else {
                  serverLog.warn(`   ⚠️ Кнопка подтверждения не найдена`);
                  serverLog.info(`   💡 Нажмите кнопку подтверждения вручную (у вас 2 минуты)`);
                  await page.waitForFunction(() => false, { timeout: 120000 }).catch(() => {});
                }
              } else {
                serverLog.warn(`   ⚠️ Поле для ввода кода не найдено`);
                serverLog.info(`   💡 Введите код CAPTCHA вручную (у вас 2 минуты)`);
                serverLog.info(`   💡 Код для ввода: ${captchaCode}`);
                await page.screenshot({ path: 'flado-no-input.png', fullPage: false });
                // Ждём 2 минуты для ручного ввода
                await page.waitForFunction(() => false, { timeout: 120000 }).catch(() => {});
              }
            } else {
              serverLog.warn(`   ⚠️ Не удалось распознать код CAPTCHA (распознано: "${text}")`);
              // Сохраняем скриншот для отладки
              await page.screenshot({ path: 'captcha-debug.png', fullPage: false });
              serverLog.warn(`   📸 Скриншот сохранён: captcha-debug.png`);
              serverLog.info(`   💡 Введите код CAPTCHA вручную (у вас 2 минуты)`);
              serverLog.info(`   💡 Посмотрите на captcha-original.png и введите код вручную`);
              await page.waitForFunction(() => false, { timeout: 120000 }).catch(() => {});
            }
          } else {
            serverLog.warn(`   ⚠️ Картинка с кодом не найдена на странице`);
            serverLog.info(`   💡 Возможно регистрация уже завершена или ошибка`);
            // Сохраняем скриншот для отладки
            await page.screenshot({ path: 'flado-debug.png', fullPage: false });
            serverLog.warn(`   📸 Скриншот сохранён: flado-debug.png`);
            // Ждём для проверки вручную
            await page.waitForFunction(() => false, { timeout: 120000 }).catch(() => {});
          }
        } catch (err) {
          serverLog.error(`   ❌ Ошибка распознавания CAPTCHA: ${err.message}`);
          serverLog.info(`   💡 Введите код CAPTCHA вручную (у вас 2 минуты)`);
          await page.screenshot({ path: 'captcha-error.png', fullPage: false });
          await page.waitForFunction(() => false, { timeout: 120000 }).catch(() => {});
        }
      }
      // Cataloxy не требует кода подтверждения
      else if (!domain.includes('cataloxy')) {
        serverLog.info(`📧 Шаг 7: Получение кода подтверждения на ${email}...`);
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
    
    // Получаем информацию о каталогах (включая is_test)
    const allDirs = await this.db.getAllDirectories();
    const directoriesArray = Array.isArray(directories) ? directories : [directories];

    // Подсчитываем тестовые каталоги среди выбранных
    const testCount = directoriesArray.filter(url => {
      const dir = allDirs.find(d => d.url === url);
      return dir && dir.is_test;
    }).length;
    const regularCount = directoriesArray.length - testCount;
    
    serverLog.info(`═══════════════════════════════════════════════════`);
    serverLog.info(`🏁 ЗАПУСК РЕГИСТРАЦИИ`);
    serverLog.info(`   Сайт: ${website}`);
    serverLog.info(`   Email: ${email}`);
    serverLog.info(`   Каталогов: ${directoriesArray.length} (обычных: ${regularCount}, тестовых: ${testCount})`);
    serverLog.info(`   IMAP: ${imapHost}:${port}`);
    serverLog.info(`═══════════════════════════════════════════════════`);

    if (!(await this.initialize())) {
      throw new Error('Не удалось инициализировать Playwright');
    }

    if (!directories || directories.length === 0) {
      throw new Error('Необходимо выбрать хотя бы одну директорию');
    }

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
      serverLog.info(`   📊 Обычных каталогов: ${regularCount}`);
      serverLog.info(`   🧪 Тестовых каталогов: ${testCount}`);
      serverLog.info(`   ⏱️  Время: ${duration} сек`);
      serverLog.info(`═══════════════════════════════════════════════════`);

      return { success: true, results, stats: { total: directoriesArray.length, success: successCount, error: errorCount, duration, testCount, regularCount } };
    } catch (error) {
      serverLog.error(`💥 КРИТИЧЕСКАЯ ОШИБКА РЕГИСТРАЦИИ: ${error.message}`);
      throw error;
    } finally {
      await this.cleanup();
    }
  }
}

module.exports = RegistrationAgent;
