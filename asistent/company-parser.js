const { chromium } = require('playwright');
const he = require('he');

// ============================================================
// Универсальный парсер информации о компании с сайтов
// ============================================================

class CompanyParser {
  constructor() {
    this.found = {
      name: null,
      address: null,
      phone: null,
      description: null,
      industry: null,
      inn: null,
      logo: null,
      city: null,
    };
    this.baseUrl = null;
  }

  /**
   * Проверка: значение валидно (не null, не undefined, не пустая строка)
   */
  _isValid(value) {
    return value !== null && value !== undefined && value !== '' && String(value).trim().length > 0;
  }

  /**
   * Извлекает JSON-LD структурированные данные со страницы
   */
  extractJsonLd(page) {
    return page.evaluate(async () => {
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      const results = [];
      jsonLdScripts.forEach(s => {
        try {
          results.push(JSON.parse(s.textContent));
        } catch (e) {
          // skip invalid JSON
        }
      });
      return results;
    }).then(scripts => {
      for (const data of scripts) {
        this._parseStructuredData(data);
      }
    }).catch(e => {
      console.log('⚠ JSON-LD parsing error:', e.message);
    });
  }

  /**
   * Рекурсивно обходит структурированные данные
   */
  _parseStructuredData(data) {
    if (!data) return;

    // Если это массив, рекурсивно обрабатываем каждый элемент
    if (Array.isArray(data)) {
      data.forEach(item => this._parseStructuredData(item));
      return;
    }

    if (typeof data !== 'object') return;

    // Определяем тип организации
    const types = [
      '@type',
      'type',
    ];

    const typeValue = types.find(t => data[t])?.toLowerCase() || '';

    // Извлекаем поля компании
    const fields = {
      name: ['name', '@name'],
      legalName: ['legalName'],
      description: ['description', 'shortDescription', 'alternateName'],
      telephone: ['telephone', 'phone', '@telephone'],
      email: ['email'],
      url: ['url'],
      logo: ['logo', 'image'],
      address: ['address', 'streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'],
      geo: ['geo', 'latitude', 'longitude'],
      identifier: ['identifier', 'taxID', 'vatID'],
    };
    
    // Извлекаем название компании
    if (!this._isValid(this.found.name)) {
      for (const key of fields.name) {
        if (data[key] && typeof data[key] === 'string') {
          this.found.name = this._cleanText(data[key]);
          break;
        }
        if (data[key] && typeof data[key] === 'object') {
          this.found.name = this._cleanText(data[key].toString());
          break;
        }
      }
    }

    // Извлекаем описание
    if (!this._isValid(this.found.description)) {
      for (const key of fields.description) {
        if (data[key] && typeof data[key] === 'string') {
          this.found.description = this._cleanText(data[key]);
          break;
        }
      }
    }

    // Извлекаем телефон
    if (!this._isValid(this.found.phone)) {
      for (const key of fields.telephone) {
        if (data[key] && typeof data[key] === 'string') {
          this.found.phone = this._extractPhone(data[key]);
          break;
        }
      }
    }

    // Извлекаем логотип
    if (!this._isValid(this.found.logo)) {
      for (const key of fields.logo) {
        if (data[key] && typeof data[key] === 'string') {
          this.found.logo = this._resolveUrl(data[key], this.baseUrl);
          break;
        }
        if (data[key] && typeof data[key] === 'object' && data[key].url) {
          this.found.logo = this._resolveUrl(data[key].url, this.baseUrl);
          break;
        }
      }
    }

    // Извлекаем INN
    if (!this._isValid(this.found.inn) && data.identifier) {
      const identifiers = Array.isArray(data.identifier) ? data.identifier : [data.identifier];
      for (const id of identifiers) {
        if (id.value && id.value.toString().length >= 10 && /^\d+$/.test(id.value)) {
          this.found.inn = id.value.toString();
          break;
        }
        if (id.taxID && /^\d{10,12}$/.test(id.taxID)) {
          this.found.inn = id.taxID;
          break;
        }
      }
    }

    // Извлекаем адрес
    if (!this._isValid(this.found.address)) {
      if (data.address && typeof data.address === 'object') {
        const addrParts = [];
        const addrFields = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'];
        for (const f of addrFields) {
          if (data.address[f]) addrParts.push(data.address[f]);
        }
        if (addrParts.length) this.found.address = addrParts.join(', ');
      } else if (data.address && typeof data.address === 'string') {
        this.found.address = this._cleanText(data.address);
      }
    }

    // Извлекаем город
    if (!this._isValid(this.found.city)) {
      if (data.address && typeof data.address === 'object') {
        const city = data.address.addressLocality || data.address.addressRegion;
        if (city) this.found.city = this._cleanText(city);
      }
    }

    // Рекурсивно обходим вложенные объекты
    for (const key of Object.keys(data)) {
      if (typeof data[key] === 'object' && data[key] !== null && !Array.isArray(data[key])) {
        this._parseStructuredData(data[key]);
      }
    }
  }

  /**
   * Извлекает данные из Open Graph тегов
   */
  extractOpenGraph(page) {
    return page.evaluate(() => {
      const metas = document.querySelectorAll('meta[property], meta[name]');
      const result = {};
      metas.forEach(meta => {
        const prop = meta.getAttribute('property') || meta.getAttribute('name');
        const content = meta.getAttribute('content');
        if (prop && content) {
          result[prop] = content;
        }
      });
      return result;
    }).then(ogData => {
      // Название
      if (!this._isValid(this.found.name)) {
        const rawName = ogData['og:site_name'] || ogData['og:title'] || null;
        if (rawName) this.found.name = this._cleanTitle(rawName);
      }

      // Описание
      if (!this._isValid(this.found.description)) {
        this.found.description = ogData['og:description'] || null;
      }

      // Логотип
      if (!this._isValid(this.found.logo)) {
        const logo = ogData['og:image'] || ogData['og:logo'] || null;
        if (logo) this.found.logo = this._resolveUrl(logo, this.baseUrl);
      }
    }).catch(e => {
      console.log('⚠ Open Graph parsing error:', e.message);
    });
  }

  /**
   * Извлекает данные из HTML-разметки (SEO-теги, контакты)
   */
  extractFromHtml(page) {
    return page.evaluate(() => {
      const result = {
        title: document.title || '',
        description: null,
        phones: [],
        emails: [],
        addresses: [],
        inn: null,
        logo: null,
        headings: [],
      };

      // Title
      if (document.title) {
        result.title = document.title;
      }

      // Meta description
      const descMeta = document.querySelector('meta[name="description"]');
      if (descMeta) result.description = descMeta.getAttribute('content');

      // Meta keywords
      const keywordsMeta = document.querySelector('meta[name="keywords"]');
      if (keywordsMeta) result.keywords = keywordsMeta.getAttribute('content');

      // Logo
      const logoImg = document.querySelector('link[rel="apple-touch-icon"], link[rel="icon"], link[rel="shortcut icon"]');
      if (logoImg) result.logo = logoImg.getAttribute('href');
      if (!result.logo) {
        const ogLogo = document.querySelector('meta[property="og:image"]');
        if (ogLogo) result.logo = ogLogo.getAttribute('content');
      }

      // Извлекаем все телефоны из href="tel:..."
      document.querySelectorAll('a[href^="tel:"]').forEach(a => {
        const val = a.getAttribute('href').replace('tel:', '').trim();
        if (val) result.phones.push(val);
      });

      // Извлекаем все ссылки на WhatsApp и Telegram
      document.querySelectorAll('a[href*="wa.me"], a[href*="t.me"], a[href*="telegram"]').forEach(a => {
        const href = a.getAttribute('href');
        // WhatsApp: +79819556066
        const waMatch = href.match(/(\+7|8)\d{9}/);
        if (waMatch) result.phones.push(waMatch[0]);
        // Telegram: often username, not phone
      });

      // Извлекаем все email
      document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        const val = a.getAttribute('href').replace('mailto:', '').trim();
        if (val) result.emails.push(val);
      });

      // Извлекаем ИНН из meta-тегов
      const innMeta = document.querySelector('meta[name="inn"], meta[property="inn"]');
      if (innMeta) {
        const val = innMeta.getAttribute('content');
        if (val && /^\d{10,12}$/.test(val)) result.inn = val;
      }

      // Извлекаем ИНН из текстового содержимого страницы
      const bodyText = document.body ? document.body.textContent : '';
      const innMatch = bodyText.match(/ИНН\s*[:\-]?\s*(\d{10,12})/i);
      if (innMatch && !result.inn) result.inn = innMatch[1];

        // Извлекаем все телефоны из текста страницы
        const phoneRegex = /(\+7|8)\s*[\(]?\d{3}[\)]?\s*[-]?\d{3}[-]?\d{2}[-]?\d{2}/g;
        const textPhones = bodyText.match(phoneRegex) || [];
        textPhones.forEach(p => {
          // Нормализуем 8 в +7
          const normalized = p.replace(/^8\s*/, '+7').replace(/\s/g, '');
          if (!result.phones.includes(normalized)) {
            result.phones.push(normalized);
          }
        });

        // Дедупликация: убираем дубликаты (разные форматы одного номера)
        const seenPhones = new Set();
        result.phones = result.phones.filter(phone => {
          const clean = phone.replace(/\D/g, '');
          if (seenPhones.has(clean)) return false;
          seenPhones.add(clean);
          return true;
        });

        // Извлекаем адреса (паттерны)
        const addressPatterns = [
          /г\.?\s*[^,\n]{2,50}\s*(ул\.|улица|пр\.|проспект|пр-т|площад\.|пл\.|пер\.|переулок|д\.|дом)[\s,.\n\d]/gi,
          /улица\s+[^,\n]{2,50}/gi,
          /проспект\s+[^,\n]{2,50}/gi,
          /ул\.\s+[^,\n]{2,50}/gi,
          /пр(?:-т)?\.?\s+[^,\n]{2,50}/gi,
          /[^,\n]{2,50}\s*(ул\.|улица|пр\.|проспект|пр-т|площад\.|пл\.|пер\.|переулок|д\.|дом)\s*\d+/gi,
        ];

        for (const pattern of addressPatterns) {
          const matches = bodyText.match(pattern);
          if (matches) {
            result.addresses.push(...matches.map(a => a.trim()));
          }
        }

        // Отдельно ищем города
        const cityPatterns = [
          /(?:в\s+)?(?:г\.?|город)\s+([А-ЯЁА-Я]{2,50})(?=\s|$|,)/gi,
          // Просто города без "г."
          /(?:в|из|по|на)\s+([А-ЯЁА-Я]{3,50})(?=\s|$|,)/gi,
        ];
        const commonWords = ['ремонт', 'строительство', 'квартир', 'домов', 'услуг', 'работ', 'услуги', 
                             'удобное', 'удобный', 'удобно', 'выбор', 'выбрать', 'заказ', 'заказать',
                             'проект', 'проекты', 'цена', 'стоимость', 'расчет', 'получите', 'получить'];
        const foundCities = [];
        for (const pattern of cityPatterns) {
          let m;
          while ((m = pattern.exec(bodyText)) !== null) {
            if (m[1] && m[1].length > 2 && m[1].length < 50) {
              if (!commonWords.includes(m[1].toLowerCase())) {
                const cityEntry = 'г. ' + m[1];
                if (!foundCities.includes(cityEntry)) {
                  foundCities.push(cityEntry);
                }
              }
            }
          }
        }

        // Добавляем города отдельно
        result.addresses.push(...foundCities);

        // Отдельно сохраняем найденные города для поля city
        result.cities = foundCities;

        // Если не нашли адрес по паттернам, ищем типичные фразы "адрес:", "адрес:", "город:" и т.д.
        if (result.addresses.length === 0) {
          const contactPatterns = [
            /(?:адрес[а]?\s*[=:]\s*)([^<\n]+)/gi,
            /(?:город\s*[=:]\s*)([^<\n]+)/gi,
            /(?:местонахождени[ея]\s*[=:]\s*)([^<\n]+)/gi,
          ];
          for (const pattern of contactPatterns) {
            const matches = bodyText.match(pattern);
            if (matches) {
              for (const m of matches) {
                const clean = m.replace(/(?:адрес[а]?\s*[=:]\s*|город\s*[=:]\s*|местонахождени[ея]\s*[=:]\s*)/gi, '').trim();
                if (clean && clean.length > 3) {
                  result.addresses.push(clean);
                }
              }
            }
          }
        }

      // Извлекаем заголовки для определения сферы деятельности
      document.querySelectorAll('h1, h2, h3').forEach(h => {
        const text = h.textContent.trim();
        if (text) result.headings.push(text.substring(0, 200));
      });

      return result;
    }).then(htmlData => {
      // Отладка: показываем что найдено в HTML
      // Дедупликация телефонов
      const uniquePhones = [...new Set(htmlData.phones)];
      console.log(`  📋 HTML нашёл: телефонов=${uniquePhones.length} [${uniquePhones.join(', ')}], адресов=${htmlData.addresses.length}`);
      
      // Применяем извлечённые данные
      if (!this._isValid(this.found.name) && htmlData.title) {
        // Убираем типичные суффиксы из title
        this.found.name = this._cleanTitle(htmlData.title);
      }

      if (!this._isValid(this.found.description) && htmlData.description) {
        this.found.description = this._cleanText(htmlData.description);
      }

      // Телефон: если нет из JSON-LD/OG, берём из HTML
      if (!this._isValid(this.found.phone) && htmlData.phones && htmlData.phones.length > 0) {
        this.found.phone = htmlData.phones[0];
      }

      // Если телефон не найден нигде, но есть телефоны в HTML — всё равно берём
      if (!this._isValid(this.found.phone) && htmlData.phones && htmlData.phones.length > 0) {
        this.found.phone = htmlData.phones[0];
      }

      if (!this._isValid(this.found.inn) && htmlData.inn) {
        this.found.inn = htmlData.inn;
      }

      if (!this._isValid(this.found.logo) && htmlData.logo) {
        this.found.logo = this._resolveUrl(htmlData.logo, this.baseUrl);
      }

      // Адрес: если нет из JSON-LD/OG, берём из HTML
      if (!this._isValid(this.found.address) && htmlData.addresses && htmlData.addresses.length > 0) {
        // Приоритет: адрес с улицей/номером дома > просто город
        let bestAddr = null;
        for (const addr of htmlData.addresses) {
          // Если адрес содержит улицу, дом или конкретный адрес — берём его
          if (/ул\.|улица|пр\.|проспект|д\.?\s*\d+|дом/i.test(addr)) {
            bestAddr = addr;
            break;
          }
        }
        // Если нет конкретного адреса — берём первый город
        if (!bestAddr) {
          bestAddr = htmlData.addresses[0];
        }
        
        let addr = this._cleanText(bestAddr);
        // Исправляем падежи городов
        addr = addr.replace(/г\.\s*([А-ЯЁа-яё]+)/g, (_, city) => 'г. ' + this._fixCityCase(city));
        this.found.address = addr;
      }

      // Город: если нет из JSON-LD, берём из HTML
      if (!this._isValid(this.found.city) && htmlData.cities && htmlData.cities.length > 0) {
        this.found.city = this._fixCityCase(htmlData.cities[0].replace('г. ', ''));
      }

      // Определяем сферу деятельности по заголовкам и ключевым словам
      if (!this._isValid(this.found.industry)) {
        this.found.industry = this._detectIndustry(htmlData);
      }
    }).catch(e => {
      console.log('⚠ HTML parsing error:', e.message);
    });
  }

  /**
   * Определяет сферу деятельности по контенту страницы
   */
  _detectIndustry(htmlData) {
    const text = (htmlData.title + ' ' + (htmlData.description || '') + ' ' + htmlData.headings.join(' ') + ' ' + (htmlData.keywords || '')).toLowerCase();
    
    // Считаем баллы для каждой категории
    const scores = {};

    const industries = {
      '🏗 Строительство и ремонт': [
        'ремонт квартир', 'строительство', 'строительн', 'отделк', 'дизайн интерьер',
        'ремонт под ключ', 'строительные услуги', 'бригад', 'штукатурк', 'стяжк',
        'плитк', 'сантехник', 'электрик', 'крыш', 'фасад', 'бетон', 'мур',
        'забор', 'построек', 'домов', 'баня', 'саун', 'окна', 'пластик',
        'вентиляци', 'кондиционер', 'сварк', 'монтаж', 'ремонт дома',
      ],
      '🚗 Автомобильные услуги': [
        'автосервис', 'автомойк', 'детейлинг', 'ремонт авто', 'шиномонтаж',
        'автомобиль', 'тонировк', 'оклейк', 'полировк', 'кузовной',
        'запчаст', 'автозапчаст', 'автомагазин', 'roadside', 'эвакуатор',
        'автоэлектрик', 'подвеск', 'рулевой', 'тормоз', 'двигатель',
        'автомобильных', 'toyota', 'kia', 'hyundai', 'lada', 'vaz',
        'kia', 'ford', 'chevrolet', 'bmw', 'mercedes', 'audi',
      ],
      '💻 IT и разработка': [
        'разработка', 'программир', 'it-услуги', 'веб-сайт', 'сайт',
        'интернет', 'digital', 'технологии', 'программное обеспечение',
        'frontend', 'backend', 'devops', 'mobile app', 'приложени',
        'crm', 'cms', 'bitrix', 'wordpress', 'api', 'сервер',
        'системный администратор', 'айти', 'айтишн', 'информационн',
      ],
      '🎓 Образование': [
        'обучение', 'курсы', 'университет', 'школ', 'образован',
        'репетитор', 'педагогик', 'academy', 'school', 'тренинг',
        'обучающий', 'преподаван', 'студент', 'лекци', 'семинар',
        'диссертаци', 'магистр', 'бакалавр', 'аспирант', 'колледж',
        'детский сад', 'дошкольн', 'языков', 'английск', 'китайск',
      ],
      '🏥 Здоровье и медицина': [
        'медицинск', 'клиник', 'больниц', 'врач', 'здоровье',
        'стоматолог', 'лекарств', 'аптек', 'медицинские услуги',
        'диагностик', 'лечени', 'хирург', 'терапевт', 'кардиолог',
        'педиатр', 'невролог', 'офтальм', 'дерматолог', 'косметолог',
        'фармацевт', 'медикамент', 'реабилитаци', 'медцентр',
      ],
      '🍽 Ресторанный бизнес': [
        'ресторан', 'кафе', 'бар', 'доставка еды', 'кухня',
        'фастфуд', 'пицц', 'буфет', 'кейтеринг', 'кофейн',
        'суши', 'бургер', 'гриль', 'шашлык', 'стейк',
        'банкет', 'торжеств', 'свадьб', 'меню', 'шеф-повар',
        'десерт', 'кондитерск', 'хлеб', 'выпечк', 'заведени',
      ],
      '🛒 Торговля и ритейл': [
        'магазин', 'торговл', 'интернет-магазин', 'маркетплейс',
        'продукты', 'одежд', 'мебель', 'товары', 'розниц',
        'опт', 'дистрибуци', 'супермаркет', 'гипермаркет', 'лента',
        'магнит', 'пятёрочка', 'перекрёсток', 'wildberries', 'ozon',
        'маркетплейс', 'каталог', 'ассортимент', 'продаж',
      ],
      '💅 Красота и здоровье': [
        'салон красоты', 'парикмахерск', 'маникюр', 'брови',
        'визаж', 'косметолог', 'спа', 'massage', 'массаж',
        ' Nail-студия', 'ламинирование', 'ресниц', 'губы', 'эпиляци',
        'воск', 'шугаринг', 'окрашивани', 'укреплени', 'уход',
        'бьюти', 'стилист', 'имидж', 'модельн',
      ],
      '🧹 Услуги и сервис': [
        'клининг', 'уборк', 'переезд', 'перевозк', 'курьер',
        'такси', 'аренд', 'прокат', 'услуги', 'консьерж',
        'ремонт техники', 'ремонт телефона', 'ремонт ноутбука',
        'реставраци', 'химчистк', 'прачечн', 'сушка',
        'фото', 'видео', 'съёмк', 'фотосессия', 'фотограф',
        'юридическ', 'консультаци', 'бухгалтерск', 'аудит',
        'перевод', 'логистик', 'склад', 'грузчик',
      ],
      '🏠 Недвижимость': [
        'недвижимост', 'квартир', 'домов', 'застройщик', 'агентство',
        'ипотека', 'сделк', 'риелтор', 'жил', 'жильё',
        'коммерчески', 'офис', 'помещени', 'участок', 'земельн',
        'застройк', 'новостройк', 'вторичн', 'коттедж',
        'таунхаус', 'апартаменты', 'парковк', 'гараж',
      ],
      '📸 Фото и видео': [
        'фотограф', 'видеосъёмк', 'фотостудия', 'видеостудия',
        'фотосессия', 'свадьб', 'портрет', 'репортаж',
        'ретушь', 'обработка', 'монтаж', 'анимаци',
        '3d', 'визуализаци', 'рендер', 'мультимедиа',
      ],
      '🎨 Дизайн и творчество': [
        'дизайн', 'логотип', 'брендинг', 'фирменный стиль',
        'полиграфия', 'визитк', 'баннер', 'печать',
        'иллюстраци', 'график', 'арт', 'мастер-класс',
        'творчество', 'мастерская', 'рукоделие', 'handmade',
        'живопись', 'рисунок', 'скульптур', 'декор',
      ],
      '🚚 Логистика и транспорт': [
        'логистик', 'грузоперевозк', 'транспорт', 'автопарк',
        'такси', 'трансфер', 'перевозка', 'доставк',
        'экспресс', 'почт', 'посылк', 'сборный груз',
        'фура', 'газель', 'рефрижератор', 'термосклад',
        'междугород', 'международн', 'таможн',
      ],
      '💰 Финансы и банки': [
        'банк', 'кредит', 'ипотека', 'инвестици', 'страховани',
        'финансов', 'бухгалтер', 'аудит', 'налог',
        'лизинг', 'кредитовани', 'депозит', 'вклад',
        'перевод', 'платеж', 'эквайринг', 'терминал',
        'финансовый', 'бухгалтерск', 'отчётн',
      ],
      '🌾 Сельское хозяйство': [
        'фермер', 'сельскохозяйственн', 'продукция', 'урожай',
        'животновод', 'растениевод', 'зерно', 'молоко',
        'мясо', 'овощи', 'фрукты', 'ягоды',
        'теплиц', 'парник', 'скот', 'птиц', 'пчеловод',
        'удобрени', 'семен', 'агроном',
      ],
      '🎮 Развлечения и досуг': [
        'развлечени', 'досуг', 'аниматор', 'праздник',
        'квест', 'аттракцион', 'парк', 'парк развлечений',
        'кино', 'театр', 'концерт', 'музык',
        'тур', 'путешеств', 'отдых', 'база отдыха',
        'кемпинг', 'рыбалк', 'охот', 'поход',
      ],
    };

    // Подсчёт баллов для каждой категории
    for (const [industry, keywords] of Object.entries(industries)) {
      scores[industry] = 0;
      for (const keyword of keywords) {
        const regex = new RegExp(keyword, 'gi');
        const matches = text.match(regex);
        if (matches) {
          scores[industry] += matches.length;
        }
      }
    }

    // Находим категорию с максимальным баллом
    let maxScore = 0;
    let bestIndustry = 'Не определено';
    
    for (const [industry, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        bestIndustry = industry;
      }
    }

    console.log(`📊 Оценка сфер: ${JSON.stringify(scores).substring(0, 200)}`);
    
    return bestIndustry;
  }

  /**
   * Попытка получить ИНН через внешние API (сервисы проверки контрагентов)
   * Работает только если название компании найдено
   */
  async searchInnExternally(name) {
    if (!name) return null;
    
    console.log(`🔍 Поиск ИНН для: ${name}`);
    console.log('⚠ Внимание: для поиска ИНН требуется API ключ сервиса (e.g., listsadebit.ru, contact.ru)');
    console.log('   Вставьте API-ключ в переменную INN_API_KEY и раскомментируйте код ниже:');
    console.log('');
    console.log('   const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(name)}`);');
    console.log('   const data = await response.json();');
    console.log('   return data.inn || null;');
    console.log('');
    return null; // Возвращаем null, так как API ключ не настроен
  }

  /**
   * Основной метод: извлекает всю информацию о компании с URL
   */
  async parse(url) {
    // Убедимся, что URL начинается с протокола
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    this.baseUrl = url;

    let browser;
    try {
      console.log(`🌐 Загрузка страницы: ${url}`);
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Даем дополнительное время для загрузки динамического контента
      await page.waitForTimeout(2000);

      // 1. Извлекаем JSON-LD структурированные данные (самый надёжный источник)
      console.log('📦 Извлечение JSON-LD...');
      await this.extractJsonLd(page);
      console.log(`  ✅ JSON-LD: ${this._isValid(this.found.name) ? 'название' : '—'}, ${this._isValid(this.found.phone) ? 'телефон' : '—'}, ${this._isValid(this.found.address) ? 'адрес' : '—'}`);

      // 2. Извлекаем Open Graph теги
      console.log('📱 Извлечение Open Graph...');
      await this.extractOpenGraph(page);
      console.log(`  ✅ OG: ${this._isValid(this.found.name) ? 'название' : '—'}, ${this._isValid(this.found.phone) ? 'телефон' : '—'}, ${this._isValid(this.found.address) ? 'адрес' : '—'}`);

      // 3. Извлекаем из HTML-разметки
      console.log('🔍 Извлечение из HTML...');
      await this.extractFromHtml(page);
      console.log(`  ✅ HTML: ${this._isValid(this.found.name) ? 'название' : '—'}, ${this._isValid(this.found.phone) ? 'телефон' : '—'}, ${this._isValid(this.found.address) ? 'адрес' : '—'}`);

      await page.close();
      await context.close();

      // 4. Попытка поиска ИНН через внешний API
      if (!this.found.inn && this.found.name) {
        await this.searchInnExternally(this.found.name);
      }

      return this.found;

    } catch (error) {
      console.error('❌ Ошибка парсинга:', error.message);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Выводит результаты в красивом формате
   */
  printResults() {
    console.log('\n' + '='.repeat(60));
    console.log('📋 РЕЗУЛЬТАТЫ ПАРСИНГА КОМПАНИИ');
    console.log('='.repeat(60));
    
    const fields = [
      { key: 'name', label: '🏢 Название компании' },
      { key: 'address', label: '📍 Адрес' },
      { key: 'phone', label: '📞 Телефон' },
      { key: 'description', label: '📝 Описание' },
      { key: 'industry', label: '🎯 Сфера деятельности' },
      { key: 'inn', label: '🔢 ИНН' },
      { key: 'logo', label: '🖼 Логотип' },
      { key: 'city', label: '🏙 Город' },
    ];

    for (const field of fields) {
      const value = this.found[field.key];
      if (value) {
        console.log(`${field.label}: ${value}`);
      } else {
        console.log(`${field.label}: не определено`);
      }
    }

    console.log('='.repeat(60));
  }

  /**
   * Возвращает результаты в формате JSON
   */
  toJSON() {
    return JSON.stringify(this.found, null, 2);
  }

  /**
   * Вспомогательные методы
   * ============================================================
   */

  /**
   * Исправляет падежи русских городов (простая эвристика)
   */
  _fixCityCase(city) {
    if (!city) return city;
    const endings = city.match(/([А-ЯЁа-яё]+)[аеыия]?$/);
    if (!endings) return city;
    
    const base = endings[1];
    // Популярные города в предложном падеже -> именительный
    const cases = {
      'Самаре': 'Самара',
      'Москве': 'Москва',
      'Петербурге': 'Петербург',
      'Казани': 'Казань',
      'Екатеринбурге': 'Екатеринбург',
      'Новосибирске': 'Новосибирск',
      'Саратове': 'Саратов',
      'Тольятти': 'Тольятти',
      'Ижевске': 'Ижевск',
    };
    
    if (cases[city]) return cases[city];
    
    // Простое удаление окончаний предложного падежа
    if (city.endsWith('е') && base.length > 2) return base;
    if (city.endsWith('и') && base.length > 2) return base + 'ь';
    
    return city;
  }

  _cleanText(text) {
    if (!text) return null;
    return he.decode(String(text).replace(/\s+/g, ' ').trim()) || null;
  }

  _cleanTitle(title) {
    if (!title) return null;
    let cleaned = he.decode(title);
    // Убираем типичные суффиксы
    cleaned = cleaned.replace(/\s*[|—–\-]\s*.*/g, '').trim();
    cleaned = cleaned.replace(/\s*\d{2}\s*/g, '').trim();
    // Убираем призывы к действию в конце
    cleaned = cleaned.replace(/[\.\s]*Звоните?\./g, '').trim();
    cleaned = cleaned.replace(/[\.\s]*Звони!\.?$/g, '').trim();
    cleaned = cleaned.replace(/[\.\s]*Оставьте\s*заявк[уу].*$/gi, '').trim();
    return cleaned || null;
  }

  _extractPhone(text) {
    if (!text) return null;
    const match = text.match(/(\+7|8)\s*[\(]?\d{3}[\)]?\s*[-]?\d{3}[-]?\d{2}[-]?\d{2}/);
    if (match) {
      return match[0].replace(/^8\s*/, '+7').replace(/\s/g, '');
    }
    return text.replace(/\D/g, '') || null;
  }

  _resolveUrl(url, baseUrl) {
    if (!url) return null;
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  }
}

module.exports = CompanyParser;
