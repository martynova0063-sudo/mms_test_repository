const { chromium } = require('playwright');

(async () => {
  try {
    console.log('Запуск Chromium...');
    const browser = await chromium.launch({ headless: false });
    console.log('Браузер запущен!');

    const page = await browser.newPage();
    await page.goto('https://example.com');
    await page.screenshot({ path: 'verification.png' });
    console.log('Скриншот сохранён: verification.png');

    await browser.close();
    console.log('Тест успешно завершён!');
  } catch (error) {
    console.error('Ошибка:', error);
  }
})();
