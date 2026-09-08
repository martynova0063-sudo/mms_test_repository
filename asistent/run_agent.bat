@echo off
chcp 65001 >nul
REM Переход в директорию скрипта
cd /d "%~dp0"
REM Запуск node app.js и запись логов в файл рядом со скриптом
node app.js --mode=apply >> agent_log.txt 2>&1