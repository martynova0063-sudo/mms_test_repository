const { chromium } = require('playwright');

class BrowserInitializer {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async initialize() {
    try {
      console.log('Запуск браузера...');
      this.browser = await chromium.launch({
        headless: false,
        slowMo: 100,
        args: ['--start-maximized'],
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
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

  getPage() {
    if (!this.page) {
      throw new Error('Страница не инициализирована. Сначала вызовите initialize().');
    }
    return this.page;
  }

  async cleanup() {
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

module.exports = BrowserInitializer;
