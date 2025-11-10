const fs = require('fs');
const path = require('path');

const SUPPORTED_LOCALES = ['en', 'ja'];
const DEFAULT_LOCALE = 'en';
const FALLBACK_NAMESPACES = ['common', 'actions'];

let dictionaries = {};
const bingoDictionaries = new Map();

function loadLocales() {
  dictionaries = SUPPORTED_LOCALES.reduce((acc, locale) => {
    try {
      const localePath = path.join(__dirname, '..', 'locales', `${locale}.json`);
      const raw = fs.readFileSync(localePath, 'utf-8');
      acc[locale] = JSON.parse(raw);
    } catch (error) {
      console.error(`Failed to load locale "${locale}":`, error);
      acc[locale] = {};
    }
    return acc;
  }, {});
}

function normalizeLocale(value) {
  if (!value || typeof value !== 'string') return '';
  return value.toLowerCase().split('-')[0];
}

function isSupportedLocale(value) {
  const normalized = normalizeLocale(value);
  return SUPPORTED_LOCALES.includes(normalized);
}

function resolveLocale(preferred) {
  if (isSupportedLocale(preferred)) return normalizeLocale(preferred);
  return DEFAULT_LOCALE;
}

function getDictionary(locale) {
  return dictionaries[locale] || dictionaries[DEFAULT_LOCALE] || {};
}

function getBingoDictionary(locale) {
  const safeLocale = resolveLocale(locale);
  if (bingoDictionaries.has(safeLocale)) {
    return bingoDictionaries.get(safeLocale);
  }
  try {
    const localePath = path.join(__dirname, '..', 'locales', 'bingo', `${safeLocale}.json`);
    const raw = fs.readFileSync(localePath, 'utf-8');
    const parsed = JSON.parse(raw);
    bingoDictionaries.set(safeLocale, parsed);
    return parsed;
  } catch (error) {
    bingoDictionaries.set(safeLocale, {});
    return {};
  }
}

function getNestedValue(object, key) {
  if (!object || !key) return undefined;
  return key.split('.').reduce((acc, part) => {
    if (acc && Object.prototype.hasOwnProperty.call(acc, part)) {
      return acc[part];
    }
    return undefined;
  }, object);
}

function setNestedValue(object, key, value) {
  const parts = key.split('.');
  let cursor = object;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
    } else {
      if (!cursor[part] || typeof cursor[part] !== 'object') {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
  });
}

function interpolate(template, vars) {
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, token) => {
    if (Object.prototype.hasOwnProperty.call(vars, token)) {
      return vars[token];
    }
    return '';
  });
}

function translate(locale, key, vars) {
  if (!key) return '';
  const safeLocale = resolveLocale(locale);
  const dictionary = getDictionary(safeLocale);
  let value = getNestedValue(dictionary, key);
  if (value === undefined && safeLocale !== DEFAULT_LOCALE) {
    value = getNestedValue(getDictionary(DEFAULT_LOCALE), key);
  }
  if (value === undefined) {
    const fallback = getFallbackValue(key);
    return fallback !== undefined ? interpolate(fallback, vars) : key;
  }
  if (typeof value === 'string') {
    return interpolate(value, vars);
  }
  return value;
}

function getFallbackValue(key) {
  const fallbackDict = getDictionary(DEFAULT_LOCALE);
  return getNestedValue(fallbackDict, key);
}

function getClientTranslations(locale, namespaces = []) {
  const uniqueNamespaces = Array.from(new Set([...FALLBACK_NAMESPACES, ...namespaces]));
  const safeLocale = resolveLocale(locale);
  const bundle = {};
  uniqueNamespaces.forEach((ns) => {
    let value = getNestedValue(getDictionary(safeLocale), ns);
    if (value === undefined && safeLocale !== DEFAULT_LOCALE) {
      value = getNestedValue(getDictionary(DEFAULT_LOCALE), ns);
    }
    if (value !== undefined) {
      setNestedValue(bundle, ns, value);
    }
  });
  return bundle;
}

function translateItemText(locale, text) {
  if (typeof text !== 'string') return '';
  const safeLocale = resolveLocale(locale);
  const dict = getDictionary(safeLocale);
  const fallbackDict = getDictionary(DEFAULT_LOCALE);
  const value = dict.items?.[text] || fallbackDict.items?.[text];
  return value || text;
}

function translateTaskText(locale, task, fallbackText) {
  if (!task) return fallbackText || '';
  const safeLocale = resolveLocale(locale);
  const taskId = typeof task === 'object' ? task.id : task;
  const fallback = typeof task === 'object' ? (task.text || fallbackText) : fallbackText;
  if (!taskId) return fallback || '';

  const dict = getBingoDictionary(safeLocale);
  if (dict && Object.prototype.hasOwnProperty.call(dict, taskId)) {
    return dict[taskId];
  }

  if (safeLocale !== DEFAULT_LOCALE) {
    const fallbackDict = getBingoDictionary(DEFAULT_LOCALE);
    if (fallbackDict && Object.prototype.hasOwnProperty.call(fallbackDict, taskId)) {
      return fallbackDict[taskId];
    }
  }

  return fallback || taskId;
}

function getSupportedLocalesMeta() {
  return SUPPORTED_LOCALES.map((code) => {
    const dict = getDictionary(code);
    return {
      code,
      label: dict.meta?.label || code
    };
  });
}

loadLocales();

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  translate,
  translateItemText,
  translateTaskText,
  getClientTranslations,
  getSupportedLocalesMeta,
  resolveLocale,
  isSupportedLocale,
  normalizeLocale
};
