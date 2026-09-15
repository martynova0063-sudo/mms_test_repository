const { serverLog } = require('../logger');
const { chromium } = require('playwright');
const { getSiteSelectors, getProfileUrl } = require('./form-configs');
const { getConfirmationCode } = require('./email-parser');
const { fillForm, fillIrecommendWithJS, fillOrgpageWithJS } = require('./form-filler');
const { handleCataloxyCheckboxes, handleOrgpageCheckboxes, handleIrecommendCheckboxes } = require('./captcha-handler');
const ExcelJS = require('exceljs');
const { OpenAI } = require('openai');
const RegistrationDB = require('../registration-db');

const { generateCoverLetter } =require('./cover-letter-generator.js');
const { extractProfileContacts } =require('./hh-utils.js');

const { extractHhVacancyContext, extractAllHhVacancyContext, processAllNegotiations, processAllNegotiationsWithPagination, collectChatMessages, extractMessagesFromPage, }= require('./hh-utils');

const DEFAULT_PAUSE_MS = 6000;

const db = new RegistrationDB();

function waitForPause(page, pauseMs = DEFAULT_PAUSE_MS) {
  const normalizedPauseMs = Number.isFinite(Number(pauseMs))
    ? Math.min(120000, Math.max(0, Math.round(Number(pauseMs))))
    : DEFAULT_PAUSE_MS;
  return page.waitForTimeout(normalizedPauseMs);
}

function createAIClient() {
  const groqApiKey = process.env.GROQ_API_KEY?.trim();
  if (groqApiKey) {
    return {
      client: new OpenAI({
        apiKey: groqApiKey,
        baseURL: 'https://api.groq.com/openai/v1',
      }),
      provider: 'Groq',
      model: 'llama-3.1-8b-instant',
    };
  }

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiApiKey) {
    return {
      client: new OpenAI({ apiKey: openaiApiKey }),
      provider: 'OpenAI',
      model: 'gpt-4o-mini',
    };
  }

  return null;
}
/*
//Вместо жёстких пауз
//await page.waitForSelector('button[data-qa="submit-button"]', { state: 'enabled' });
//await modalOverlay.waitFor({ state: 'hidden', timeout: 10000 });
//Retry-обёртка
*
*/

async function retry(fn, retries = 3, delayMs = DEFAULT_PAUSE_MS) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      serverLog.warn(`Retry ${i + 1} after error: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
}

async function selectCheckboxByLabelText(page, labelText) {
  serverLog.info("Заполняем чекбокс нужным вариантом")
  // Ищем label, который содержит нужный текст, и внутри него input
  const locator = page.locator(`[data-qa="cell"] label:has-text("${labelText}") input`);
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.check({ force: true });
  console.log(`✅ Selected: ${labelText}`);
}

/**
 * Обрабатывает кнопку «Приложить письмо» и заполняет сопроводительное письмо
 */
async function handleCoverLetterToggle(page, email, vacancyTitle, pauseMs = DEFAULT_PAUSE_MS) {
  try{
    const buttons2 = page.locator('[data-qa="vacancy-response-letter-toggle"]');
   // await page.waitForTimeout(6000); // Пауза перед проверкой количества
    const count2 = await buttons2.count();
    if (count2 === 0) {
      serverLog.error('❌ Кнопка "Приложить письмо" не найдена на странице');
      return false;  }

    await buttons2.first().click({ force: true });
    serverLog.info('✅ Первая кнопка "Приложить письмо" нажата');
   // await waitForPause(page, pauseMs);

    const possibleLabels = ['Сопроводительное письмо', 'Почему именно ваша кандидатура должна заинтересовать работодателя', 'Расскажите о себе' ];

    const regex = new RegExp(possibleLabels.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

    const labelLocator = page.locator('label').filter({ hasText: regex });
    const labelId = await labelLocator.getAttribute('id');
  
    const textarea = page.locator('textarea', {hasAttribute: `aria-labelledby=${labelId}`,});
   // await textarea.waitFor({ state: 'visible', timeout: 10000 });

    const contactInfo = {
                    phone: profileContacts.phone,
                    email: profileContacts.email,
                    telegram: profileContacts.telegram,
                    maxLink: profileContacts.max,
                  };

    const coverLetterText = generateCoverLetter(vacancyTitle, contactInfo);
    console.log(coverLetterText);
    await textarea.fill(coverLetterText);
    serverLog.info('✅ Сопроводительное письмо введено');

    const submitButton = page.locator('[data-qa="vacancy-response-letter-submit"], [data-qa="vacancy-response-submit-popup"]');
    const modalOverlay = page.locator('[data-qa="modal-overlay"]');

  // Ждём появления модального окна
//  await modalOverlay.waitFor({ state: 'visible', timeout: 20000 });
    serverLog.info('✅ Модальное окно открыто');

//  await submitButton.waitFor({ state: 'visible', timeout: 30000 });
    serverLog.info('✅ Ждём появления кнопки Отправить');
    const isEnabled = await submitButton.isEnabled();
    if (!isEnabled) {
      serverLog.warn('⚠️ Кнопка "Отправить" неактивна — проверь, все ли поля заполнены');
      await page.screenshot({ path: 'submit-disabled.png' });
    }
    //await waitForPause(page, pauseMs);
    await submitButton.click({ force: true });
    serverLog.info('✅ Клик по кнопке "Отправить" выполнен');
   // await waitForPause(page, pauseMs);
    await page.screenshot({ path: 'submit-enabled.png' });

    // После отправки ждём, что окно всё ещё видно (если оно должно закрыться само, а не закрылось)
    console.log('✅ После отправки ждём, что окно всё ещё видно');
   // await modalOverlay.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    // Проверяем, осталось ли окно видимым
    const isModalStillVisible = await modalOverlay.isVisible();

    if (isModalStillVisible) {
      console.log('⚠️ Модальное окно не закрылось автоматически — пытаемся закрыть принудительно');
      console.log('✅ Ищем именно кнопку закрытия внутри модалки');   
    // Ищем именно кнопку закрытия внутри модалки. Частые варианты:
    // 1. Кнопка с текстом/иконкой close
    // 2. Кнопка в блоке secondary-actions
      const closeButton = modalOverlay.locator('button, [role="button"]').filter({hasText: /закрыть|close|×/i});
      console.log('✅ Кнопка с текстом/иконкой close');
      const hasCloseButton = await closeButton.isVisible();
      console.log('✅ Кнопка в блоке secondary-actions');
     // await waitForPause(page, pauseMs);
      if (hasCloseButton) { 
        console.log('✅ Зашли в блок if');
        await closeButton.click({ force: true });
        console.log('✅ Кнопка закрытия найдена и нажата');
      } else {
         console.log('✅ Зашли в блок else');
       //  await page.waitForTimeout(6000);
         // Альтернатива: попробовать нажать Esc, если модалка реагирует на него
         await page.press('Escape');
         console.log('✅ Отправлен Escape для закрытия модального окна');
      }
    console.log('✅ Вышли из блока if else');  
   // await waitForPause(page, pauseMs);
    // Убеждаемся, что окно закрылось
   // await modalOverlay.waitFor({ state: 'hidden', timeout: 10000 });
    console.log('✅ Модальное окно закрыто');
    } else {  console.log('✅ Модальное окно закрылось автоматически');}
    return true;
  } catch (error) {
      serverLog.error('❌ Ошибка в handleCoverLetterToggle:', error);
      // Сохраняем скриншот при ошибке
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = `handleCoverLetterToggle-error-${timestamp}.png`;
      try {
        await page.screenshot({ path: screenshotPath });
        serverLog.info(`📸 Скриншот ошибки сохранён: ${screenshotPath}`);
      } catch (screenshotError) {serverLog.error('📸 Не удалось сделать скриншот:', screenshotError);}
    }
}

/**
 * Извлекает последнее сообщение из чата Chatik на hh.ru
 */
async function extractLastChatMessage(page, pauseMs = DEFAULT_PAUSE_MS) {
  await waitForPause(page, pauseMs);
 
  const chatikButton = page.locator('[data-qa="chatikActivator-button"]');
  await chatikButton.waitFor({ state: 'visible', timeout: 30000 });
  await chatikButton.click();

  await waitForPause(page, pauseMs);
 
  serverLog.info('📡 Ждём загрузки iframe чата...');
  await waitForPause(page, pauseMs);

  const chatFrame = await page.frameLocator('iframe[src*="chatik.hh.ru"]');
 // await chatFrame.locator('body');//.waitFor({ state: 'visible', timeout: 20000 });
  await waitForPause(page, pauseMs);

  serverLog.info('🧩 Ищем чекбокс "Только непрочитанные" внутри iframe...');
  const checkbox = chatFrame.locator('[data-qa="chatik-checkbox-only-unread"]');
  //await checkbox.waitFor({ state: 'visible', timeout: 10000 });
  await waitForPause(page, pauseMs);

  let lastMessageText = 'Спасибо за отклик';

  if (await checkbox.isVisible().catch(() => false)) {
    await checkbox.click();
    serverLog.info('Фильтр "Только непрочитанные" применён');

    const chatLinks = chatFrame.locator('[data-qa^="chatik-open-chat-"]');
    await chatLinks.first().scrollIntoViewIfNeeded({ timeout: 10000 });
    await chatLinks.first().click();
    serverLog.info('✅ Кликаем по первому чату');

    await waitForPause(page, pauseMs);

    const messageCount = await chatFrame.locator('[data-qa^="chatik-chat-message"]').count();
    serverLog.info(`⚠️ Найдено сообщений: ${messageCount}`);

    if (messageCount > 0) {
      const textLocator = chatFrame.locator(
        '[data-qa^="chatik-chat-message"] [data-qa="chat-bubble-text"]'
      );
      lastMessageText = (await textLocator.last().textContent())?.trim() || lastMessageText;
      if (lastMessageText) {
        serverLog.info(`💬 Последнее сообщение: ${lastMessageText}`);
      } else {
        serverLog.warn('⚠️ Сообщения есть, но текст пустой (возможно, это медиа или кнопка).');
      }
    } else {
      serverLog.warn('⚠️ В чате нет сообщений.');
    }
  } else {
    serverLog.warn('⚠️ Чекбокс не найден: возможно, интерфейс чата ещё не отрисован');
  }

  return lastMessageText;
}
/**
 * Анализирует последнее сообщение с помощью AI и возвращает решение
 */
async function analyzeChatWithAI(lastMessageText) {
  const ai = createAIClient();
  serverLog.info('[AI] Проверка наличия ключа:', ai ? `✅ Есть (${ai.provider})` : '❌ НЕТ');
  if (!ai) {
    serverLog.error('AI не настроен: добавьте GROQ_API_KEY или OPENAI_API_KEY в секреты проекта, чтобы включить анализ чатов.');
  }
  try {
    serverLog.info(`[AI] Отправляем запрос в ${ai.provider}...`);
    const chatResponse = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        {
          role: 'system',
          content: 'Ты анализируешь сообщения пользователя. Проанализируй сообщение и дай результат согласно инструкции.',
        },
        { role: 'user', content: `Вот непрочитанные сообщения из чата: ${lastMessageText}` },
      ],
      max_tokens: 512,
    });

    serverLog.info('✅ Ответ от AI получен');
    const result = chatResponse?.choices?.[0]?.message?.content; 

    serverLog.info('[AI] Ответ:', result);
    return result;
  } catch (error) {
    const status = error?.status ?? error?.response?.status;
    let userMessage = `Ошибка запроса к ${ai.provider}`;

    if (status === 401 || status === 403) {
      userMessage =
        `${ai.provider} отклонил запрос (${status}). ` +
        'Проверьте, что API-ключ действующий, не отозван и имеет доступ к выбранной модели. ' +
        'Сам ключ не выводится в лог.';
    } else if (status === 429) {
      userMessage =
        `${ai.provider} временно ограничил запросы (429). ` +
        'Подождите и проверьте лимиты или баланс аккаунта.';
    }

    serverLog.error(`❌ Ошибка запроса к ${ai.provider}:`, {
      message: error?.message,
      status,
      code: error?.code,
      type: error?.type,
      requestID: error?.requestID,
      error: error?.error,
    });

    const enrichedError = new Error(`${userMessage}: ${error?.message || 'неизвестная ошибка'}`);
    enrichedError.status = status;
    enrichedError.provider = ai.provider;
    enrichedError.cause = error;
    serverLog.error('❌ Ошибка в collectAllMessages:', error);
  }
}
/**
 * Собирает список всех сообщений из чата
 */
async function collectAllMessages(page, pauseMs = DEFAULT_PAUSE_MS) {
  try{
    const chatikButton = page.locator('[data-qa="chatikActivator-button"]');
   // await chatikButton.waitFor({ state: 'visible', timeout: 30000 });
    await chatikButton.click();
    //await waitForPause(page, pauseMs);

    const chatFrame = await page.frameLocator('iframe[src*="chatik.hh.ru"]');
    await chatFrame.locator('body')/*.waitFor({ state: 'visible', timeout: 20000 })*/;
    //await waitForPause(page, pauseMs);

    const chatLinks = chatFrame.locator('[data-qa^="chatik-open-chat-"]');
    const messages = [];  

    for (let i = 0; i < 10/*await chatLinks.count()*/; i++) {
      try {
        await chatLinks.nth(i).scrollIntoViewIfNeeded();      
      
        const chatItem = chatLinks.nth(i);          // сначала получаем локатор
        await chatItem.scrollIntoViewIfNeeded();    // скроллим
        await chatItem.click();                     // кликаем
        //await waitForPause(page, pauseMs);
        // Извлекаем заголовок вакансии
        const title = await chatFrame.locator('[data-qa="chat-cell-title"]').nth(i);
        // Извлекаем информацию об авторе
        const from = await chatFrame.locator('[data-qa="chat-cell-subtitle"]').nth(i);
         // Ищем статус по тексту внутри текущего чата — без хэшей
        const time = await chatFrame.locator('[data-qa="chat-cell-creation-time"]').nth(i);
         // Ищем статус по тексту внутри текущего чата — без хэшей     
        const status= chatItem.locator('div', { hasText: /Отклик|Отказ|Собеседование/i });

        let lastMessage = 'Нет сообщений';

        // Пробуем несколько вариантов селекторов — от самого надёжного к запасным
        const candidateLocators = [
        // Вариант 1: явный data-qa для последнего сообщения в ячейке чата (если есть)
        chatFrame.locator('[data-qa="chat-cell-last-message"]'),  
        // Вариант 2: ищем последний пузырёк сообщения и внутри него текст
        chatFrame.locator('[data-qa^="chatik-chat-message"]').last().locator('[data-qa="chat-bubble-text"]'),
        ];

       for (const loc of candidateLocators) {
         try {
          // Ждём, что элемент станет видимым (не ждём вечно, timeout контролируем)
          await loc.waitFor({ state: 'visible', timeout: 8000 });
          const text = await loc.textContent();
          if (text && text.trim() !== '') {
            lastMessage = text.trim();
            break; // нашли — выходим
           }
          // Если этот селектор не сработал — пробуем следующий
         } catch (e) {continue;}
         }
       const titleText = (await title.textContent())?.trim() || 'Без заголовка';
       const fromText = (await from.textContent())?.trim() || 'Неизвестно';
       const timeText = (await time.textContent())?.trim() || 'Неизвестно';
       const statusTextRaw = (await status.first().textContent())?.trim() || 'Неизвестно';
       let statusDisplay = statusTextRaw;
       let statusColor = ''; // можно использовать для CSS-класса или inline-стиля

       if (statusTextRaw.includes('Отклик на вакансию') || statusTextRaw.includes('Собеседование')) {
          statusDisplay = statusTextRaw; // оставляем как есть
          statusColor = 'green';         // или класс 'status-green'
       } else if (statusTextRaw === 'Отказ') {
                 statusDisplay = 'Отказ';
                 statusColor = 'red';                                       // или класс 'status-red'
       } else {statusDisplay = statusTextRaw; statusColor = '';    }        // без цвета
 
       messages.push({title: titleText,
                    from: fromText,
                    lastMessage: lastMessage,
                    time: timeText,
                    status: statusDisplay,
                    statusColor: statusColor // можно использовать в UI (например, как имя класса)
       });
       //await waitForPause(page, pauseMs);
      } catch (error) { serverLog.warn(`⚠️ Ошибка при обработке чата ${i + 1}:`, error.message);  }
     }
    // await waitForPause(page, pauseMs);
     return messages;
    } catch (error) {
      serverLog.error('❌ Ошибка в collectAllMessages:', error);
      // Сохраняем скриншот при ошибке
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = `collectAllMessages-error-${timestamp}.png`;
      try {
        await page.screenshot({ path: screenshotPath });
        serverLog.info(`📸 Скриншот ошибки сохранён: ${screenshotPath}`);
      } catch (screenshotError) {serverLog.error('📸 Не удалось сделать скриншот:', screenshotError);}
    }
 }
/**
 * Экспортирует список сообщений в Excel файл
 */
async function exportMessagesToExcel(messages, filename = 'hh_messages.xlsx') {  
      serverLog.info("Зашли в экспорт excel");
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Сообщения');
      // Создаем шапку таблицы
      worksheet.addRow(['Заголовок вакансии', 'От кого', 'Последнее сообщение', 'Дата и время', 'Статус']); 

     // Данные — передаём просто массив значений в правильном порядке

      messages.forEach(message => {
      const row = worksheet.addRow([message.title,
                                     message.from,
                                     message.lastMessage,
                                     message.time,
                                     message.status]);

      // Получаем ячейку со статусом (индекс 4, т.к. массив 0-based)
      const statusCell = row.getCell(5); // в exceljs нумерация колонок в getCell с 1

      let colorHex = null;

      if (message.status.includes('Отклик на вакансию') || message.status.includes('Собеседование')) {
           colorHex = '00B050'; // зелёный (умеренный, хорошо читается на белом)
       } else if (message.status === 'Отказ') {colorHex = 'C00000';} // тёмно‑красный 

      if (colorHex) {statusCell.font = {color: { argb: colorHex } };}
      //  ещё и фон ячейки: statusCell.fill = { fgColor: { argb: colorHex } };       
     });
      try {
        await workbook.xlsx.writeFile(filename);
        serverLog.info(`✅ Сообщения успешно экспортированы в ${filename}`);
      } catch (error) {serverLog.error('❌ Ошибка при экспорте в Excel:', error.message); }
    }

/**
 * Обрабатывает действие от AI (reply / close / unknown)
 */
async function handleAIAction(frame, aiDecision) {
  if (!aiDecision) {
    serverLog.warn('⚠️ Нет решения от AI — пропускаем обработку действий');
    return;
  }

  if (aiDecision.action === 'reply') {
    const btn = frame.locator('[data-qa="chatik-chat-message-applicant-action"]');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      serverLog.info('✅ Клик по кнопке "Добавить сопроводительное" выполнен');
    } else {
      serverLog.warn('⚠️ Кнопка "Добавить сопроводительное" не найдена');
    }
  } else if (aiDecision.action === 'close') {
    serverLog.info('🤖 AI рекомендует закрыть чат — ничего не делаем');
  } else {
    serverLog.warn(`⚠️ Неизвестное действие от AI: ${aiDecision.action}`);
  }
}


async function fillCustomOption(page, questionText, customText) {
  await selectCheckboxByText(page, questionText, 'Свой вариант');

  const textarea = page.locator(`[data-qa="task-body"]:has-text("${questionText}")`)
    .locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 10000 });
  await textarea.fill(customText);
}

async function fillSalaryField(page) {

  let field = page.locator('textarea').filter({ hasText: 'зарплатные ожидания' });
  // Сначала пробуем дождаться первого варианта
  try {
    await field.waitFor({ state: 'visible', timeout: 60000 });
  } catch (e) {
    // Если не дождались — пробуем альтернативный вариант
    serverLog.warn('Первый вариант поля "зарплатные" не найден, пробуем fallback...');
    field = page.getByLabel('зарплатные ожидания').locator('textarea');
    try {
      await field.waitFor({ state: 'visible', timeout: 30000 });
    } catch (e2) {
      serverLog.warn('Поле зарплатных ожиданий не найдено ни одним способом — заполнение пропущено.');
      return; // выходим, не пытаемся заполнять
    }
  }

  if (await field.isVisible()) {
    await field.fill('200000');
    serverLog.info('Поле зарплатных ожиданий найдено и заполнено.');
  } else {
    serverLog.warn('Поле зарплатных ожиданий не видно — заполнение пропущено.');
  }
}

async function fillTelegramField(page) {

  let field = page.locator('textarea').filter({ hasText: 'телеграм' });
  // Сначала пробуем дождаться первого варианта
  try {
    await field.waitFor({ state: 'visible', timeout: 60000 });
  } catch (e) {
    // Если не дождались — пробуем альтернативный вариант
    serverLog.warn('Первый вариант поля "телеграм" не найден, пробуем fallback...');
    field = page.getByLabel('телеграм').locator('textarea');
    try {
      await field.waitFor({ state: 'visible', timeout: 30000 });
    } catch (e2) {
      serverLog.warn('Поле телеграмне найдено ни одним способом — заполнение пропущено.');
      return; // выходим, не пытаемся заполнять
    }
  }

  if (await field.isVisible()) {
    await field.fill('@ru63_Marie_Martynova');
    serverLog.info('Поле телеграм найдено и заполнено.');
  } else {
    serverLog.warn('Поле телеграм не видно — заполнение пропущено.');
  }
}

async function clickRespond(page, profileContacts, hooks = {}) {
      const buttons = await page.locator('span', { hasText: 'Откликнуться' });
      const count = Math.min(await buttons.count(), 5);
      for (let i = 0; i < 5/*count*/; i++) {
             const responseButton = buttons.nth(i);              
             const vacancy = await extractHhVacancyContext(page, responseButton);
             await db.createApplicationWithChat({
                        vacancy: vacancy.vacancyTitle || 'Неизвестная вакансия',
                        company: vacancy.company || 'Неизвестная компания',
                        is_viewed: false,
                        employer_status: 'Не просмотрен',
                        response_rate: 0,
                        chat_url: vacancy.vacancyUrl || page.url(),
                        boost_url: vacancy.conversationUrl || page.url(),
                        applied_at: new Date().toISOString(),
                       },
                      {
                        external_id: vacancy.vacancyId,
                        conversation_url: vacancy.conversationUrl || page.url(),
                        company: vacancy.company || 'Неизвестная компания',
                        status: 'UNKNOWN',
                        applied_at: new Date().toISOString(),
                      })
                     .then(({ chatId, applicationId }) => {serverLog.info(`✅ Создан чат #${chatId}, отклик #${applicationId} для вакансии "${vacancy.vacancyTitle}"`);})
                     .catch(err => serverLog.error(`❌ Ошибка записи в БД: ${err.message}`));

             await responseButton.click();
             serverLog.info('✅ Клик по кнопке отклика выполнен. Ждём появления модалки с textarea');

             // Ждём появления модалки с textarea (или кнопку отправки),
             // но с таймаутом — модалка может и не появиться (прямой отклик)
             const modalOverlay = page.locator('[data-qa="modal-overlay"]');
             const possibleLabels = ['Сопроводительное письмо',
                                     'Почему именно ваша кандидатура должна заинтересовать работодателя',
                                     'Расскажите о себе',
                                    ];
             const regex = new RegExp(possibleLabels.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),  'i');

             // Ищем label и textarea внутри модалки, а не по всей странице
             const modalContent = modalOverlay;
             const labelLocator = modalContent.locator('label').filter({ hasText: regex });
             const vacancyTitle = vacancy.vacancyTitle;
             const contactInfo = {
                    phone: profileContacts.phone,
                    email: profileContacts.email,
                    telegram: profileContacts.telegram,
                    maxLink: profileContacts.max,
                  };

             const coverLetterText = generateCoverLetter(vacancyTitle, contactInfo);
             console.log(coverLetterText);
             // Единая кнопка отправки — оба варианта data-qa
             const submitButton = page.locator('[data-qa="vacancy-response-letter-submit"], [data-qa="vacancy-response-submit-popup"]');

      // Ждём появления модалки с таймаутом 15 сек
      let modalAppeared = false;
      try {
        await modalOverlay.waitFor({ state: 'visible', timeout: 15000 });
        modalAppeared = true;
        serverLog.info('✅ Модальное окно открыто');
        // Проверяем, есть ли textarea в модалке — если нет, значит, можно сразу сабмитить
        const textarea = page.locator('[data-qa="vacancy-response-letter-input"]'); // подставь свой селектор
        serverLog.info('Проверяем, есть ли textarea в модалке — если нет, значит, можно сразу сабмитить');
        const isTextareaPresent = await textarea.isVisible({ timeout: 2000 }).catch(() => false);
        serverLog.info('Если вакансия в другой стране');
  
        if (!isTextareaPresent) {
            serverLog.info('extarea не найден в модалке — кликаем Submit напрямую');
            await submitButton.click();
            // Сохраняем успешный результат в базу   
            return; // дальше не идём, форма уже отправлена
        }
      } catch { serverLog.info('Модальное окно не появилось — возможно, отклик отправлен напрямую');}

      if (modalAppeared) {
        // Ждём появления textarea (с таймаутом)
        let textarea;
        try {
         // Сначала пробуем найти через aria-labelledby
         const labelEl = labelLocator.first();
         await labelEl.waitFor({ state: 'visible', timeout: 10000 });
         const labelId = await labelEl.getAttribute('id');
         if (labelId) {textarea = page.locator(`textarea[aria-labelledby="${labelId}"]`);
         } else { // Запасной вариант — просто textarea внутри модалки
          textarea = modalContent.locator('textarea');
         }

         await textarea.waitFor({ state: 'visible', timeout: 10000 });
         await textarea.fill(coverLetterText);
         serverLog.info('✅ Сопроводительное письмо введено');
        } catch (e) {
          serverLog.warn(`⚠️ Не удалось найти/заполнить textarea: ${e.message}`);
         // Если textarea нет, возможно, модалка другого типа — пробуем всё равно нажать кнопку
        }
        // Ждём кнопку отправки и кликаем
        await submitButton.waitFor({ state: 'visible', timeout: 30000 });
        const isEnabled = await submitButton.isEnabled();
        serverLog.info(`🔍 Кнопка отправки активна: ${isEnabled}`);

        if (!isEnabled) {
          serverLog.warn('⚠️ Кнопка отправки не активна — возможно, письмо не заполнено или есть валидация');
          // Ждём активации
          await submitButton.waitFor({ state: 'visible', timeout: 15000 });
        }

        await submitButton.click({ timeout: 10000 });
        serverLog.info('✅ Клик по кнопке отправки выполнен');

        // Ждём закрытия модалки — подтверждение, что отклик ушёл
        await modalOverlay.waitFor({ state: 'detached', timeout: 30000 });
        serverLog.info('✅ Модальное окно закрыто — отклик отправлен');
      
      } else {
      // Если модалки не было — возможно, отклик уже отправлен
      // Проверяем, не появилась ли кнопка отправки напрямую
      try {
        await submitButton.waitFor({ state: 'visible', timeout: 5000 });
        await submitButton.click({ timeout: 10000 });
        serverLog.info('✅ Клик по кнопке отправки (без модалки)');
        } catch {serverLog.info('Кнопка отправки не найдена — отклик, вероятно, уже отправлен');  }
      }

      // Небольшая пауза перед следующей итерацией
      await page.waitForTimeout(2000);
               
      // Ждём появления новой страницы (с таймаутом)
      let newPage = null;
      try {
          newPage = await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error('timeout')), 60000);
          context.on('page', (p) => {
          clearTimeout(timeoutId);
          resolve(p);  });
          });
          await newPage.waitForLoadState('networkidle', { timeout: 30000 });
          await fillSalaryField(newPage);
          await fillTelegramField(newPage);
      } catch (e) {serverLog.warn('Новая страница не открылась (таймаут или событие не сработало). Пропускаем заполнение полей.');}
      // await handleCoverLetterToggle(page);
      // Использование:
      await retry(() => handleCoverLetterToggle(page, email, vacancy.vacancyTitle));
      await page.waitForTimeout(6000);
              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=136463514&startedWithQuestion=false&hhtmFrom=main
              //Senior Data Engineer в Онлайн-школа Тетрика
              //Ищем textarea, у которого родитель (или сосед) содержит текст «зарплатные ожидания»      
              
              //ПАО БАНК УРАЛСИБ Разработчик Java (Кредитный конвейер, Camunda)
              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=136873586&startedWithQuestion=false&hhtmFrom=main

              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=136463514&startedWithQuestion=false&hhtmFrom=main

              //Senior Data Engineer в Онлайн-школа Тетрика
              //Ищем textarea, у которого родитель (или сосед) содержит текст «зарплатные ожидания»   

              //Мидл+ Промпт/AI инженер Точка банк
              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=136834106&startedWithQuestion=false&hhtmFrom=main

              //Аналогично для Telegram
              //const telegramField = page.locator("textarea").filter(new Locator.FilterOptions().setHasText("телеграм"));

              //salaryField.waitFor(new Locator.WaitOptions().setState(WaitState.VISIBLE));
              //telegramField.waitFor(new Locator.WaitOptions().setState(WaitState.VISIBLE));

              //salaryField.fill("200000");
              //telegramField.fill("@ru63_Marie_Martynova");
              //await page.waitForTimeout(6000); 
              //serverLog.info(`   Откликаемся ${i} раз`);  

              //AI Skills Engineer (AI Software)
              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=135590356&startedWithQuestion=false&hhtmFrom=main
              // fillHhTaskForm(page);
              
              // Для вакансии ML-инженер
              //https://samara.hh.ru/vacancy/135559263?hhtmFrom=vacancy_response
              // поле зарплатные ожидания
              // const textarea2 = page.locator('textarea[name="task_74126939_text"]');    
              // Сначала ждём, что элемент существует и стал видимым/доступным
              // await textarea2.waitFor({ state: 'visible', timeout: 60000 });
              // await textarea2.waitFor({ state: 'enabled', timeout: 60000 });           
              // await textarea2.click();
              // await page.waitForTimeout(6000);
              // await textarea2.type('200000');
              //Для вакансии Java-разработчик (Senior) Notamedia
              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=135594156&startedWithQuestion=false&hhtmFrom=main

              // --- ШАГ 2: Дожидаемся URL анкеты ---
            /*serverLog.info('🌐 Дожидаемся URL анкеты ...');
              await page.waitForURL(/\/applicant\/vacancy_response\?/, { timeout: 20000 });    
              await page.waitForTimeout(6000);
    
              // --- ШАГ 3: Дожидаемся появления вопросов ---
              serverLog.info('📝 Дожидаемся появления вопросов...');
              await page.locator('[data-qa="task-body"]').first().waitFor({ state: 'visible', timeout: 20000 });
              await page.waitForTimeout(6000);
    
             // --- ШАГ 4: Заполняем опыт ---
              await selectCheckboxByLabelText(page, '3 - 5 лет');
    
             // --- ШАГ 5: Заполняем модули Spring ---
              const springModules = ['Boot', 'Data', 'Security'];
              for (const module of springModules) {  await selectCheckboxByLabelText(page, module); }
    
              // --- ШАГ 6: Заполняем брокеры очередей ---
              await selectCheckboxByLabelText(page, 'Kafka');    
              serverLog.info('✅ Form filled successfully!');
              */
              // Для вакансии Эксперт-разработчик Javaс от ПАО БАНК УРАЛСИБ
              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=135588103&startedWithQuestion=false&hhtmFrom=main
              //Сложная форма вакансии DataEnginer
              //https://samara.hh.ru/applicant/vacancy_response?vacancyId=136079590&startedWithQuestion=false&hhtmFrom=main
  }
}

async function fillHhTaskForm(page) {
  // 1. «Готов(а) ли ты выполнить тестовое задание…» → выбираем «да»
  await page.getByRole('radio', { name: 'да' }).check({ force: true });

  await page.waitForTimeout(6000);  

  // 2. «Уточни свой логин в Телеграме…» → текстовое поле
  // Селектор по name из разметки: name="task_363041108_text"
  await page.fill('textarea[name="task_363041108_text"]', '@ru63_Marie_Martynova');

  await page.waitForTimeout(6000);  

  // 3. «Есть ли у тебя опыт разработки…» → текстовое поле
  await page.fill('textarea[name="task_363041109_text"]', 'Java (Spring Boot, JMIX), микросервисная архитектура. Автоматизация (Playwright + Node.js), интеграция AI‑компонентов. Уровень: Middle+/Senior в зависимости от стека.');

  // 4. «Перечисли, какие нейросети используешь…» → текстовое поле
  await page.fill('textarea[name="task_363041110_text"]', 
  '- ChatGPT/OpenAI API: генерация кода, тесты, документация, AI‑агенты.\n- KodaCode: агент‑управляемая разработка, JMIX‑скиллы.\n- YOLO: детекция объектов, обучение моделей.\n- BI‑инструменты: аналитика метрик автоматизации, дашборды.'
);

  // 5. «Опыт создания скиллов для AI‑агентов…» → текстовое поле
  await page.fill('textarea[name="task_363041111_text"]', 
    'Да. Примеры скиллов: Регистрация на hh.ru + обработка кода подтверждения (IMAP).Анализ литературных диалогов: темы, участники, имена (2–3 слайда концепции).\n- Оптимизация моделей: квантование, прунинг под CPU/GPU. Ссылки: https://github.com/martynova0063-sudo/mms_test_repository'
);

  // 6. «Полная или частичная занятость?» → чекбоксы
  // Выбираем «полная» (по тексту в ячейке)
  await page.getByLabel('полная').check({ force: true });
  
  // --- (Если в форме есть пункты 7 и 8, добавь их аналогично) ---
  // Например, если есть радиокнопки «ИП/ГПХ» и поле зарплаты:
   await page.getByRole('radio', { name: 'ИП/ГПХ' }).check();
   await page.fill('input[name="salary"]', '200000');

   // Если нужно снять другой чекбокс (если оба могут быть активны) — раскомментируй:
   await page.getByLabel('частичная').uncheck({ force: true });

   serverLog.info('Форма заполнена.');
}
/**
 * Основной flow регистрации в каталоге
 */
async function registerInDirectory(
  browserInit,
  directoryUrl,
  websiteData,
  email,
  apppassword,
  pauseMs,
  manualCodeInput,
  hooks = {},
) {
  const dirName = directoryUrl.split('/').pop() || directoryUrl;
  serverLog.info(`═══════════════════════════════════════════════════`);
  serverLog.info(`🚀 НАЧАЛО РЕГИСТРАЦИИ: ${dirName}`);
  serverLog.info(`   Сайт: ${websiteData.website}`);
  serverLog.info(`   Каталог: ${directoryUrl}`);
  serverLog.info(`   Email: ${email}`);
  serverLog.info(`═══════════════════════════════════════════════════`);

  const page = browserInit.getPage();
  await db.init(); // <-- добавить эту строку

  // Объявляем переменные до try/catch, чтобы они были доступны в catch
  let login = email;
  let password = Math.random().toString(36).slice(-8);
  let profileUrl = directoryUrl;

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  try {
    // Шаг 1: Открытие страницы каталога
    serverLog.info(`📄 Шаг 1: Открытие страницы каталога...`);
    serverLog.info(`   URL: ${directoryUrl}`);
    await page.goto(directoryUrl, { waitUntil: 'domcontentloaded', timeout: 0 });

    // дальнейшие действия агента...
    serverLog.info(`   ✅ Страница загружена`);
    serverLog.info(`   Текущий URL: ${page.url()}`);

    // Определяем домен (СРАЗУ после загрузки)
    const domain = page.url().replace(/^https?:\/\//, '').split('/')[0];

    // Для Flado ждём полной загрузки (включая favicon и картинки)
    if (domain.includes('flado')) {
      serverLog.info(`   ⏳ Для Flado ждём полную загрузку (favicon, картинки)...`);
      await page.reload({ waitUntil: 'load', timeout: 6000});
      await page.waitForTimeout(2000);
      serverLog.info(`   ✅ Полная загрузка завершена`);
    }

    // Для HH ждём полной загрузки (включая favicon и картинки)
    if (domain.includes('hh')) {     
      // Ждём появления кнопки «Войти» и нажимаем её
       await page.waitForSelector('button[data-qa="submit-button"]');
       await page.click('button[data-qa="submit-button"]');
       serverLog.info(`   ✅ Нажата кнопка «Войти»`);      

      //await page.waitForSelector('label.magritte-segment-wrapper___5l67i_2-1-32:has(input[data-qa="credential-type-email"])', { timeout: 0 });
      //await page.click('label.magritte-segment-wrapper___5l67i_2-1-32:has(input[data-qa="credential-type-email"])', { force: true });

       const locator = page.locator('input[data-qa="credential-type-email"]');
       await locator.waitFor({ state: 'visible', timeout: 30000 });
       await locator.click({ force: true });

       // Ждём появления поля email (подбирай селектор по data-qa или placeholder)
       await page.waitForSelector('input[data-qa="applicant-login-input-email"]', { timeout: 0 });

       // Вводим email
       await page.fill('input[data-qa="applicant-login-input-email"]', email);

      // Нажимаем кнопку «Дальше» по тексту внутри span
       await page.waitForSelector('button[data-qa="submit-button"]', { timeout: 0 });

       await page.click('button[data-qa="submit-button"]', { force: true });
       serverLog.info(`   ✅ Email введён, кнопка «Дальше» нажата`);
       await page.waitForTimeout(9000);
       const pinInput = await page.locator('[data-qa="magritte-pincode-input-field"]');         
      serverLog.info(`   📝 Введите код подтверждения вручную`);
      await page.waitForTimeout(9000); // даём компоненту время на реакцию   
      const confirmationCode = '0000';
      if (!manualCodeInput) {confirmationCode=getConfirmationCode(email, 'imap.gmail.com', '993', apppassword, page, pinInput); }    
      const profileContacts = await extractProfileContacts(page);
      await page.waitForTimeout(9000);
      console.log(`Контакты профиля: ${profileContacts.phone || '—'} | ${profileContacts.email || '—'}`);
      await page.click('a.supernova-logo-wrapper');
      await clickRespond(page, profileContacts, hooks);
      //Обновление всей страницы
      await page.click('a.supernova-logo-wrapper');
    //await clickRespond(page, hooks);
    //await page.click('a.supernova-logo-wrapper');
    //await clickRespond(page, hooks);
  //  await page.getByText('Отклики', { exact: true }).click();
    //  Обход всех откликов, извлечение и сохранение
   // await processAllNegotiationsWithPagination(page, db, extractAllHhVacancyContext);
    //await processAllNegotiations(page, db, extractAllHhVacancyContext);
    // Добавляем экспорт сообщений перед анализом чата
    serverLog.info('📊 Собираем список всех сообщений...');
    //const allMessages = await collectAllMessages(page);
    const allMessages =await retry(() => collectAllMessages(page));
        
    await exportMessagesToExcel(allMessages);
      
     lastMessageText = await extractLastChatMessage(page);
     serverLog.info('🤖 Анализируем чат с помощью AI...');
     result= await analyzeChatWithAI(lastMessageText);
     await page.waitForTimeout(6000); 
/*const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
  },
  body: JSON.stringify({
    model: "llama-3.3-70b-versatile", //"llama-3.1-8b-instant",
    messages: [
      {
        role: "system",
        content: 'Вот непрочитанные сообщения из чата:\n${lastMessageText}. Проанализируй.'
      },
      {
        role: "user",
        content: `Вот непрочитанные сообщения из чата:\n${lastMessageText}`      }
    ],
    max_tokens: 512,
  }),
});*/
/*try {
  // Правильный путь: data.choices[0].message.content — это уже строка (JSON)
  const rawContent = data.choices?.[0]?.message?.content;
  await page.waitForTimeout(6000); 
  aiDecision = JSON.parse(rawContent);
  serverLog.info('🧠 Решение от AI:', aiDecision);
} catch (e) {
  serverLog.error('❌ Не удалось распарсить JSON от AI:', e.message);
  serverLog.error('Raw content:', data.choices?.[0]?.message?.content);
 // throw e; // или верни fallback-решение, если не хочешь прерывать скрипт
}*/
if (aiDecision.action === 'reply') {
        // Пример: открыть форму сопроводительного письма
        const btn = frame.locator('[data-qa="chatik-chat-message-applicant-action"]');
        await btn.waitFor({ state: 'visible', timeout: 10000 });
        const isBtnVisible = await btn.isVisible().catch(() => false);
        if (isBtnVisible) {
          await btn.click();
          serverLog.info('✅ Клик по кнопке "Добавить сопроводительное" выполнен');
        } else {
          serverLog.warn('⚠️ Кнопка "Добавить сопроводительное" не найдена');
        }
      } else if (aiDecision.action === 'close') {serverLog.info('🤖 AI рекомендует закрыть чат — ничего не делаем');
      } else { serverLog.warn(`⚠️ Неизвестное действие от AI: ${aiDecision.action}`);}
      // ---------------------------------------------------------
      serverLog.info('🔘 Ищем кнопку "Добавить сопроводительное"...');
      // Дальше твой существующий код...
      const btn = frame.locator('[data-qa="chatik-chat-message-applicant-action"]');
      await page.waitForTimeout(6000);
      const isVisible1 = await btn.isVisible().catch(() => false);

      if (!isVisible1) {
        serverLog.error('❌ Кнопка "Добавить сопроводительное" не найдена.');
      } else {
        serverLog.info('✅ Кнопка найдена, выполняем клик...');
        await btn.click();
        serverLog.info('🆗 Клик выполнен — ждём появления формы сопроводительного письма...');
      }       
      /*
      Вы копируете текст сообщения от кандидата или фрагмент резюме из чата hh.ru и вставляете его в окно ChatGPT. 
      Нейросеть проанализирует текст: поможет составить ответ, выделит ключевые навыки, сгенерирует уточняющий вопрос или подскажет, как лучше структурировать диалог. 
       */
      /*Вы настраиваете отдельную автоматизацию вне hh.ru. 
      Например, через сервисы вроде n8n или ApiMonster можно связать вебхуки hh.ru (которые присылают данные об откликах) с API ChatGPT. Тогда система сама будет забирать данные из чата/откликов, 
      отправлять их в нейросеть для анализа (оценка релевантности, генерация черновика ответа) и даже возвращать результат обратно в вашу CRM или рабочий канал. 
       */
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
    profileUrl = getProfileUrl(page.url());

    serverLog.info(`🔐 Сгенерированы учётные данные:`, { login, password });
    serverLog.info(`🔗 URL профиля после регистрации: ${profileUrl}`);

    // Шаг 3: Заполнение формы
    serverLog.info(`📝 Шаг 3: Заполнение формы регистрации...`);

    const siteSelectors = getSiteSelectors(domain, websiteData, email);

    // Заполняем password для сайтов, где это необходимо
    siteSelectors.forEach(sel => {
      if (sel.name === 'password' || sel.name === 'password2' || sel.name === 'password_confirm') {
        sel.fill = password;
      }
    });

    const { fieldsFilled, fieldsSkipped } = await fillForm(page, siteSelectors, websiteData, email, domain);

    // Дополнительное заполнение для iRecommend через JavaScript
    if (domain.includes('irecommend')) {
      await fillIrecommendWithJS(page, email, password);
    }

    // Дополнительное заполнение для Orgpage через JavaScript
    if (domain.includes('orgpage')) {
      await fillOrgpageWithJS(page, websiteData, email, password);
    }

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
      await handleCataloxyCheckboxes(page);
    }
    else if (domain.includes('orgpage')) {
      await handleOrgpageCheckboxes(page);
    }
    else if (domain.includes('irecommend')) {
      await handleIrecommendCheckboxes(page);
    }

    // Шаг 5: Отправка формы (заглушка - реальная логика зависит от сайта)
    serverLog.info(`📤 Шаг 5: Отправка формы...`);
    // TODO: добавить логику отправки формы

    serverLog.info(`✅ Регистрация завершена для: ${dirName}`);
    return { login, password, profileUrl };

  } catch (error) {
    serverLog.error(`❌ Ошибка регистрации в ${dirName}: ${error.message}`);
    throw error;
  }
  await browser.close();
}



module.exports = {
  registerInDirectory,
};
