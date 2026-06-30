# 🏢 Company Parser — Универсальный парсер информации о компаниях

Извлекает данные о компании с любого сайта:
- Название компании
- Адрес
- Телефон
- Описание
- Сфера деятельности (автоматически)
- ИНН (через внешний API)
- Логотип

## 📦 Установка

```bash
npm install
```

## 🚀 Использование

### Базовый запуск

```bash
node parse-example.js
```

### Парсинг конкретного URL

```bash
node parse-example.js https://example.com
```

### Парсинг нескольких сайтов

```bash
node parse-example.js https://site1.com https://site2.com https://site3.com
```

## 💻 Программное использование

```javascript
const CompanyParser = require('./company-parser');

async function main() {
  const parser = new CompanyParser();
  
  const result = await parser.parse('https://example.com');
  parser.printResults();
  
  // Или получить JSON
  console.log(parser.toJSON());
}

main();
```

## 📋 Что извлекается

| Поле | Источник | Примечание |
|------|----------|------------|
| Название | JSON-LD, OG теги, Title | Очищается от мусора |
| Адрес | JSON-LD, HTML-паттерны | Города, улицы, здания |
| Телефон | JSON-LD, tel:, WhatsApp | Нормализация +7 |
| Описание | JSON-LD, OG, Meta | |
| Сфера деятельности | Контент страницы | 9+ категорий |
| ИНН | JSON-LD identifier | Требуется внешний API |
| Логотип | JSON-LD, OG, link tags | |

## 🏗 Архитектура

Парсер использует 4 уровня извлечения данных (от наиболее к наименее надёжным):

1. **JSON-LD** — структурированные данные Schema.org (самый надёжный источник)
2. **Open Graph** — мета-теги для соцсетей
3. **HTML-разметка** — regex-паттерны для контактов
4. **Внешний API** — поиск ИНН по названию компании

## ⚙️ Настройка поиска ИНН

Для автоматического поиска ИНН раскомментируйте код в методе `searchInnExternally`:

```javascript
// В company-parser.js, метод searchInnExternally:
const API_KEY = 'ВАШ_API_KEY';
const response = await fetch(
  `https://listsadebit.ru/api/v1/search?query=${encodeURIComponent(name)}&api_key=${API_KEY}`
);
const data = await response.json();
return data.inn || null;
```

Поддерживаемые API:
- listsadebit.ru
- contact.ru
- list-org.com

## 📁 Файлы

- `company-parser.js` — основной модуль парсера
- `parse-example.js` — пример использования

## 🧪 Пример вывода

```
============================================================
📋 РЕЗУЛЬТАТЫ ПАРСИНГА КОМПАНИИ
============================================================
🏢 Название компании: Услуги по строительству и ремонту
📍 Адрес: г. Самара
📞 Телефон: +79879807777
📝 Описание: Ремонт квартир, строительство домов...
💼 Сфера деятельности: Строительство и ремонт
🔢 ИНН: не определено
🖼 Логотип: https://...
============================================================
```
