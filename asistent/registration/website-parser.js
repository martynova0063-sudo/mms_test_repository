const { serverLog } = require('../logger');

/**
 * Исправление падежей городов
 */
function fixCityCase(city) {
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
}

/**
 * Парсинг данных компании с сайта
 */
async function parseWebsiteData(browserInit, websiteUrl) {
  serverLog.info(`🌐 Парсинг сайта: ${websiteUrl}`);
  serverLog.debug(`   Переход на страницу...`);

  const page = browserInit.getPage();

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
    // --- Функция исправления падежей городов (доступна в контексте браузера) ---
    function fixCityCase(city) {
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
    }
    // -------------------------------------------------------------------------

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

module.exports = {
  fixCityCase,
  parseWebsiteData,
};
