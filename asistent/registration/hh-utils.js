const { serverLog } = require('../logger');
const { Page } = require('playwright');

/**
 * Переходит на страницу профиля и извлекает все контакты.
 * @param {import('playwright').Page} page
 * @returns {Promise<object>}
 */
async function extractProfileContacts(page) {
  const profileUrl = 'https://hh.ru/applicant/profile/me?hhtmFrom=main&hhtmFromLabel=header';

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Ждём появления хотя бы одного контактного элемента
    await page.waitForSelector('[data-qa^="profile-contact-item-"]', { timeout: 10000 }).catch(() => {});

    // Универсальный извлекатель: ищет карточку по data-qa и берёт второе cell-text-content
    async function getContactValue(dataQa) {
      const card = page.locator(`[data-qa="${dataQa}"]`);
      if (!(await card.count())) return null;

      const cellTexts = await card.locator('[data-qa="cell-text-content"]').allInnerTexts();
      if (cellTexts.length >= 2) {
        return cellTexts[1].trim();
      }
      return null;
    }

    // Собираем все контакты
    const phone    = await getContactValue('profile-contact-item-phone');
    const email    = await getContactValue('profile-contact-item-email');
    const telegram = await getContactValue('profile-contact-item-telegram');
    const max      = await getContactValue('profile-contact-item-max');
    const whatsapp = await getContactValue('profile-contact-item-whatsapp');
    const viber    = await getContactValue('profile-contact-item-viber');

    const contacts = { phone, email, telegram, max, whatsapp, viber };

    // Логируем только те, что найдены
    const found = Object.entries(contacts)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    console.log(`  Профиль: ${found || 'контакты не найдены'}`);
    return contacts;

  } catch (err) {
    console.error(`  Ошибка извлечения профиля: ${err.message}`);
    return { phone: null, email: null, telegram: null, max: null, whatsapp: null, viber: null };
  }
}



/**
 * Извлекает данные со страницы вакансии (fallback, если responseButton не найден).
 */
// --- Исправление 1: extractVacancyDataFromPage — один аргумент-объект ---

function todayLocalDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
/**
 * Преобразует текст даты из hh.ru ("сегодня", "вчера", "5 мар") в ISO-строки.
 */
function parseHhDate(dateText) {
  const now = new Date();

  // Локальная дата без toISOString — чтобы не ломать таймзону
  function toLocalISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return {
      applied_at: `${y}-${m}-${d}T${h}:${min}:${s}`,
      applied_dt: `${y}-${m}-${d}`
    };
  }

  const text = (dateText || '').trim().toLowerCase();

  if (text === 'сегодня') {
    return toLocalISO(now);
  }

  if (text === 'вчера') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return toLocalISO(yesterday);
  }

  // "5 мар", "12 декабря" и т.п.
  const months = {
    'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'мая': 4, 'май': 4,
    'июн': 5, 'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11,
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
  };

  const match = text.match(/(\d{1,2})\s+([а-я]+)/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    if (month !== undefined) {
      const year = now.getFullYear();
      const d = new Date(year, month, day);
      if (d > now) d.setFullYear(year - 1);
      return toLocalISO(d);
    }
  }

  // Fallback — текущий момент
  return toLocalISO(now);
}



async function extractVacancyDataFromPage(vacancyPage, vacancyUrl, vacancyId) {
  return await vacancyPage.evaluate(({ url, id }) => {
    const titleEl =
      document.querySelector('[data-qa="vacancy-title"]') ||
      document.querySelector('h1');
    const title = titleEl?.textContent?.trim() || null;

    const salaryEl =
      document.querySelector('[data-qa="vacancy-salary"]') ||
      document.querySelector('[data-qa="vacancy-view-raw-salary"]');
    const salary = salaryEl?.textContent?.trim() || null;

    const companyEl =
      document.querySelector('[data-qa="vacancy-employer-name"]') ||
      document.querySelector('a[data-qa="vacancy-employer-name"]');
    const company = companyEl?.textContent?.trim() || null;
    const companyUrl = companyEl?.href || null;
    const employerId = companyUrl?.match(/\/employer\/(\d+)/)?.[1] || null;

    const addressEl =
      document.querySelector('[data-qa="vacancy-view-raw-address"]') ||
      document.querySelector('[data-qa="vacancy-address"]');
    const area = addressEl?.textContent?.trim() || null;

    const experienceEl = document.querySelector('[data-qa="vacancy-experience"]');
    const experience = experienceEl?.textContent?.trim() || null;

    const descEl = document.querySelector('[data-qa="vacancy-description"]');
    const description = descEl?.textContent?.trim()?.slice(0, 500) || null;

    const skillEls = document.querySelectorAll('[data-qa="skills-element"]');
    const skills = skillEls.length
      ? [...skillEls].map(el => el.textContent?.trim()).filter(Boolean)
      : [];

    const employmentEl =
      document.querySelector('[data-qa="vacancy-employment-mode"]');
    const employment = employmentEl?.textContent?.trim() || null;

    return {
      vacancyTitle: title,
      vacancyUrl: url,
      vacancyId: id,
      external_id: id,
      company,
      companyUrl,
      employerId,
      area,
      salary,
      experience,
      employment,
      description,
      skills,
      companyRating: null,
      conversationUrl: url,
      source: 'hh.ru',
    };
  }, { url: vacancyUrl, id: vacancyId });  // ← один объект вместо двух аргументов
}


/**
 * Обход всех откликов, извлечение контекста и сохранение в БД.
 */
async function processAllNegotiations(page, db, extractAllHhVacancyContext) {
  await page.waitForSelector('[data-qa="negotiations-item"]', { timeout: 15000 });

  const itemCount = await page.locator('[data-qa="negotiations-item"]').count();
  serverLog.info(`Найдено откликов: ${itemCount}`);

  for (let i = 0; i < itemCount; i++) {
    try {
      const item = page.locator('[data-qa="negotiations-item"]').nth(i);

      // --- Данные из карточки отклика ---
      const vacancyTitle = await item.locator('[data-qa="negotiations-item-vacancy"]').innerText().catch(() => null);

      const company = await item.locator('[data-qa="negotiations-item-company"]').innerText().catch(() => null);

      const date = await item.locator('[data-qa="negotiations-item-date"]').innerText().catch(() => null);

      const vacancyHref = await item.locator('a[href*="/vacancy/"]')
        .first().getAttribute('href').catch(() => null);
      const vacancyUrl = vacancyHref? `https://hh.ru${vacancyHref.split('?')[0]}`: null;
      const vacancyId = vacancyHref? vacancyHref.match(/\/vacancy\/(\d+)/)?.[1] ?? null: null;

      const status = await item.locator('[data-qa^="negotiations-tag"]').innerText().catch(() => null);

      const employerHref = await item.locator('a[href*="/employer/"]').first().getAttribute('href').catch(() => null);
      const employerId = employerHref? employerHref.match(/\/employer\/(\d+)/)?.[1] ?? null: null;

      serverLog.info(`\n[${i + 1}/${itemCount}] ${vacancyTitle} — ${company} (${date})`);

      // --- Извлечение контекста вакансии ---
      // Функция extractAllHhVacancyContext ожидает (page, responseButton).
      // На странице откликов нет кнопки "Откликнуться" — открываем страницу вакансии.
// --- Извлечение контекста вакансии ---
let vacancyContext = null;

if (vacancyUrl) {
  const vacancyPage = await page.context().newPage();
  try {
    await vacancyPage.goto(vacancyUrl, { waitUntil: 'domcontentloaded' });
    await vacancyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // --- Проверяем, доступна ли вакансия ---
    const isVacancyBlocked = await vacancyPage.locator(
      'text=Вам недоступна эта вакансия'
    ).count().catch(() => 0);

    if (isVacancyBlocked > 0) {
      console.log('  ⚠️ Вакансия недоступна: "Вам недоступна эта вакансия"');
      vacancyContext = {
        vacancyTitle,
        vacancyUrl,
        vacancyId,
        external_id: vacancyId,
        company,
        employerId,
        conversationUrl: page.url(),
        source: 'hh.ru',
        vacancyBlocked: true,   // ← флаг
      };
    } else {
      // Извлекаем данные со страницы вакансии
      vacancyContext = await extractVacancyDataFromPage(vacancyPage, vacancyUrl, vacancyId);

      if (!vacancyContext.vacancyTitle) vacancyContext.vacancyTitle = vacancyTitle;
      if (!vacancyContext.company) vacancyContext.company = company;
      if (!vacancyContext.employerId && employerId) vacancyContext.employerId = employerId;
    }

    console.log(`  Контекст: ${vacancyContext.vacancyTitle} | ${vacancyContext.area || '—'} | ${vacancyContext.salary || '—'}`);

  } catch (err) {
    console.error(`  Ошибка извлечения контекста: ${err.message}`);
    vacancyContext = {
      vacancyTitle,
      vacancyUrl,
      vacancyId,
      external_id: vacancyId,
      company,
      employerId,
      conversationUrl: page.url(),
      source: 'hh.ru',
    };
  } finally {
    await vacancyPage.close();
  }
}


// --- Сбор сообщений из чата ---
const { messages: chatMessages, chatStatus } = await collectChatMessages(page, i);

// Если вакансия недоступна — задаём статус
let finalChatStatus = chatStatus;
if (vacancyContext?.vacancyBlocked) {
  finalChatStatus = 'Вам недоступна эта вакансия';
  console.log(`  Статус: ${finalChatStatus}`);
}
// --- Сохранение в БД ---
// --- Сохранение в БД с проверкой дубликатов ---
try {
  const extId = vacancyContext?.vacancyId || vacancyId;
  const vacTitle = vacancyContext?.vacancyTitle || vacancyTitle;
  const compName = vacancyContext?.company || company;
  const { applied_at: respDate, applied_dt: respDateOnly } = parseHhDate(date);

  const existingChat = await db.findChatByExternalId(extId);

  if (existingChat) {
    console.log(`  Чат уже существует (chatId: ${existingChat.id}) — пропускаем создание`);

    // Обновляем статус, если он изменился
    if (finalChatStatus && finalChatStatus !== existingChat.status) {
      await new Promise((resolve) => {
        db.db.run(
          'UPDATE chats SET status = ?, updated_at = datetime(\'now\') WHERE id = ?',
          [finalChatStatus, existingChat.id],
          (err) => {
            if (err) console.error(`  Ошибка обновления статуса: ${err.message}`);
            else console.log(`  Статус чата обновлён: ${finalChatStatus}`);
            resolve();
          }
        );
      });
    }

    // Проверяем сообщения на новизну
    if (chatMessages && chatMessages.length > 0) {
      const existingTexts = await db.getExistingMessageTexts(existingChat.id);
      let newCount = 0;

      for (const msg of chatMessages) {
        const text = (msg.text || msg.content || '').trim();
        if (text && !existingTexts.has(text)) {
          await new Promise((resolve) => {
            db.db.run(
              `INSERT INTO chat_messages (chat_id, sender, text, content, msg_date, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`,
              [existingChat.id, msg.sender || null, text, text, respDateOnly],
              (err) => {
                if (err) console.error(`  Ошибка сохранения сообщения: ${err.message}`);
                else newCount++;
                resolve();
              }
            );
          });
        }
      }

      if (newCount > 0) {
        console.log(`  Добавлено новых сообщений: ${newCount} (из ${chatMessages.length})`);
      } else {
        console.log(`  Новых сообщений нет (все ${chatMessages.length} уже сохранены)`);
      }
    }

  } else {
    console.log('  Чат не найден — создаём новую запись');

    const chatRecord = {
      external_id: extId,
      conversation_url: vacancyContext?.vacancyUrl || vacancyUrl,
      company: compName,
      status: finalChatStatus || status || 'UNKNOWN',
      applied_at: respDate,
      applied_dt: respDateOnly,
    };

    const appRecord = {
      vacancy: vacTitle,
      company: compName,
      is_viewed: false,
      employer_status: finalChatStatus || status || 'Не просмотрен',
      response_rate: 0,
      chat_url: vacancyContext?.vacancyUrl || vacancyUrl,
      boost_url: null,
      applied_at: respDate,
      applied_dt: respDateOnly,
    };

    const { chatId, applicationId } = await db.createApplicationWithChat(appRecord, chatRecord);
    console.log(`  Сохранено в БД ✓ (chatId: ${chatId}, applicationId: ${applicationId})`);

    if (chatMessages && chatMessages.length > 0) {
      for (const msg of chatMessages) {
        await new Promise((resolve) => {
          db.db.run(
            `INSERT INTO chat_messages (chat_id, sender, text, content, msg_date, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [chatId, msg.sender || null, msg.text || msg.content || null, msg.text || msg.content || null, todayLocalDate()],
            (err) => {
              if (err) console.error(`  Ошибка сохранения сообщения: ${err.message}`);
              resolve();
            }
          );
        });
      }
      console.log(`  Сохранено сообщений: ${chatMessages.length}`);
    }
  }
} catch (dbErr) {
  console.error(`  Ошибка БД: ${dbErr.message}`);
}

    } catch (err) { console.error(`  Ошибка при обработке отклика ${i + 1}: ${err.message}`);}
  }

  console.log('\nГотово! Все отклики обработаны.');
}

// --- Исправление 2: collectChatMessages — SPA-навигация без waitForNavigation ---

async function collectChatMessages(page, itemIndex) {
  const messages = [];
  const listUrl = page.url();

  const item = page.locator('[data-qa="negotiations-item"]').nth(itemIndex);
  const chatButton = item.locator('[data-qa="open_chat"]');

  if (!(await chatButton.count())) {
    console.log('  Кнопка чата не найдена');
    return { messages: [], chatStatus: null };
  }

  await chatButton.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);

  // Кликаем "Перейти в чат"
  try {
    await chatButton.click({ timeout: 5000 });
  } catch {
    await chatButton.click({ force: true, timeout: 5000 }).catch(() => {
      console.log('  Клик не удался');
      return { messages: [], chatStatus: null };
    });
  }

  // Ждём появления виджета чата
  try {
    await page.waitForSelector('[data-qa="chatik-root"]', { timeout: 10000 });
    console.log('  Виджет чата открыт');
  } catch {
    console.log('  Виджет чата не появился');
    return { messages: [], chatStatus: null };
  }

  // Ждём загрузки iframe
  try {
    await page.waitForSelector('.chatik-integration-iframe', { timeout: 10000 });
    await page.waitForTimeout(1500);
  } catch {
    console.log('  iframe чата не загрузился');
    await closeChatWidget(page);
    return { messages: [], chatStatus: null };
  }

  let chatStatus = null;

  try {
    // --- Сначала проверяем статус на самой странице (не в iframe) ---
    // "Вам недоступна эта вакансия" — появляется на странице, а не в iframe
    const pageStatusSelectors = [
      'text=Вам недоступна эта вакансия',
      '[data-qa="applicant-login-card"]',
    ];

    for (const sel of pageStatusSelectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count > 0) {
        chatStatus = 'Вам недоступна эта вакансия';
        console.log(`  ⚠️ Статус чата: ${chatStatus}`);
        await closeChatWidget(page);
        return { messages: [], chatStatus };
      }
    }

    const iframe = page.frameLocator('.chatik-integration-iframe');

    // --- Проверяем статус "Работодатель отключил переписку" внутри iframe ---
    const notAllowedSelectors = [
      '.not-allowed-warning--NbfXlvyYL8lTX5fY',
      '[class*="not-allowed-warning"]',
      '[class*="not-allowed"]',
    ];

    for (const sel of notAllowedSelectors) {
      const count = await iframe.locator(sel).count().catch(() => 0);
      if (count > 0) {
        chatStatus = 'Работодатель отключил переписку по данной вакансии';
        console.log(`  ⚠️ Статус чата: ${chatStatus}`);
        break;
      }
    }

    // --- Собираем сообщения ---
    const messageSelectors = [
      '[data-qa*="message"]',
      '[class*="message"]',
      '[class*="msg"]',
      '[class*="bubble"]',
      '[class*="chat-message"]',
    ];

    let found = false;
    for (const sel of messageSelectors) {
      const count = await iframe.locator(sel).count().catch(() => 0);
      if (count > 0) {
        console.log(`  Найдены сообщения по селектору: ${sel} (${count})`);
        found = true;

        const els = await iframe.locator(sel).all();
        for (const el of els) {
          const text = await el.innerText().catch(() => '');
          if (text?.trim() && text.trim().length >= 2) {
            messages.push({ text: text.trim(), sender: null, time: null });
          }
        }
        break;
      }
    }

    if (!found) {
      console.log('  Сообщения в iframe не найдены');
    }

    console.log(`  Собрано сообщений: ${messages.length}`);

  } catch (err) {
    console.error(`  Ошибка чтения iframe: ${err.message}`);
  }

  await closeChatWidget(page);

  return { messages, chatStatus };
}

/**
 * Закрывает виджет чата.
 */
async function closeChatWidget(page) {
  try {
    const closeBtn = page.locator('[data-qa="chatik-close-chatik"]');
    if (await closeBtn.count()) {
      await closeBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      console.log('  Виджет чата закрыт');
    }
  } catch {
    // Если не закрылось — перезагружаем страницу
    await page.goto(page.url(), { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  // Убеждаемся, что мы на странице списка
  if (!page.url().includes('/applicant/negotiations')) {
    await page.goto('https://hh.ru/applicant/negotiations', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('[data-qa="negotiations-item"]', { timeout: 15000 }).catch(() => {});
}

/**
 * Извлекает сообщения со страницы chatik.hh.ru (отдельная вкладка).
 */
async function extractMessagesFromChatikPage(chatPage) {
  const messages = [];

  // chatik.hh.ru — отдельное приложение, селекторы могут отличаться от основного hh.ru
  const messageEls = await chatPage.locator(
    '[data-qa*="message"]:not([data-qa*="input"]):not([data-qa*="button"]):not([data-qa*="send"]):not([data-qa*="field"]), ' +
    '[class*="message-item"], ' +
    '[class*="chat-message"], ' +
    '[class*="bubble"]'
  ).all();

  for (const el of messageEls) {
    const text = await el.innerText().catch(() => '');
    if (!text?.trim() || text.trim().length < 2) continue;

    const senderEl = el.locator('[data-qa*="author"], [data-qa*="sender"], [class*="author"], [class*="sender"]');
    const sender = await senderEl.first().innerText().catch(() => null);

    const timeEl = el.locator('[data-qa*="time"], [data-qa*="date"], [class*="time"], [class*="date"]');
    const time = await timeEl.first().innerText().catch(() => null);

    messages.push({
      text: text.trim(),
      sender: sender?.trim() || null,
      time: time?.trim() || null,
    });
  }

  return messages;
}


async function extractMessagesFromPage(chatPage) {
  const messages = [];

  // Ищем элементы сообщений — пробуем разные селекторы
  const messageEls = await chatPage.locator(
    '[data-qa*="message"]:not([data-qa*="input"]):not([data-qa*="button"]):not([data-qa*="send"])'
  ).all();

  for (const el of messageEls) {
    const dataQa = await el.getAttribute('data-qa').catch(() => '');
    const text = await el.innerText().catch(() => '');
    if (!text?.trim()) continue;

    // Пытаемся определить отправителя
    const senderEl = el.locator('[data-qa*="author"], [data-qa*="sender"], [class*="author"]');
    const sender = await senderEl.first().innerText().catch(() => null);

    messages.push({
      dataQa: dataQa || null,
      text: text.trim(),
      sender,
    });
  }

  return messages;
}
/**
 * Извлекает контекст вакансии с HH.ru
 */
async function extractHhVacancyContext(page, responseButton) {
  serverLog.info("Ищем информацию о вакансии и отклики");
  const pageUrl = page.url();

  const raw = await responseButton
    .evaluate((button) => {
      // Кнопка "Откликнуться" — это <span> внутри <a data-qa="vacancy-serp__vacancy_response">
      // Корневой элемент карточки: <div data-qa="vacancy-serp__vacancy">
      const root =
        button.closest('[data-qa="vacancy-serp__vacancy"]') ||
        button.closest('article') ||
        button.closest('[data-qa*="serp-item"]') ||
        button.parentElement?.parentElement?.parentElement ||
        button.parentElement;

      // ID вакансии и ID работодателя прямо из href кнопки отклика
      const responseLink = button.closest('a[data-qa="vacancy-serp__vacancy_response"]');
      const responseHref = responseLink?.href || '';
      const vacancyIdFromHref = responseHref.match(/vacancyId=(\d+)/)?.[1] || null;
      const employerIdFromHref = responseHref.match(/employerId=(\d+)/)?.[1] || null;

      // Заголовок вакансии
      const titleEl = root?.querySelector('[data-qa="serp-item__title-text"]') ||
                      root?.querySelector('[data-qa="serp-item__title"]');
      const title = titleEl?.textContent?.trim() || null;

      // Ссылка на вакансию
      const vacancyLinkEl = root?.querySelector('a[data-qa="serp-item__title"]') ||
                           root?.querySelector('a[href*="/vacancy/"]');
      const vacancyUrl = vacancyLinkEl?.href || null;

      // Компания
      const companyEl = root?.querySelector('[data-qa="vacancy-serp__vacancy-employer-text"]');
      const company = companyEl?.textContent?.trim() || null;

      // Ссылка на компанию
      const companyLinkEl = root?.querySelector('a[data-qa="vacancy-serp__vacancy-employer"]') ||
                           root?.querySelector('a[href*="/employer/"]');
      const companyUrl = companyLinkEl?.href || null;

      // Адрес
      const addressEl = root?.querySelector('[data-qa="vacancy-serp__vacancy-address"]');
      const area = addressEl?.textContent?.trim() || null;

      // Зарплата
      const salaryEl = root?.querySelector('[data-qa="vacancy-serp__vacancy-compensation"]');
      const salary = salaryEl?.textContent?.trim() || null;

      // Опыт работы
      const experienceEl = root?.querySelector('[data-qa*="vacancy-work-experience"]');
      const experience = experienceEl?.textContent?.trim() || null;

      // Рейтинг компании
      const ratingEl = root?.querySelector('[data-qa="company-review-rating-value"]');
      const rating = ratingEl?.textContent?.trim() || null;

      return {
        vacancyTitle: title,
        vacancyUrl: vacancyUrl,
        vacancyIdFromButton: vacancyIdFromHref,
        employerIdFromButton: employerIdFromHref,
        company: company,
        companyUrl: companyUrl,
        area: area,
        salary: salary,
        experience: experience,
        companyRating: rating,
        responseButtonHref: responseHref,
      };
    })
    .catch((error) => {
      serverLog.warn(`⚠️ Не удалось извлечь данные вакансии: ${error.message}`);
      return {};
    });

  // --- Вычисляем URL и ID вакансии (снаружи evaluate) ---
  const vacancyUrl =
    raw.vacancyUrl ||
    (pageUrl.match(/https?:\/\/[^/]+\/vacancy\/\d+[^\s?#]*/i)?.[0] || null);

  // Приоритет: ID из кнопки отклика → ID из URL вакансии → ID из URL страницы
  const vacancyId =
    raw.vacancyIdFromButton ||
    vacancyUrl?.match(/\/vacancy\/(\d+)/i)?.[1] ||
    pageUrl.match(/\/vacancy\/(\d+)/i)?.[1] ||
    pageUrl.match(/[?&]vacancyId=(\d+)/i)?.[1] ||
    null;

  serverLog.info(`✅ title: ${raw.vacancyTitle || 'не найдено'}`);
  serverLog.info(`✅ company: ${raw.company || 'не найдено'}`);
  serverLog.info(`✅ area: ${raw.area || 'не найдено'}`);
  serverLog.info(`✅ vacancyId: ${vacancyId || 'не найден'}`);
  serverLog.info(`✅ vacancyUrl: ${vacancyUrl || 'не найдено'}`);

  return {
    vacancyTitle: raw.vacancyTitle || null,
    vacancyUrl: vacancyUrl,
    vacancyId: vacancyId,
    company: raw.company || null,
    companyUrl: raw.companyUrl || null,
    employerId: raw.employerIdFromButton || null,
    area: raw.area || null,
    salary: raw.salary || null,
    experience: raw.experience || null,
    companyRating: raw.companyRating || null,
    conversationUrl: pageUrl,
    source: 'hh.ru',
  };
}



/**
 * Извлекает контекст вакансии с HH.ru
 */
async function extractAllHhVacancyContext(page, responseButton) {
  serverLog.info("Ищем информацию о вакансии и отклики");
  const pageUrl = page.url();

  const raw = await responseButton
    .evaluate((button) => {
      const root =
        button.closest('[data-qa="vacancy-serp__vacancy"]') ||
        button.closest('article') ||
        button.closest('[data-qa*="serp-item"]') ||
        button.parentElement?.parentElement?.parentElement ||
        button.parentElement;

      // ID вакансии и ID работодателя прямо из href кнопки отклика
      const responseLink = button.closest('a[data-qa="vacancy-serp__vacancy_response"]');
      const responseHref = responseLink?.href || '';
      const vacancyIdFromHref = responseHref.match(/vacancyId=(\d+)/)?.[1] || null;
      const employerIdFromHref = responseHref.match(/employerId=(\d+)/)?.[1] || null;

      // Заголовок вакансии
      const titleEl = root?.querySelector('[data-qa="serp-item__title-text"]') || root?.querySelector('[data-qa="serp-item__title"]');
      const title = titleEl?.textContent?.trim() || null;

      // Ссылка на вакансию
      const vacancyLinkEl = root?.querySelector('a[data-qa="serp-item__title"]') || root?.querySelector('a[href*="/vacancy/"]');
      const vacancyUrl = vacancyLinkEl?.href || null;

      // Компания
      const companyEl = root?.querySelector('[data-qa="vacancy-serp__vacancy-employer-text"]');
      const company = companyEl?.textContent?.trim() || null;

      // Ссылка на компанию
      const companyLinkEl = root?.querySelector('a[data-qa="vacancy-serp__vacancy-employer"]') || root?.querySelector('a[href*="/employer/"]');
      const companyUrl = companyLinkEl?.href || null;

      // Адрес
      const addressEl = root?.querySelector('[data-qa="vacancy-serp__vacancy-address"]');
      const area = addressEl?.textContent?.trim() || null;

      // Зарплата
      const salaryEl = root?.querySelector('[data-qa="vacancy-serp__vacancy-compensation"]');
      const salary = salaryEl?.textContent?.trim() || null;

      // Опыт работы
      const experienceEl = root?.querySelector('[data-qa*="vacancy-work-experience"]');
      const experience = experienceEl?.textContent?.trim() || null;

      // Рейтинг компании
      const ratingEl = root?.querySelector('[data-qa="company-review-rating-value"]');
      const rating = ratingEl?.textContent?.trim() || null;

      return {
        vacancyTitle: title,
        vacancyUrl: vacancyUrl,
        vacancyIdFromButton: vacancyIdFromHref,
        employerIdFromButton: employerIdFromHref,
        company: company,
        companyUrl: companyUrl,
        area: area,
        salary: salary,
        experience: experience,
        companyRating: rating,
        responseButtonHref: responseHref,
      };
    })
    .catch((error) => {
      serverLog.warn(`⚠️ Не удалось извлечь данные вакансии: ${error.message}`);
      return {};
    });

  // --- Вычисляем URL и ID вакансии (снаружи evaluate) ---
  const vacancyUrl =
    raw.vacancyUrl ||
    (pageUrl.match(/https?:\/\/[^/]+\/vacancy\/\d+[^\s?#]*/i)?.[0] || null);

  // Приоритет: ID из кнопки отклика → ID из URL вакансии → ID из URL страницы
  const vacancyId =
    raw.vacancyIdFromButton ||
    vacancyUrl?.match(/\/vacancy\/(\d+)/i)?.[1] ||
    pageUrl.match(/\/vacancy\/(\d+)/i)?.[1] ||
    pageUrl.match(/[?&]vacancyId=(\d+)/i)?.[1] ||
    null;

  serverLog.info(`✅ title: ${raw.vacancyTitle || 'не найдено'}`);
  serverLog.info(`✅ company: ${raw.company || 'не найдено'}`);
  serverLog.info(`✅ area: ${raw.area || 'не найдено'}`);
  serverLog.info(`✅ vacancyId: ${vacancyId || 'не найден'}`);
  serverLog.info(`✅ vacancyUrl: ${vacancyUrl || 'не найдено'}`);

  return {
    vacancyTitle: raw.vacancyTitle || null,
    vacancyUrl: vacancyUrl,
    vacancyId: vacancyId,
    company: raw.company || null,
    companyUrl: raw.companyUrl || null,
    employerId: raw.employerIdFromButton || null,
    area: raw.area || null,
    salary: raw.salary || null,
    experience: raw.experience || null,
    companyRating: raw.companyRating || null,
    conversationUrl: pageUrl,
    source: 'hh.ru',
  };
}


async function saveHhApplication(hooks, vacancy) {
  serverLog.info("Зашли в сохранение");
  if (typeof hooks?.onHhApplication !== 'function') return;

  try {
    await hooks.onHhApplication({
      ...vacancy,
      responseAt: new Date().toISOString(),
      responseStatus: 'sent',
      messagePreview: 'Отклик отправлен',
    });
  } catch (error) {
    // Ошибка записи не должна превращать уже отправленный отклик в ошибку.
    serverLog.error(`❌ Отклик отправлен, но не сохранён в chats: ${error.message}`);
  }
}

async function processAllNegotiationsWithPagination(page, db, extractAllHhVacancyContext) {
  let pageNum = 1;

  while (true) {
    serverLog.info(`\n========== Страница ${pageNum} ==========`);
    await processAllNegotiations(page, db, extractAllHhVacancyContext);

    // Ищем кнопку "Следующая страница" по точному data-qa
    const nextButton = page.locator('[data-qa="number-pages-next"]');
    const hasNext = await nextButton.count();

    if (!hasNext) {
      console.log('\nКнопка "Следующая" не найдена — это последняя страница');
      break;
    }

    // Проверяем, что кнопка не disabled
    const isDisabled = await nextButton.getAttribute('disabled').catch(() => null);
    if (isDisabled !== null) {
      console.log('\nКнопка "Следующая" отключена — это последняя страница');
      break;
    }

    console.log('Переход на следующую страницу...');

    // Кликаем и ждём навигацию
    await Promise.all([
      page.waitForNavigation({ timeout: 15000, waitUntil: 'load' }).catch(() => {}),
      nextButton.click(),
    ]);

    // Ждём загрузки списка откликов на новой странице
    try {
      await page.waitForSelector('[data-qa="negotiations-item"]', { timeout: 15000 });
    } catch {
      console.log('Список откликов не загрузился, завершаем');
      break;
    }

    const itemCount = await page.locator('[data-qa="negotiations-item"]').count();
    if (!itemCount) {
      console.log('Откликов на странице нет, завершаем');
      break;
    }

    console.log(`Загружено откликов на новой странице: ${itemCount}`);
    pageNum++;
  }

  console.log(`\nОбработка завершена. Страниц обработано: ${pageNum}`);
}

module.exports = {
  extractHhVacancyContext,
  extractProfileContacts,
  extractAllHhVacancyContext,
  saveHhApplication,
  processAllNegotiations, 
  collectChatMessages, 
  extractMessagesFromPage,
  processAllNegotiationsWithPagination,
};
