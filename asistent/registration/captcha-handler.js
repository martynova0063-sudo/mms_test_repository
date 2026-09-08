const { serverLog } = require('../logger');

/**
 * Обработка CAPTCHA и чекбоксов согласия для разных сайтов
 */

/**
 * Обработка чекбоксов для Cataloxy
 */
async function handleCataloxyCheckboxes(page) {
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

/**
 * Обработка чекбоксов для Orgpage
 */
async function handleOrgpageCheckboxes(page) {
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
}

/**
 * Обработка чекбоксов для iRecommend
 */
async function handleIrecommendCheckboxes(page) {
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
            if (text.includes('не робот') || text.includes('not a robot') || text.includes('captcha')) {
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
      'input[type="checkbox"][name*="agree"]:visible',
      'input[type="checkbox"][name*="consent"]:visible',
    ];

    for (const selector of agreementSelectors) {
      try {
        const checkbox = await page.$(selector);
        if (checkbox) {
          await checkbox.check();
          serverLog.info(`   ✅ Чекбокс согласия отмечен: ${selector}`);
          agreementChecked = true;
          break;
        }
      } catch (e) {
        serverLog.debug(`   ⚠️ Селектор "${selector}" не сработал`);
      }
    }

    // Fallback: ищем по тексту label
    if (!agreementChecked) {
      const agreeLabel = await page.$('label:has-text("соглашение"), label:has-text("согласен"), label:has-text("принимаю")');
      if (agreeLabel) {
        const checkbox = await agreeLabel.$('input[type="checkbox"]');
        if (checkbox) {
          await checkbox.check();
          serverLog.info(`   ✅ Чекбокс согласия отмечен через label`);
          agreementChecked = true;
          break;
        }
      }
    }

    if (!agreementChecked && agreementAttempts < maxAgreementAttempts) {
      await page.waitForTimeout(2000);
    }
  }

  if (!agreementChecked) {
    serverLog.warn(`   ⚠️ Не удалось отметить чекбокс согласия`);
  }
}

module.exports = {
  handleCataloxyCheckboxes,
  handleOrgpageCheckboxes,
  handleIrecommendCheckboxes,
};
