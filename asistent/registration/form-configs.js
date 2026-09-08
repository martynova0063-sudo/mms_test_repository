const { serverLog } = require('../logger');

/**
 * Конфигурации форм для каждого каталога
 * Содержит селекторы полей и специфическую логику заполнения
 */

/**
 * Получение селекторов полей для конкретного домена
 */
function getSiteSelectors(domain, websiteData, email) {
  if (domain.includes('cataloxy')) {
    return getCataloxySelectors(email, websiteData);
  }
  else if (domain.includes('orgpage')) {
    return getOrgpageSelectors(email, websiteData);
  }
  else if (domain.includes('b2b-center')) {
    return getB2bCenterSelectors(email, websiteData);
  }
  else if (domain.includes('irecommend')) {
    return getIrecommendSelectors(email);
  }
  else if (domain.includes('flado')) {
    return getFladoSelectors(email, websiteData);
  }
  else if (domain.includes('flagma')) {
    return getFlagmaSelectors(email, websiteData);
  }
  else {
    return getDefaultSelectors(email, websiteData);
  }
}

/**
 * Универсальные селекторы (по умолчанию)
 */
function getDefaultSelectors(email, websiteData) {
  return [
    { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible', 'input[type="password2"]:visible'], fill: Math.random().toString(36).slice(-8) },
    { name: 'login', selectors: ['input[name="login"]:visible', 'input[name="newlogin"]:visible'], fill: Math.random().toString(36).slice(-8) + 'login' },
    { name: 'email', selectors: ['input[name="email"]:visible', 'input[type="email"]:visible'], fill: email },
    { name: 'name', selectors: ['input[name="name"]:visible', 'input[name="username"]:visible'], fill: websiteData.name },
    { name: 'address', selectors: ['input[name="address"]:visible'], fill: websiteData.address },
    { name: 'phone', selectors: ['input[name="phone"]:visible'], fill: websiteData.phone },
    { name: 'city', selectors: ['input[name="city"]:visible', 'input[name="cityTitle"]:visible'], fill: websiteData.address },
    { name: 'inn', selectors: ['input[name="inn"]:visible'], fill: websiteData.inn },
    { name: 'CatalogDescription', selectors: ['textarea[name="CatalogDescription"]:visible'], fill: websiteData.name },
    { name: 'FullDescription', selectors: ['textarea[name="FullDescription"]:visible'], fill: websiteData.description },
  ];
}

/**
 * Cataloxy.ru
 */
function getCataloxySelectors(email, websiteData) {
  return [
    { name: 'email', selectors: ['input[name="email"]:visible'], fill: email },
    { name: 'name', selectors: ['input[name="name"]:visible'], fill: websiteData.name },
    { name: 'password', selectors: ['input[name="password"]:visible'], fill: null }, // генерируется снаружи
    { name: 'password2', selectors: ['input[name="password2"]:visible'], fill: null },
  ];
}

/**
 * Orgpage.ru
 */
function getOrgpageSelectors(email, websiteData) {
  return [
    { name: 'company', selectors: ['input[name="Company"]:visible', 'input[placeholder*="Компания"]:visible'], fill: websiteData.name },
    { name: 'email', selectors: ['input[name="Email"]:visible', 'input[type="email"]:visible'], fill: email },
    { name: 'password', selectors: ['input[name="Password"]:visible', 'input[type="password"]:visible'], fill: null },
    { name: 'password2', selectors: ['input[name="Password2"]:visible', 'input[name="password2"]:visible'], fill: null },
    { name: 'phone', selectors: ['input[name="Phone"]:visible', 'input[type="tel"]:visible'], fill: websiteData.phone },
    { name: 'site', selectors: ['input[name="Site"]:visible', 'input[name="site"]:visible'], fill: websiteData.website },
  ];
}

/**
 * B2B Center
 */
function getB2bCenterSelectors(email, websiteData) {
  return [
    { name: 'company_name', selectors: ['input[name="company_name"]:visible', 'input[placeholder*="Компания"]:visible', 'input[placeholder*="company"]:visible'], fill: websiteData.name },
    { name: 'website', selectors: ['input[name="site"]:visible', 'input[name="website"]:visible', 'input[placeholder*="site"]:visible', 'input[placeholder*="site"]:visible'], fill: websiteData.website },
    { name: 'email', selectors: ['input[name="email"]:visible', 'input[type="email"]:visible'], fill: email },
    { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible'], fill: null },
    { name: 'phone', selectors: ['input[name="phone"]:visible', 'input[type="tel"]:visible'], fill: websiteData.phone },
    { name: 'inn', selectors: ['input[name="inn"]:visible', 'input[placeholder*="ИНН"]:visible'], fill: websiteData.inn },
    { name: 'description', selectors: ['textarea[name="description"]:visible', 'textarea[placeholder*="description"]:visible', 'textarea[placeholder*="Описание"]:visible'], fill: websiteData.description },
  ];
}

/**
 * iRecommend.ru
 */
function getIrecommendSelectors(email) {
  return [
    { name: 'login', selectors: ['input[name="name"]:visible', '#edit-name:visible', 'input[type="text"][id="edit-name"]:visible'], fill: email.split('@')[0] },
    { name: 'email', selectors: ['input[name="mail"]:visible', '#edit-mail:visible', 'input[type="text"][id="edit-mail"]:visible'], fill: email },
    { name: 'password', selectors: ['input[name="pass[pass1]"]:visible', '#edit-pass-pass1:visible', 'input[type="password"][id="edit-pass-pass1"]:visible'], fill: null },
    { name: 'password_confirm', selectors: ['input[name="pass[pass2]"]:visible', '#edit-pass-pass2:visible', 'input[type="password"][id="edit-pass-pass2"]:visible'], fill: null },
  ];
}

/**
 * Flado.ru
 */
function getFladoSelectors(email, websiteData) {
  const emailName = email.split('@')[0];
  return [
    { name: 'email', selectors: ['input[name="email"]:visible', 'input[type="email"]:visible', 'input[placeholder*="Email"]:visible', '#email', '.email-input'], fill: email },
    { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible', 'input[placeholder*="Пароль"]:visible', '#password', '.password-input'], fill: null },
    { name: 'password_confirm', selectors: [], fill: null, customFind: true },
    { name: 'name', selectors: ['input[name="name"]:visible', 'input[name="username"]:visible', 'input[placeholder*="Имя"]:visible', 'input[placeholder*="Name"]:visible', 'input[placeholder*="Ваше имя"]:visible', '#name', '.name-input', 'input[type="text"][aria-label*="Имя"]', 'input[type="text"][aria-label*="Name"]'], fill: emailName },
    { name: 'phone', selectors: ['input[name="phone"]:visible', 'input[type="tel"]:visible', 'input[placeholder*="Телефон"]:visible', '#phone', '.phone-input'], fill: websiteData.phone },
    { name: 'company_name', selectors: ['input[name="company_name"]:visible', 'input[name="org_name"]:visible', 'input[placeholder*="Организация"]:visible', 'input[placeholder*="Компания"]:visible', '#company_name', '.company-name'], fill: websiteData.name },
    { name: 'description', selectors: ['textarea[name="description"]:visible', 'textarea[placeholder*="Описание"]:visible', '#description', '.description-input'], fill: websiteData.description },
    { name: 'category', selectors: ['select[name="category"]:visible', 'input[name="category"]:visible', '[class*="category-select"]:visible'], fill: null },
    { name: 'confirmation_code', selectors: ['input[name="code"]:visible', 'input[name="confirmation_code"]:visible', 'input[placeholder*="Код"]:visible', 'input[name="confirm_code"]:visible', '.code-input', '#code', '#confirmation_code', 'input[type="text"][maxlength="4"]', 'input[type="text"][maxlength="6"]'], fill: null },
  ];
}

/**
 * Flagma.ru
 */
function getFlagmaSelectors(email, websiteData) {
  return [
    { name: 'email', selectors: ['input[name="email"]:visible', 'input[type="email"]:visible', 'input[placeholder*="Email"]:visible', 'input[name="user_email"]:visible'], fill: email },
    { name: 'password', selectors: ['input[name="password"]:visible', 'input[type="password"]:visible', 'input[placeholder*="Пароль"]:visible', 'input[name="user_password"]:visible'], fill: null },
    { name: 'password_confirm', selectors: ['input[name="password_confirm"]:visible', 'input[name="confirm_password"]:visible', 'input[name="password2"]:visible', 'input[placeholder*="Повторите пароль"]:visible', 'input[placeholder*="Подтверждение пароля"]:visible'], fill: null },
    { name: 'company_name', selectors: ['input[name="company_name"]:visible', 'input[name="org_name"]:visible', 'input[placeholder*="Организация"]:visible', 'input[placeholder*="Компания"]:visible', 'input[name="name"]:visible'], fill: websiteData.name },
    { name: 'website', selectors: ['input[name="site"]:visible', 'input[name="website"]:visible', 'input[name="url"]:visible', 'input[placeholder*="Сайт"]:visible', 'input[placeholder*="site"]:visible'], fill: websiteData.website },
    { name: 'phone', selectors: ['input[name="phone"]:visible', 'input[type="tel"]:visible', 'input[placeholder*="Телефон"]:visible', 'input[name="telephone"]:visible'], fill: websiteData.phone },
    { name: 'inn', selectors: ['input[name="inn"]:visible', 'input[placeholder*="ИНН"]:visible'], fill: websiteData.inn },
    { name: 'description', selectors: ['textarea[name="description"]:visible', 'textarea[placeholder*="Описание"]:visible', 'textarea[name="about"]:visible'], fill: websiteData.description },
    { name: 'city', selectors: ['input[name="city"]:visible', 'input[placeholder*="Город"]:visible'], fill: websiteData.city },
  ];
}

/**
 * URL профиля после регистрации для каждого домена
 */
const PROFILE_URLS_MAP = {
  'https://otzovik.com/signup.php':        'https://otzovik.com/loginnew.php',
  'https://www.orgpage.ru/Cabinet/Create/': 'https://www.orgpage.ru/Cabinet/Create/',
  'https://www.cataloxy.ru/reg.htm':       'https://www.cataloxy.ru/cabinet.htm',
  'https://www.b2b-center.ru/app/next/registration/': 'https://www.b2b-center.ru',
  'https://www.irecommend.ru/user/register': 'https://www.irecommend.ru',
  'https://my.flado.ru/registration':      'https://my.flado.ru/',
  'https://flagma.ru/registration':        'https://flagma.ru/',
};

/**
 * Получить URL профиля после регистрации
 */
function getProfileUrl(currentUrl) {
  return PROFILE_URLS_MAP[currentUrl] || currentUrl;
}

module.exports = {
  getSiteSelectors,
  getProfileUrl,
};
