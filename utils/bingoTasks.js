const fs = require('fs');
const path = require('path');

const MIN_POOL_SIZE = 25;
const tasksByCategory = new Map();
const tasksByGame = new Map();
const allTasksSet = new Set();

const tasksFilePath = path.join(__dirname, '..', 'bingo_tasks.json');

function titleize(value) {
  if (!value) return '';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function sanitizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function formatTaskText(task) {
  const text = task && typeof task.task === 'string' ? task.task.trim() : '';
  return text.length ? text : null;
}

function upsertTaskBucket(map, rawValue, taskText) {
  const value = sanitizeValue(rawValue);
  if (!value || !taskText) return;

  if (!map.has(value)) {
    map.set(value, {
      value,
      label: titleize(value),
      taskSet: new Set()
    });
  }
  map.get(value).taskSet.add(taskText);
}

function loadTasks() {
  try {
    const raw = fs.readFileSync(tasksFilePath, 'utf-8');
    const tasks = JSON.parse(raw);

    tasks.forEach(task => {
      const text = formatTaskText(task);
      if (!text) return;

      allTasksSet.add(text);
      upsertTaskBucket(tasksByCategory, task.category, text);
      upsertTaskBucket(tasksByGame, task.game, text);
    });
  } catch (error) {
    console.error('Failed to load bingo tasks:', error);
  }
}

function bucketToMeta(bucket) {
  return {
    value: bucket.value,
    label: bucket.label || bucket.value,
    count: bucket.taskSet.size
  };
}

function getBucketTasks(bucket) {
  if (!bucket) return [];
  return Array.from(bucket.taskSet);
}

function getBingoTasksMeta() {
  const categories = Array.from(tasksByCategory.values())
    .filter(bucket => bucket.taskSet.size >= MIN_POOL_SIZE)
    .map(bucketToMeta)
    .sort((a, b) => a.label.localeCompare(b.label));

  const games = Array.from(tasksByGame.values())
    .filter(bucket => bucket.taskSet.size >= MIN_POOL_SIZE)
    .map(bucketToMeta)
    .sort((a, b) => a.label.localeCompare(b.label));

  return { categories, games };
}

function getCategoryPool(value) {
  const key = sanitizeValue(value);
  return getBucketTasks(tasksByCategory.get(key));
}

function getGamePool(value) {
  const key = sanitizeValue(value);
  return getBucketTasks(tasksByGame.get(key));
}

function getAllTasksPool() {
  return Array.from(allTasksSet);
}

loadTasks();

module.exports = {
  MIN_POOL_SIZE,
  getBingoTasksMeta,
  getCategoryPool,
  getGamePool,
  getAllTasksPool
};
