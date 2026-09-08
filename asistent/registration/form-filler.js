const { serverLog } = require('../logger');

/**
 * Заполнение полей формы регистрации
 */
async function fillForm(page, siteSelectors, websiteData, email, domain) {
  let fieldsFilled = 0;
  let fieldsSkipped = 0;

  // Для iRecommend и Orgpage используем замедленное заполнение
  const isIRecommend = domain.includes('irecommend');
  const isOrgpage = domain.includes('orgpage');
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
          customFilled = await fillPasswordConfirm(page, selector, fillDelay);
        }
        // Для name (Flado) ищем label с текстом "Имя"
        else if (selector.name === 'name') {
          customFilled = await fillNameField(page, selector, fillDelay);
        }

        if (customFilled) {
          fieldsFilled++;
        } else {
          serverLog.warn(`   ⚠️ Поле "${selector.name}" не найдено`);
          fieldsSkipped++;
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

          // Пауза 10 секунд после заполнения ИНН для B2B-Center
          if (selector.name === 'inn' && domain.includes('b2b-center')) {
            serverLog.info(`   ⏳ Пауза 10 секунд после заполнения ИНН...`);
            await page.waitForTimeout(10000);
          }

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
      filled = await fillIrecommendViaLabel(page, selector, websiteData, email);
      if (filled) fieldsFilled++;
    }

    if (!filled) {
      serverLog.debug(`   ℹ️ Поле "${selector.name}" не найдено — пропускаем`);
      fieldsSkipped++;
    }
  }

  serverLog.info(`📊 Заполнено полей: ${fieldsFilled} из ${fieldsFilled + fieldsSkipped}`);
  return { fieldsFilled, fieldsSkipped };
}

/**
 * Заполнение поля подтверждения пароля (через label или поиск)
 */
async function fillPasswordConfirm(page, selector, fillDelay) {
  let customFilled = false;

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
        return true;
      }
    }
  }

  // Способ 2: Если не нашли через label, ищем второй password input на странице
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
    return true;
  }

  // Способ 3: Ищем по name/autocomplete атрибутам
  const confirmInput = await page.$('input[name="password_confirm"]:visible, input[name="confirm_password"]:visible, input[name="password_confirmation"]:visible, input[name="password2"]:visible, input[autocomplete="new-password"]:visible');
  if (confirmInput) {
    await confirmInput.click();
    await page.waitForTimeout(fillDelay);
    await confirmInput.fill('');
    await page.waitForTimeout(fillDelay);
    await confirmInput.fill(selector.fill);
    serverLog.info(`   ✅ Поле "${selector.name}" заполнено через name/autocomplete: ${String(selector.fill).slice(0, 20)}`);
    return true;
  }

  return false;
}

/**
 * Заполнение поля "Имя" (через label или поиск)
 */
async function fillNameField(page, selector, fillDelay) {
  let customFilled = false;

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
        return true;
      }
    }
  }

  // Способ 2: Если не нашли через label, ищем по стандартным селекторам
  for (const sel of selector.selectors) {
    try {
      const element = await page.$(sel);
      if (element) {
        await page.fill(sel, selector.fill);
        serverLog.info(`   ✅ Поле "${selector.name}" заполнено (селектор): ${String(selector.fill).slice(0, 20)}`);
        return true;
      }
    } catch (error) {
      serverLog.debug(`   ⚠️ Селектор "${sel}" не сработал: ${error.message}`);
    }
  }

  return false;
}

/**
 * Заполнение полей iRecommend через label
 */
async function fillIrecommendViaLabel(page, selector, websiteData, email) {
  try {
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
            return true;
          }
        }
      }
    }

    // Fallback: пробуем заполнить по ID для iRecommend
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
        return true;
      }
    }
  } catch (labelErr) {
    serverLog.debug(`   ⚠️ Не удалось найти через label: ${labelErr.message}`);
  }
  return false;
}

/**
 * Дополнительное заполнение для iRecommend через JavaScript
 */
async function fillIrecommendWithJS(page, email, password) {
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

    let fieldsFilled = 0;
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

    return fieldsFilled;
  } catch (err) {
    serverLog.error(`   ⚠️ Ошибка JavaScript заполнения: ${err.message}`);
    await page.screenshot({ path: 'irecommend-error.png', fullPage: false });
    return 0;
  }
}

/**
 * Дополнительное заполнение для Orgpage через JavaScript
 */
async function fillOrgpageWithJS(page, websiteData, email, password) {
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

    let fieldsFilled = 0;
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

    return fieldsFilled;
  } catch (err) {
    serverLog.error(`   ⚠️ Ошибка JavaScript заполнения: ${err.message}`);
    await page.screenshot({ path: 'orgpage-error.png', fullPage: false });
    return 0;
  }
}

module.exports = {
  fillForm,
  fillIrecommendWithJS,
  fillOrgpageWithJS,
};
