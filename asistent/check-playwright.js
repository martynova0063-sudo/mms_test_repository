const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    await page.goto('https://example.com');
    await page.screenshot({ path: 'check-playwright.png' });
    console.log('✅ Playwright работает корректно!');
    console.log('Скриншот сохранён: check-playwright.png');
  } catch (error) {
    console.error('❌ Ошибка:', error);
  } finally {
    await browser.close();
  }
})();
