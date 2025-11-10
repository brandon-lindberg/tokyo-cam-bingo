const fs = require('fs');
const path = require('path');

const MIN_POOL_SIZE = 25;
const tasksByCategory = new Map();
const tasksByGame = new Map();
const allTaskIds = new Set();
const tasksById = new Map();

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

function upsertTaskBucket(map, rawValue, taskId) {
  const value = sanitizeValue(rawValue);
  if (!value || !taskId) return;

  if (!map.has(value)) {
    map.set(value, {
      value,
      label: titleize(value),
      taskIds: new Set()
    });
  }
  map.get(value).taskIds.add(taskId);
}

function loadTasks() {
  try {
    const raw = fs.readFileSync(tasksFilePath, 'utf-8');
    const tasks = JSON.parse(raw);

    tasks.forEach(task => {
      const id = sanitizeValue(task.id);
      const text = formatTaskText(task);
      if (!id || !text) return;

      const entry = {
        id,
        text,
        category: sanitizeValue(task.category),
        game: sanitizeValue(task.game)
      };

      tasksById.set(id, entry);
      allTaskIds.add(id);
      upsertTaskBucket(tasksByCategory, entry.category, id);
      upsertTaskBucket(tasksByGame, entry.game, id);
    });
  } catch (error) {
    console.error('Failed to load bingo tasks:', error);
  }
}

function bucketToMeta(bucket) {
  return {
    value: bucket.value,
    label: bucket.label || bucket.value,
    count: bucket.taskIds.size
  };
}

function getBucketTasks(bucket) {
  if (!bucket) return [];
  return Array.from(bucket.taskIds)
    .map((id) => tasksById.get(id))
    .filter(Boolean);
}

function getBingoTasksMeta() {
  const categories = Array.from(tasksByCategory.values())
    .filter(bucket => bucket.taskIds.size >= MIN_POOL_SIZE)
    .map(bucketToMeta)
    .sort((a, b) => a.label.localeCompare(b.label));

  const games = Array.from(tasksByGame.values())
    .filter(bucket => bucket.taskIds.size >= MIN_POOL_SIZE)
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
  return Array.from(allTaskIds)
    .map((id) => tasksById.get(id))
    .filter(Boolean);
}

function getAllTaskEntries() {
  return Array.from(tasksById.values());
}

function getTaskEntry(taskId) {
  return tasksById.get(taskId);
}

loadTasks();

module.exports = {
  MIN_POOL_SIZE,
  getBingoTasksMeta,
  getCategoryPool,
  getGamePool,
  getAllTasksPool,
  getAllTaskEntries,
  getTaskEntry
};
