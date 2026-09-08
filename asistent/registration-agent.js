const BrowserInitializer = require('./browser-initializer');
const EmailParser = require('./registration/email-parser');
const RegistrationDB = require('./registration-db');
const { serverLog } = require('./logger');
const { parseWebsiteData } = require('./registration/website-parser');
const { registerInDirectory } = require('./registration/registration-flow');

const DEFAULT_PAUSE_MS = 6000;

function normalizePauseMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PAUSE_MS;
  return Math.min(120000, Math.max(0, Math.round(parsed)));
}

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
    return await parseWebsiteData(this.browserInit, websiteUrl);
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

  async registerInDirectory(directoryUrl, websiteData, email, imapHost, port, apppassword, pauseMs, manualCodeInput) {
    const result = await registerInDirectory(
      this.browserInit,
      directoryUrl,
      websiteData,
      email,
      apppassword,
      pauseMs,
      manualCodeInput
    );
    // Функция возвращает { login, password, profileUrl }, добавляем success flag
    return { ...result, success: true };
  }

  async runRegistration(
    website,
    email,
    imapHost,
    port,
    apppassword,
    directories,
    taskIds = [],
    taskCallbacks = null,
    pauseMs = DEFAULT_PAUSE_MS,
    manualCodeInput = true
  ) {
    const startTime = Date.now();
    const EmailParser = require('./registration/email-parser');
    const normalizedPauseMs = normalizePauseMs(pauseMs);

    const allDirs = await this.db.getAllDirectories();
    const directoriesArray = Array.isArray(directories) ? directories : [directories];

    const testCount = directoriesArray.filter(url => {
      const dir = allDirs.find(d => d.url === url);
      return dir && dir.is_test;
    }).length;
    const regularCount = directoriesArray.length - testCount;

    serverLog.info(`═══════════════════════════════════════════════`);
    serverLog.info(`🏁 ЗАПУСК РЕГИСТРАЦИИ`);
    serverLog.info(`   Сайт: ${website}`);
    serverLog.info(`   Email: ${email}`);
    serverLog.info(`   Каталогов: ${directoriesArray.length} (обычных: ${regularCount}, тестовых: ${testCount})`);
    serverLog.info(`   IMAP: ${imapHost}:${port}`);
    serverLog.info(`   Пауза между действиями: ${normalizedPauseMs} мс`);
    serverLog.info(`═══════════════════════════════════════════════`);

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
      const password = Math.random().toString(36).slice(-8);

      for (let i = 0; i < directoriesArray.length; i++) {
        const directory = directoriesArray[i];
        serverLog.info(`\n📌 Прогресс: ${i + 1}/${directoriesArray.length} каталогов`);

        const taskInfo = taskIds.find(t => t.dirUrl === directory);
        const taskId = taskInfo ? taskInfo.taskId : null;

        if (taskId && taskCallbacks) {
          taskCallbacks.updateStatus(taskId, 'active', Math.round((i / directoriesArray.length) * 100), 'Начало регистрации');
        }

        try {
          const result = await this.registerInDirectory(
            directory,
            websiteData,
            email,
            imapHost,
            port,
            apppassword,
            normalizedPauseMs,
            manualCodeInput
          );
          
          // Сохраняем успешный результат в базу
          await this.db.saveRegistrationData(
            website,
            email,
            result.login,
            result.password,
            result.profileUrl,
            'success',
            websiteData.name,
            directory,
            null
          );
          
          results.push(result);
          if (result.success) {
            successCount++;
            if (taskId && taskCallbacks) {
              taskCallbacks.completeTask(taskId, 'success', null);
            }
          } else {
            errorCount++;
            if (taskId && taskCallbacks) {
              taskCallbacks.completeTask(taskId, 'error', 'Ошибка регистрации');
            }
          }
        } catch (err) {
          serverLog.error(`❌ Ошибка регистрации в ${directory}: ${err.message}`);
          errorCount++;
          if (taskId && taskCallbacks) {
            taskCallbacks.completeTask(taskId, 'error', err.message);
          }

          await this.db.saveRegistrationData(
            website,
            email,
            email,
            password,
            null,
            'error',
            websiteData.name,
            directory,
            err.message
          );
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const elapsedTime = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
      serverLog.info(`\n═══════════════════════════════════════════════`);
      serverLog.info(`🏁 РЕГИСТРАЦИЯ ЗАВЕРШЕНА`);
      serverLog.info(`   Успешно: ${successCount}/${directoriesArray.length}`);
      serverLog.info(`   Ошибки: ${errorCount}/${directoriesArray.length}`);
      serverLog.info(`   Время: ${elapsedTime} мин.`);
      serverLog.info(`═══════════════════════════════════════════════`);

      return {
        success: successCount > 0,
        total: directoriesArray.length,
        successCount,
        errorCount,
        results
      };
    } catch (error) {
      serverLog.error(`❌ Критическая ошибка регистрации: ${error.message}`);
      throw error;
    } finally {
      await this.cleanup();
    }
  }
}

module.exports = RegistrationAgent;
