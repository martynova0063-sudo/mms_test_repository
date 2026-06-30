const CompanyParser = require('./company-parser');

async function main() {
  const urls = process.argv.slice(2);
  
  if (urls.length === 0) {
    // Дефолтный URL для примера
    urls.push('https://pc-camapa163.ru/');
  }

  const parser = new CompanyParser();

  for (const url of urls) {
    console.log(`\n\n========================================`);
    console.log(`Парсинг: ${url}`);
    console.log(`========================================`);
    
    try {
      const result = await parser.parse(url);
      parser.printResults();
      
      // Также выводим JSON для программной обработки
      console.log(`\n📄 JSON:`);
      console.log(parser.toJSON());
      
    } catch (error) {
      console.error(`❌ Ошибка при парсинге ${url}:`, error.message);
    }
  }
}

main();
