const { serverLog } = require('./logger');

// Хранилище активных задач в памяти
const activeTasks = new Map();
let taskIdCounter = 0;

// SSE клиенты для задач
const taskStreamClients = [];

/**
 * Создать новую задачу
 */
function createTask(website, email, company, catalog) {
  const tempId = `task_${Date.now()}_${taskIdCounter++}`;
  const task = {
    tempId,
    website,
    email,
    company,
    catalog,
    status: 'queued',
    error: null,
    created_at: new Date().toISOString(),
    progress: 0,
    currentStep: 'Инициализация'
  };
  activeTasks.set(tempId, task);
  broadcastTaskUpdate(task);
  serverLog.info(`📋 Создана задача: ${tempId} для ${company} → ${catalog}`);
  return tempId;
}

/**
 * Обновить статус задачи
 */
function updateTaskStatus(tempId, status, progress = null, currentStep = null, error = null) {
  const task = activeTasks.get(tempId);
  if (!task) {
    serverLog.warn(`⚠️ Задача ${tempId} не найдена для обновления`);
    return;
  }
  
  task.status = status;
  if (progress !== null) task.progress = progress;
  if (currentStep !== null) task.currentStep = currentStep;
  if (error !== null) task.error = error;
  
  activeTasks.set(tempId, task);
  broadcastTaskUpdate(task);
  serverLog.debug(`📝 Обновлена задача ${tempId}: status=${status}, progress=${progress}, step=${currentStep}`);
}

/**
 * Завершить задачу
 */
function completeTask(tempId, finalStatus, error = null) {
  const task = activeTasks.get(tempId);
  if (!task) {
    serverLog.warn(`⚠️ Задача ${tempId} не найдена для завершения`);
    return;
  }
  
  task.status = finalStatus;
  task.error = error;
  task.progress = 100;
  task.currentStep = 'Завершено';
  
  broadcastTaskUpdate(task);
  
  // Удаляем из активных задач через 30 секунд
  setTimeout(() => {
    activeTasks.delete(tempId);
    serverLog.debug(`🗑️ Задача ${tempId} удалена из активных`);
  }, 30000);
  
  serverLog.info(`✅ Завершена задача ${tempId}: ${finalStatus}`);
}

/**
 * Получить все активные задачи
 */
function getAllTasks() {
  return Array.from(activeTasks.values());
}

/**
 * Рассылка обновлений задач всем SSE клиентам
 */
function broadcastTaskUpdate(task) {
  const message = JSON.stringify({ type: 'update', task });
  taskStreamClients.forEach(client => {
    if (!client.destroyed) {
      client.write(`data: ${message}\n\n`);
    }
  });
}

/**
 * Добавить SSE клиент
 */
function addTaskStreamClient(client) {
  taskStreamClients.push(client);
  
  client.on('close', () => {
    serverLog.debug('🔌 SSE клиент задач отключился');
    const idx = taskStreamClients.indexOf(client);
    if (idx > -1) taskStreamClients.splice(idx, 1);
  });
}

/**
 * Отправить начальные данные клиенту
 */
function sendInitialTasks(client) {
  const activeTasksArray = getAllTasks();
  client.write(`data: ${JSON.stringify({ type: 'init', tasks: activeTasksArray })}\n\n`);
}

module.exports = {
  createTask,
  updateTaskStatus,
  completeTask,
  getAllTasks,
  addTaskStreamClient,
  sendInitialTasks
};
