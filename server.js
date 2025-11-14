const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const itemsList = JSON.parse(fs.readFileSync('items.json'));
const session = require('express-session');
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
require('dotenv').config();
const packageJson = require('./package.json');
const { checkWin } = require('./utils/checkWin');
const {
  translate,
  translateItemText,
  translateTaskText,
  getClientTranslations,
  getSupportedLocalesMeta,
  resolveLocale,
  isSupportedLocale,
  normalizeLocale,
  DEFAULT_LOCALE
} = require('./utils/i18n');
const {
  MIN_POOL_SIZE,
  getBingoTasksMeta,
  getCategoryPool,
  getGamePool,
  getAllTasksPool
} = require('./utils/bingoTasks');

const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
const SITEMAP_STATIC_PATHS = ['/', '/card-builder', '/gallery', '/terms'];

const isProduction = process.env.NODE_ENV === 'production';
const STATIC_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const BODY_LIMIT = '250kb';
const CAPTCHA_TTL_MS = 10 * 60 * 1000;
const CAPTCHA_TYPES = {
  CREATE_GAME: 'createGame',
  CARD_BUILDER: 'cardBuilder',
  REPORT_CARD: 'reportCard'
};
const LOCALE_COOKIE_NAME = 'locale';
const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
const THEME_COOKIE_NAME = 'theme';
const THEME_COOKIE_MAX_AGE = LOCALE_COOKIE_MAX_AGE;
const DEFAULT_THEME = 'light';
const SUPPORTED_THEMES = new Set(['light', 'dark']);
const ADMIN_IDLE_TIMEOUT_MINUTES = Math.max(parseInt(process.env.ADMIN_IDLE_TIMEOUT_MINUTES || '2', 10), 1);
const ADMIN_IDLE_TIMEOUT_MS = ADMIN_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const ADMIN_HEARTBEAT_INTERVAL_MS = Math.max(
  10000,
  Math.min(60000, Math.floor(ADMIN_IDLE_TIMEOUT_MS / 2))
);

// In-memory flags and voting state
const flagsLeft = {}; // playerId -> remaining flags
const votesByGame = {}; // gameId -> active vote state
const timerIntervals = {}; // gameId -> setInterval reference for timer

// Ensure session secret is provided
if (!process.env.SESSION_SECRET) {
  console.error('Error: SESSION_SECRET environment variable is required');
  process.exit(1);
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');

const buildVersion = process.env.APP_BUILD_VERSION || process.env.BUILD_ID || packageJson.version;
const enableServiceWorker = process.env.ENABLE_SERVICE_WORKER === 'true';

app.locals.assetVersion = buildVersion;
app.locals.enableServiceWorker = enableServiceWorker;
app.locals.siteUrl = PUBLIC_SITE_URL;

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/socket.io/')
});

const createJoinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).send('Too many game actions from this IP. Please wait before trying again.');
  }
});

const cardWriteLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many card saves from this IP. Please wait a bit and try again.' });
  }
});

const dynamicNoCachePatterns = [
  /^\/$/,
  /^\/game/,
  /^\/card-builder/,
  /^\/create/,
  /^\/join/,
  /^\/api/,
  /^\/get-code/,
  /^\/game-info/,
  /^\/socket\.io/
];

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(globalLimiter);

app.use((req, res, next) => {
  if (dynamicNoCachePatterns.some((pattern) => pattern.test(req.path))) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(express.static('public', {
  setHeaders: (res, servedPath) => {
    if (servedPath && servedPath.endsWith('service-worker.js')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      res.set('Cache-Control', `public, max-age=${STATIC_MAX_AGE_SECONDS}, immutable`);
    }
  }
}));

app.get('/robots.txt', (req, res) => {
  const sitemapUrl = buildAbsoluteUrl(req, '/sitemap.xml');
  const lines = [
    'User-agent: *',
    'Disallow:',
    `Sitemap: ${sitemapUrl}`
  ];
  res.type('text/plain').send(lines.join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const urls = SITEMAP_STATIC_PATHS.map((path) => {
    const loc = buildAbsoluteUrl(req, path);
    return `
  <url>
    <loc>${loc}</loc>
    <changefreq>weekly</changefreq>
  </url>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
  res.type('application/xml').send(xml);
});

// Serve PWA files from root with caching
app.get('/site.webmanifest', (req, res) => {
  res.sendFile(path.join(__dirname, 'site.webmanifest'), {
    headers: {
      'Cache-Control': 'public, max-age=86400, immutable',
      'Content-Type': 'application/manifest+json'
    }
  });
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.ico'), {
    headers: {
      'Cache-Control': 'public, max-age=604800, immutable'
    }
  });
});

app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
app.use(express.json({ limit: BODY_LIMIT }));

const sessionMiddleware = session({
  store: new PrismaSessionStore(
    prisma,
    {
      checkPeriod: 2 * 60 * 1000, // prune expired sessions every 2 minutes
      dbRecordIdIsSessionId: true,
      dbRecordIdFunction: undefined
    }
  ),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction
  }
});

app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, socket.request.res || {}, next));

app.use((req, res, next) => {
  const { locale, source } = determineRequestLocale(req);
  if (source === 'query') {
    persistLocalePreference(req, res, locale);
  }
  req.locale = locale;
  res.locals.locale = locale;
  res.locals.availableLocales = getSupportedLocalesMeta();
  res.locals.t = (key, vars) => translate(locale, key, vars);
  res.locals.translateItem = (text) => translateItemText(locale, text);
  res.locals.translateTask = (taskId, fallback) => translateTaskText(locale, taskId, fallback);
  res.locals.getClientTranslations = (namespaces = []) => getClientTranslations(locale, namespaces);
  next();
});

app.use((req, res, next) => {
  let theme = normalizeTheme(req.query?.theme);
  if (theme) {
    persistThemePreference(req, res, theme);
  } else {
    theme = determineRequestTheme(req);
    if (req.session && req.session.theme !== theme) {
      req.session.theme = theme;
    }
  }
  req.theme = theme;
  res.locals.theme = theme;
  next();
});

app.use((req, res, next) => {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.assetVersion = app.locals.assetVersion;
  res.locals.enableServiceWorker = app.locals.enableServiceWorker;
  res.locals.csrfToken = req.session?.csrfToken || '';
  res.locals.currentPath = req.originalUrl || '/';
  res.locals.siteUrl = app.locals.siteUrl;
  res.locals.buildCanonical = (path = req.originalUrl || '/') => buildAbsoluteUrl(req, path);
  res.locals.canonicalUrl = buildAbsoluteUrl(req, req.originalUrl || '/');
  next();
});

const actionCooldowns = new Map();

function buildAbsoluteUrl(req, targetPath = '/') {
  const safePath = typeof targetPath === 'string' && targetPath.length ? targetPath : '/';
  const isAbsolute = /^https?:\/\//i.test(safePath);
  if (isAbsolute) {
    return safePath;
  }
  if (PUBLIC_SITE_URL) {
    try {
      return new URL(safePath, PUBLIC_SITE_URL).toString();
    } catch (error) {
      console.warn('Failed to build absolute URL from PUBLIC_SITE_URL', error);
      return PUBLIC_SITE_URL;
    }
  }
  const host = req.get('host');
  if (!host) {
    return safePath;
  }
  const normalizedPath = safePath.startsWith('/') ? safePath : `/${safePath}`;
  const protocol = req.protocol || (req.secure ? 'https' : 'http') || 'https';
  return `${protocol}://${host}${normalizedPath}`;
}

function parseCookies(header = '') {
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const [rawName, ...rest] = part.trim().split('=');
    if (!rawName) {
      return acc;
    }
    const name = rawName.trim();
    const value = rest.length ? rest.join('=') : '';
    acc[name] = decodeURIComponent(value || '');
    return acc;
  }, {});
}

function getLocaleFromAcceptLanguage(header = '') {
  if (!header) return '';
  const candidates = header.split(',')
    .map((segment) => {
      const [langPart, weightPart] = segment.trim().split(';q=');
      const lang = normalizeLocale(langPart);
      const weight = weightPart ? parseFloat(weightPart) : 1;
      return {
        lang,
        weight: Number.isNaN(weight) ? 1 : weight
      };
    })
    .filter(({ lang }) => isSupportedLocale(lang))
    .sort((a, b) => b.weight - a.weight);
  return candidates.length ? candidates[0].lang : '';
}

function determineRequestLocale(req) {
  const queryLocale = normalizeLocale(req.query?.lang);
  if (isSupportedLocale(queryLocale)) {
    return { locale: queryLocale, source: 'query' };
  }

  const sessionLocale = normalizeLocale(req.session?.locale);
  if (isSupportedLocale(sessionLocale)) {
    return { locale: sessionLocale, source: 'session' };
  }

  const cookies = parseCookies(req.headers?.cookie || '');
  const cookieLocale = normalizeLocale(cookies[LOCALE_COOKIE_NAME]);
  if (isSupportedLocale(cookieLocale)) {
    return { locale: cookieLocale, source: 'cookie' };
  }

  const headerLocale = getLocaleFromAcceptLanguage(req.get('accept-language'));
  if (headerLocale) {
    return { locale: headerLocale, source: 'header' };
  }

  return { locale: DEFAULT_LOCALE, source: 'default' };
}

function persistLocalePreference(req, res, locale) {
  if (req.session) {
    req.session.locale = locale;
  }
  res.cookie(LOCALE_COOKIE_NAME, locale, {
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax'
  });
}

function normalizeTheme(value = '') {
  const normalized = (value || '').toString().toLowerCase();
  return SUPPORTED_THEMES.has(normalized) ? normalized : '';
}

function determineRequestTheme(req) {
  const sessionTheme = normalizeTheme(req.session?.theme);
  if (sessionTheme) {
    return sessionTheme;
  }

  const cookies = parseCookies(req.headers?.cookie || '');
  const cookieTheme = normalizeTheme(cookies[THEME_COOKIE_NAME]);
  if (cookieTheme) {
    return cookieTheme;
  }

  return DEFAULT_THEME;
}

function persistThemePreference(req, res, theme) {
  if (req.session) {
    req.session.theme = theme;
  }
  res.cookie(THEME_COOKIE_NAME, theme, {
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: 'lax'
  });
}

async function persistPlayerThemePreference(req, theme) {
  const playerId = req.session?.playerId;
  if (!playerId) return;
  try {
    await prisma.player.update({
      where: { id: playerId },
      data: { themePreference: theme }
    });
  } catch (error) {
    console.warn('Failed to persist player theme preference', error?.message || error);
  }
}

function requestPrefersJson(req) {
  const acceptHeader = (req.get('accept') || '').toLowerCase();
  const requestedWith = (req.get('x-requested-with') || '').toLowerCase();
  return acceptHeader.includes('application/json') || requestedWith === 'xmlhttprequest';
}

function sanitizeReturnPath(pathValue) {
  if (typeof pathValue === 'string' && pathValue.startsWith('/') && !pathValue.startsWith('//')) {
    return pathValue;
  }
  return '/';
}

function normalizeMetaKey(value = '') {
  return value
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function sendCsrfError(req, res) {
  const message = 'Invalid or missing security token.';
  if (req.path.startsWith('/api')) {
    return res.status(403).json({ error: message });
  }
  return res.status(403).send(message);
}

function csrfProtection(req, res, next) {
  const sessionToken = req.session?.csrfToken;
  const headerToken = req.get('x-csrf-token');
  const token = req.body?.csrfToken || headerToken;
  if (!sessionToken || !token || sessionToken !== token) {
    return sendCsrfError(req, res);
  }
  return next();
}

app.post('/set-locale', csrfProtection, (req, res) => {
  const requestedLocale = normalizeLocale(req.body?.locale);
  const returnTo = sanitizeReturnPath(req.body?.returnTo || req.get('referer') || '/');
  if (isSupportedLocale(requestedLocale)) {
    persistLocalePreference(req, res, requestedLocale);
    req.locale = requestedLocale;
  }
  if (req.session) {
    req.session.save(() => res.redirect(returnTo));
  } else {
    res.redirect(returnTo);
  }
});

app.post('/set-theme', csrfProtection, async (req, res) => {
  const requestedTheme = normalizeTheme(req.body?.theme);
  const wantsJson = requestPrefersJson(req);
  if (!requestedTheme) {
    if (wantsJson) {
      return res.status(400).json({ error: 'Unsupported theme selection.', theme: req.theme || DEFAULT_THEME });
    }
    const fallbackPath = sanitizeReturnPath(req.body?.returnTo || req.get('referer') || '/');
    return res.redirect(fallbackPath);
  }

  persistThemePreference(req, res, requestedTheme);
  await persistPlayerThemePreference(req, requestedTheme);
  req.theme = requestedTheme;
  if (wantsJson) {
    return res.json({ theme: requestedTheme });
  }

  const returnTo = sanitizeReturnPath(req.body?.returnTo || req.get('referer') || '/');
  if (req.session) {
    req.session.save(() => res.redirect(returnTo));
  } else {
    res.redirect(returnTo);
  }
});

function isOnCooldown(playerId, action, durationMs) {
  if (!playerId) return true;
  const now = Date.now();
  const key = `${playerId}:${action}`;
  const availableAt = actionCooldowns.get(key) || 0;
  if (availableAt > now) {
    return true;
  }
  actionCooldowns.set(key, now + durationMs);
  return false;
}

function getSocketIdentity(socket) {
  const session = socket.request?.session || {};
  return {
    playerId: session.playerId || null,
    gameId: session.gameId || null
  };
}

function getPlayerKey(playerId) {
  return playerId ? String(playerId) : '';
}

function createCaptchaPayload() {
  const a = Math.floor(Math.random() * 8) + 2;
  const b = Math.floor(Math.random() * 8) + 2;
  return {
    question: `${a} + ${b} = ?`,
    answer: String(a + b),
    expiresAt: Date.now() + CAPTCHA_TTL_MS
  };
}

function getCaptcha(session, key, { refresh = false } = {}) {
  if (!session) return createCaptchaPayload();
  if (!session.captchas) session.captchas = {};
  const current = session.captchas[key];
  if (refresh || !current || current.expiresAt < Date.now()) {
    session.captchas[key] = createCaptchaPayload();
  }
  return session.captchas[key];
}

function validateCaptcha(session, key, submittedAnswer) {
  if (!session || !session.captchas || !session.captchas[key]) return false;
  const challenge = session.captchas[key];
  if (!challenge || challenge.expiresAt < Date.now()) return false;
  const normalized = (submittedAnswer || '').toString().trim().toLowerCase();
  if (!normalized) return false;
  const isValid = normalized === challenge.answer;
  if (isValid) {
    session.captchas[key] = createCaptchaPayload();
  }
  return isValid;
}

// Helper to generate random code
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper to generate 5x5 card
function generateCard(customItems = null) {
  const sourceItems = customItems || itemsList;
  const shuffled = [...sourceItems].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, 25);
  return Array.from({ length: 5 }, (_, i) =>
    selected.slice(i * 5, (i + 1) * 5).map(item => ({ item, stamped: false }))
  );
}

// Helper to re-roll part of card
function rerollCard(card, type, arg, customItems = null) {
  const newCard = card.map(row => row.slice()); // Deep copy
  let positions = [];
  const sourceItems = customItems || itemsList;

  if (type === 'tile') {
    const [rowStr, colStr] = arg.split(',');
    const row = parseInt(rowStr) - 1;
    const col = parseInt(colStr) - 1;
    if (isNaN(row) || isNaN(col) || row < 0 || row > 4 || col < 0 || col > 4) return card;
    positions = [[row, col]];
  } else if (type === 'row') {
    const row = parseInt(arg) - 1;
    if (isNaN(row) || row < 0 || row > 4) return card;
    positions = Array.from({ length: 5 }, (_, col) => [row, col]);
  } else if (type === 'column') {
    const col = parseInt(arg) - 1;
    if (isNaN(col) || col < 0 || col > 4) return card;
    positions = Array.from({ length: 5 }, (_, row) => [row, col]);
  } else if (type === 'diagonal') {
    if (arg === 'main') {
      positions = Array.from({ length: 5 }, (_, i) => [i, i]);
    } else if (arg === 'anti') {
      positions = Array.from({ length: 5 }, (_, i) => [i, 4 - i]);
    } else {
      return card;
    }
  } else if (type === 'card') {
    positions = Array.from({ length: 25 }, (_, i) => [Math.floor(i / 5), i % 5]);
  } else if (type === 'random_row') {
    const row = Math.floor(Math.random() * 5);
    positions = Array.from({ length: 5 }, (_, col) => [row, col]);
  } else if (type === 'random_column') {
    const col = Math.floor(Math.random() * 5);
    positions = Array.from({ length: 5 }, (_, row) => [row, col]);
  } else if (type === 'random_diagonal') {
    const pickMain = Math.random() < 0.5;
    if (pickMain) {
      positions = Array.from({ length: 5 }, (_, i) => [i, i]);
    } else {
      positions = Array.from({ length: 5 }, (_, i) => [i, 4 - i]);
    }
  } else {
    return card;
  }

  // Get current items on card to avoid dups
  const currentItems = new Set(card.flat().map(t => t.item));
  const available = sourceItems.filter(i => !currentItems.has(i));

  positions.forEach(([r, c]) => {
    if (available.length === 0) return; // Fallback if list exhausted
    const newItem = available[Math.floor(Math.random() * available.length)];
    newCard[r][c] = { item: newItem, stamped: false };
    // Remove to avoid dups in this re-roll
    available.splice(available.indexOf(newItem), 1);
  });

  return newCard;
}

// Timer helper functions
function startGameTimer(gameId) {
  // Check if timer already running
  if (timerIntervals[gameId]) {
    clearInterval(timerIntervals[gameId]);
  }

  // Check timer every second
  timerIntervals[gameId] = setInterval(async () => {
    try {
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        include: { players: true }
      });

      if (!game || !game.timerEnabled || game.status !== 'active') {
        stopGameTimer(gameId);
        return;
      }

      // Calculate remaining time
      const remainingSeconds = calculateRemainingTime(game);

      // Broadcast timer update every 10 seconds
      const now = new Date();
      if (now.getSeconds() % 10 === 0) {
        io.to(gameId).emit('timer_update', { remainingSeconds });
      }

      // Timer expired
      if (remainingSeconds <= 0) {
        stopGameTimer(gameId);
        await handleTimerExpiry(gameId, game);
      }
    } catch (error) {
      console.error('Timer error:', error);
      stopGameTimer(gameId);
    }
  }, 1000);
}

function stopGameTimer(gameId) {
  if (timerIntervals[gameId]) {
    clearInterval(timerIntervals[gameId]);
    delete timerIntervals[gameId];
  }
}

function calculateRemainingTime(game) {
  if (!game.timerEnabled || !game.timerStartedAt || !game.timerDuration) {
    return 0;
  }

  const now = new Date();
  const startedAt = new Date(game.timerStartedAt);
  const elapsedMs = now - startedAt;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  // Subtract accumulated pause time
  const pausedSeconds = game.timerAccumulatedPause || 0;
  const actualElapsed = elapsedSeconds - pausedSeconds;

  const remainingSeconds = Math.max(0, game.timerDuration - actualElapsed);
  return remainingSeconds;
}

async function handleTimerExpiry(gameId, game) {
  try {
    const players = await prisma.player.findMany({
      where: { gameId }
    });

    let winner = null;
    let tie = false;

    // Check if most_squares win condition is enabled
    if (game.rules.winConditions && game.rules.winConditions.includes('most_squares')) {
      let maxCount = 0;
      let leaders = [];

      players.forEach(p => {
        let count = 0;
        if (game.mode === 'VS') {
          count = (p.stampedSquares || []).length;
        } else {
          const card = Array.isArray(p.card) ? p.card : [];
          count = card.reduce((sum, row) => {
            if (!Array.isArray(row)) return sum;
            return sum + row.reduce((rowSum, tile) => rowSum + (tile && tile.stamped ? 1 : 0), 0);
          }, 0);
        }

        if (count > maxCount) {
          maxCount = count;
          leaders = [p.name];
          tie = false;
        } else if (count === maxCount && count > 0) {
          leaders.push(p.name);
        }
      });

      if (leaders.length === 1 && maxCount > 0) {
        winner = leaders[0];
      } else if (leaders.length > 1 && maxCount > 0) {
        tie = true;
      }
    }

    // Update game status
    await prisma.game.update({
      where: { id: gameId },
      data: {
        status: 'ended',
        winner: winner || null,
        timerStatus: 'expired'
      }
    });

    // Emit timer expired event
    const message = winner
      ? `${winner} wins by Most Squares!`
      : (tie ? 'Game ended in a tie for Most Squares!' : 'Game ended - no winner');

    io.to(gameId).emit('timer_expired', {
      winner,
      tie,
      message
    });

  } catch (error) {
    console.error('Error handling timer expiry:', error);
  }
}

async function pauseGameTimer(gameId) {
  try {
    const game = await prisma.game.findUnique({
      where: { id: gameId }
    });

    if (game && game.timerEnabled && !game.timerPausedAt) {
      await prisma.game.update({
        where: { id: gameId },
        data: {
          timerPausedAt: new Date()
        }
      });

      io.to(gameId).emit('timer_paused');
    }
  } catch (error) {
    console.error('Error pausing timer:', error);
  }
}

async function resumeGameTimer(gameId) {
  try {
    const game = await prisma.game.findUnique({
      where: { id: gameId }
    });

    if (game && game.timerEnabled && game.timerPausedAt) {
      const now = new Date();
      const pausedAt = new Date(game.timerPausedAt);
      const pauseDuration = Math.floor((now - pausedAt) / 1000);

      const accumulatedPause = (game.timerAccumulatedPause || 0) + pauseDuration;

      await prisma.game.update({
        where: { id: gameId },
        data: {
          timerPausedAt: null,
          timerAccumulatedPause: accumulatedPause
        }
      });

      const remainingSeconds = calculateRemainingTime({
        ...game,
        timerAccumulatedPause: accumulatedPause,
        timerPausedAt: null
      });

      io.to(gameId).emit('timer_resumed', { remainingSeconds });
    }
  } catch (error) {
    console.error('Error resuming timer:', error);
  }
}

// Home page
app.get('/', (req, res) => {
  const captcha = getCaptcha(req.session, CAPTCHA_TYPES.CREATE_GAME);
  res.render('home', { createCaptchaQuestion: captcha.question });
});

// Card builder page
app.get('/card-builder', (req, res) => {
  const captcha = getCaptcha(req.session, CAPTCHA_TYPES.CARD_BUILDER);
  res.render('card-builder', { cardCaptchaQuestion: captcha.question });
});

// Terms of Service page
app.get('/terms', (req, res) => {
  res.render('terms');
});

// Card preview page
app.get('/card/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const collection = await prisma.itemCollection.findUnique({
      where: { code: code.toUpperCase() }
    });

    if (!collection) {
      return res.status(404).render('error', {
        pageTitle: 'Card Not Found',
        error: 'Card not found',
        message: 'The card you are looking for does not exist.'
      });
    }

    // Generate QR code for sharing
    const QRCode = require('qrcode');
    const cardPath = `/card/${collection.code}`;
    const cardUrl = buildAbsoluteUrl(req, cardPath);
    const qrCodeDataUrl = await QRCode.toDataURL(cardUrl);

    // Get captcha for report functionality
    const reportCaptcha = getCaptcha(req.session, CAPTCHA_TYPES.REPORT_CARD);

    res.render('card-preview', {
      card: collection,
      qrCode: qrCodeDataUrl,
      cardUrl: cardUrl,
      shareImage: buildAbsoluteUrl(req, '/tokyo-cam-bingo.png'),
      pageTitle: `${collection.name} - Tokyo Cam Bingo Card`,
      metaDescription: `Check out this custom Tokyo Cam Bingo card: ${collection.name} with ${collection.items.length} items.`,
      reportCaptchaQuestion: reportCaptcha.question
    });
  } catch (error) {
    console.error('Error fetching card preview:', error);
    res.status(500).render('error', {
      pageTitle: 'Error',
      error: 'Server Error',
      message: 'Failed to load card preview.'
    });
  }
});

// Public gallery page
app.get('/gallery', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 24; // Cards per page
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const sortBy = req.query.sort || 'recent'; // recent, popular
    const tagFilter = (req.query.tag || '').toString().trim(); // tag filter

    // Build where clause - only show public AND locked cards
    const whereClause = {
      isPublic: true,
      isLocked: true
    };

    // Add search filter if provided
    if (search) {
      whereClause.name = {
        contains: search,
        mode: 'insensitive'
      };
    }

    // Add tag filter if provided
    if (tagFilter) {
      whereClause.tags = {
        array_contains: tagFilter
      };
    }

    // Build orderBy clause - Featured cards always come first
    let orderBy = [];
    orderBy.push({ isFeatured: 'desc' }); // Featured first
    if (sortBy === 'popular') {
      orderBy.push({ usageCount: 'desc' });
    } else {
      orderBy.push({ createdAt: 'desc' });
    }

    // Get total count for pagination
    const totalCards = await prisma.itemCollection.count({ where: whereClause });
    const totalPages = Math.ceil(totalCards / limit);

    // Get cards for current page
    const cards = await prisma.itemCollection.findMany({
      where: whereClause,
      orderBy: orderBy,
      take: limit,
      skip: offset
    });

    // Get all unique tags from public cards for filter dropdown
    const allPublicCards = await prisma.itemCollection.findMany({
      where: { isPublic: true, isLocked: true },
      select: { tags: true }
    });

    const allTags = new Set();
    allPublicCards.forEach(card => {
      if (card.tags && Array.isArray(card.tags)) {
        card.tags.forEach(tag => allTags.add(tag));
      }
    });

    const uniqueTags = Array.from(allTags).sort();

    const translateFn = typeof res.locals.t === 'function' ? res.locals.t : () => null;
    const pageTitle = translateFn('seo.gallery.title') || 'Browse Gamer Bingo Cards - Tokyo Cam Bingo';
    const metaDescription = translateFn('seo.gallery.description') || 'Discover gamer bingo and lockout bingo cards created by the Tokyo Cam Bingo community.';

    res.render('gallery', {
      cards: cards,
      currentPage: page,
      totalPages: totalPages,
      totalCards: totalCards,
      search: search,
      sortBy: sortBy,
      tagFilter: tagFilter,
      availableTags: uniqueTags,
      pageTitle,
      metaDescription
    });
  } catch (error) {
    console.error('Error fetching gallery:', error);
    res.status(500).render('error', {
      pageTitle: 'Error',
      error: 'Server Error',
      message: 'Failed to load gallery.'
    });
  }
});

// Create custom card collection
app.get('/api/captcha/:type', (req, res) => {
  const { type } = req.params;
  if (!Object.values(CAPTCHA_TYPES).includes(type)) {
    return res.status(400).json({ error: 'Unsupported captcha type' });
  }
  const captcha = getCaptcha(req.session, type, { refresh: true });
  res.json({ question: captcha.question });
});

app.post('/api/card-collections', cardWriteLimiter, csrfProtection, async (req, res) => {
  try {
    const { name, items, captchaAnswer, isLocked, isPublic, creatorName, tags, tosAccepted } = req.body;

    if (!validateCaptcha(req.session, CAPTCHA_TYPES.CARD_BUILDER, captchaAnswer)) {
      return res.status(400).json({ error: 'Captcha answer incorrect. Please try again.' });
    }

    // Validation
    if (!name || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Name and items array required' });
    }

    if (items.length < 25) {
      return res.status(400).json({ error: 'Minimum 25 items required' });
    }

    // Require TOS acceptance
    if (!tosAccepted) {
      return res.status(400).json({ error: 'You must accept the Terms of Service to create a card' });
    }

    // Only allow isPublic if card is locked
    const shouldBePublic = isPublic && isLocked;

    // Generate unique code
    let code;
    let codeExists = true;
    while (codeExists) {
      code = generateCode();
      const existing = await prisma.itemCollection.findUnique({ where: { code } });
      codeExists = !!existing;
    }

    // Create collection
    const collection = await prisma.itemCollection.create({
      data: {
        code,
        name,
        items: items,
        isLocked: isLocked || false,
        isPublic: shouldBePublic,
        creatorName: creatorName || null,
        tags: tags || null,
        tosAcceptedAt: new Date()
      }
    });

    res.json({ code: collection.code, id: collection.id });
  } catch (error) {
    console.error('Error creating card collection:', error);
    res.status(500).json({ error: 'Failed to create card collection' });
  }
});

// Get card collection by code
app.get('/api/card-collections/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const collection = await prisma.itemCollection.findUnique({
      where: { code: code.toUpperCase() }
    });

    if (!collection) {
      return res.status(404).json({ error: 'Card not found' });
    }

    res.json({
      code: collection.code,
      name: collection.name,
      items: collection.items,
      itemCount: collection.items.length,
      isLocked: collection.isLocked
    });
  } catch (error) {
    console.error('Error fetching card collection:', error);
    res.status(500).json({ error: 'Failed to fetch card collection' });
  }
});

// Update card collection by code
app.put('/api/card-collections/:code', cardWriteLimiter, csrfProtection, async (req, res) => {
  try {
    const { code } = req.params;
    const { name, items, captchaAnswer } = req.body;

    if (!validateCaptcha(req.session, CAPTCHA_TYPES.CARD_BUILDER, captchaAnswer)) {
      return res.status(400).json({ error: 'Captcha answer incorrect. Please try again.' });
    }

    // Validation
    if (!name || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Name and items array required' });
    }

    if (items.length < 25) {
      return res.status(400).json({ error: 'Minimum 25 items required' });
    }

    // Find existing collection
    const existing = await prisma.itemCollection.findUnique({
      where: { code: code.toUpperCase() }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Check if card is locked
    if (existing.isLocked) {
      return res.status(403).json({
        error: 'This card is locked and cannot be edited. You can duplicate it from the Template tab to create your own version.'
      });
    }

    // Update collection
    const updated = await prisma.itemCollection.update({
      where: { code: code.toUpperCase() },
      data: {
        name,
        items: items
      }
    });

    res.json({ code: updated.code, id: updated.id });
  } catch (error) {
    console.error('Error updating card collection:', error);
    res.status(500).json({ error: 'Failed to update card collection' });
  }
});

// Report inappropriate card
app.post('/api/report-card', async (req, res) => {
  try {
    const { cardCode, reason, captchaAnswer } = req.body;

    // Validate captcha first
    if (!validateCaptcha(req.session, CAPTCHA_TYPES.REPORT_CARD, captchaAnswer)) {
      return res.status(400).json({ success: false, error: 'Captcha answer incorrect. Please try again.' });
    }

    if (!cardCode || !reason) {
      return res.status(400).json({ success: false, error: 'Card code and reason required' });
    }

    // Verify card exists
    const card = await prisma.itemCollection.findUnique({
      where: { code: cardCode.toUpperCase() }
    });

    if (!card) {
      return res.status(404).json({ success: false, error: 'Card not found' });
    }

    // Store report in database
    const report = await prisma.cardReport.create({
      data: {
        cardCode: cardCode.toUpperCase(),
        reason: reason.trim()
      }
    });

    console.log(`CARD REPORT CREATED - ID: ${report.id}, Code: ${cardCode}, Card Name: ${card.name}`);

    res.json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('Error reporting card:', error);
    res.status(500).json({ success: false, error: 'Failed to submit report' });
  }
});

// ============================================
// ADMIN ROUTES (Hidden)
// ============================================

function markAdminSessionExpired(session) {
  if (!session) return;
  delete session.isAdmin;
  delete session.adminLastActiveAt;
}

function hasActiveAdminSession(session) {
  if (!session || !session.isAdmin) {
    return false;
  }
  const now = Date.now();
  const lastActive = typeof session.adminLastActiveAt === 'number' ? session.adminLastActiveAt : now;
  if (now - lastActive > ADMIN_IDLE_TIMEOUT_MS) {
    markAdminSessionExpired(session);
    return false;
  }
  session.adminLastActiveAt = now;
  return true;
}

function sendAdminUnauthorized(req, res, message) {
  const wantsJson = req.path.startsWith('/admin-dashboard-secret/api/') || requestPrefersJson(req);
  if (wantsJson) {
    return res.status(401).json({ error: message });
  }
  return res.status(401).send(message);
}

// Admin middleware - check if user is authenticated
function requireAdmin(req, res, next) {
  const hadSession = Boolean(req.session?.isAdmin);
  if (hasActiveAdminSession(req.session)) {
    return next();
  }
  const message = hadSession ? 'Admin session expired. Please login again.' : 'Unauthorized. Please login first.';
  return sendAdminUnauthorized(req, res, message);
}

// Admin login page (hidden route)
app.get('/admin-dashboard-secret', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin-dashboard-secret/dashboard');
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Admin Login</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background: #f5f5f5;
          margin: 0;
        }
        .login-box {
          background: white;
          padding: 2rem;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          max-width: 400px;
          width: 100%;
        }
        h1 {
          margin: 0 0 1.5rem 0;
          color: #333;
        }
        form {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        input {
          padding: 0.75rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
        }
        button {
          padding: 0.75rem;
          background: #FF69B4;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 1rem;
          cursor: pointer;
        }
        button:hover {
          background: #FF1493;
        }
        .error {
          color: red;
          font-size: 0.9rem;
        }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h1>🔒 Admin Login</h1>
        <form action="/admin-dashboard-secret/login" method="POST">
          <input type="password" name="password" placeholder="Enter admin password" required>
          <button type="submit">Login</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// Admin login handler
app.post('/admin-dashboard-secret/login', express.urlencoded({ extended: true }), (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.adminLastActiveAt = Date.now();
    return res.redirect('/admin-dashboard-secret/dashboard');
  }
  res.send('Invalid password. <a href="/admin-dashboard-secret">Try again</a>');
});

// Admin logout
app.get('/admin-dashboard-secret/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destruction error:', err);
    }
    res.redirect('/admin-dashboard-secret');
  });
});

// Admin dashboard (main view)
app.get('/admin-dashboard-secret/dashboard', requireAdmin, async (req, res) => {
  try {
    const pendingReports = await prisma.cardReport.count({ where: { status: 'pending' } });
    const totalReports = await prisma.cardReport.count();
    const totalCards = await prisma.itemCollection.count();
    const publicCards = await prisma.itemCollection.count({ where: { isPublic: true, isLocked: true } });

    res.render('admin-dashboard', {
      pendingReports,
      totalReports,
      totalCards,
      publicCards,
      pageTitle: 'Admin Dashboard',
      locale: req.locale || 'en',
      assetVersion: process.env.npm_package_version || Date.now(),
      adminHeartbeatInterval: ADMIN_HEARTBEAT_INTERVAL_MS
    });
  } catch (error) {
    console.error('Error loading admin dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// Keep admin sessions alive only while dashboard is open
app.post('/admin-dashboard-secret/api/heartbeat', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    timeoutMs: ADMIN_IDLE_TIMEOUT_MS
  });
});

// Admin API - Get all reports
app.get('/admin-dashboard-secret/api/reports', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'all';
    const whereClause = status === 'all' ? {} : { status };

    const reports = await prisma.cardReport.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    // Fetch card details for each report
    const reportsWithCards = await Promise.all(reports.map(async (report) => {
      const card = await prisma.itemCollection.findUnique({
        where: { code: report.cardCode }
      });
      return { ...report, card };
    }));

    res.json(reportsWithCards);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// Admin API - Update report status
app.post('/admin-dashboard-secret/api/reports/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'reviewed', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updated = await prisma.cardReport.update({
      where: { id },
      data: {
        status,
        reviewedAt: status !== 'pending' ? new Date() : null
      }
    });

    res.json({ success: true, report: updated });
  } catch (error) {
    console.error('Error updating report:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// Admin API - Delete card
app.delete('/admin-dashboard-secret/api/cards/:code', requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;
    const upperCode = code.toUpperCase();

    // First, delete any related CardReports (cascade delete)
    const deletedReports = await prisma.cardReport.deleteMany({
      where: { cardCode: upperCode }
    });

    // Then delete the card itself
    await prisma.itemCollection.delete({
      where: { code: upperCode }
    });

    console.log(`ADMIN ACTION - Deleted card: ${code} (and ${deletedReports.count} related reports)`);
    res.json({
      success: true,
      message: 'Card deleted successfully',
      deletedReports: deletedReports.count
    });
  } catch (error) {
    console.error('Error deleting card:', error);

    // Provide more detailed error message
    let errorMessage = 'Failed to delete card';
    if (error.code === 'P2025') {
      errorMessage = 'Card not found';
    } else if (error.message) {
      errorMessage = `Failed to delete card: ${error.message}`;
    }

    res.status(500).json({ error: errorMessage });
  }
});

// Admin API - Toggle featured status
app.post('/admin-dashboard-secret/api/cards/:code/featured', requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;
    const { isFeatured } = req.body;

    const card = await prisma.itemCollection.update({
      where: { code: code.toUpperCase() },
      data: { isFeatured: isFeatured }
    });

    console.log(`ADMIN ACTION - Set card ${code} featured status to: ${isFeatured}`);
    res.json({ success: true, isFeatured: card.isFeatured });
  } catch (error) {
    console.error('Error updating featured status:', error);
    res.status(500).json({ error: 'Failed to update featured status' });
  }
});

// Admin API - Toggle locked status
app.post('/admin-dashboard-secret/api/cards/:code/locked', requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;
    const { isLocked } = req.body;

    const card = await prisma.itemCollection.update({
      where: { code: code.toUpperCase() },
      data: { isLocked: isLocked }
    });

    console.log(`ADMIN ACTION - Set card ${code} locked status to: ${isLocked}`);
    res.json({ success: true, isLocked: card.isLocked });
  } catch (error) {
    console.error('Error updating locked status:', error);
    res.status(500).json({ error: 'Failed to update locked status' });
  }
});

// Admin API - Toggle public status
app.post('/admin-dashboard-secret/api/cards/:code/public', requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;
    const { isPublic } = req.body;
    const upperCode = code.toUpperCase();

    // Get current card to check if it's locked
    const currentCard = await prisma.itemCollection.findUnique({
      where: { code: upperCode }
    });

    if (!currentCard) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Only allow making public if card is locked
    if (isPublic && !currentCard.isLocked) {
      return res.status(400).json({ error: 'Card must be locked before making it public' });
    }

    const card = await prisma.itemCollection.update({
      where: { code: upperCode },
      data: { isPublic: isPublic }
    });

    console.log(`ADMIN ACTION - Set card ${code} public status to: ${isPublic}`);
    res.json({ success: true, isPublic: card.isPublic });
  } catch (error) {
    console.error('Error updating public status:', error);
    res.status(500).json({ error: 'Failed to update public status' });
  }
});

// Admin API - Get all cards
app.get('/admin-dashboard-secret/api/cards', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    const cards = await prisma.itemCollection.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    });

    const totalCards = await prisma.itemCollection.count();

    res.json({
      cards,
      currentPage: page,
      totalPages: Math.ceil(totalCards / limit),
      totalCards
    });
  } catch (error) {
    console.error('Error fetching cards:', error);
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

// Provide default Tokyo Cam Bingo deck
app.get('/api/default-card', (req, res) => {
  try {
    const locale = req.locale || 'en';
    const localizedItems = itemsList.map((item) => translateItemText(locale, item));
    res.json({
      name: translate(locale, 'home.bingoDefaultOption'),
      items: localizedItems,
      itemCount: localizedItems.length
    });
  } catch (error) {
    console.error('Error loading default card:', error);
    res.status(500).json({ error: 'Failed to load default card' });
  }
});

// Bingo tasks metadata for preset selection
app.get('/api/bingo-tasks/meta', (req, res) => {
  try {
    const meta = getBingoTasksMeta();
    const locale = req.locale || 'en';
    const translateLabel = (value) => {
      const normalized = normalizeMetaKey(value);
      if (!normalized) return value;
      const key = `bingo.meta.${normalized}`;
      const translated = translate(locale, key);
      if (translated && translated !== key) {
        return translated;
      }
      return value;
    };
    const categories = meta.categories.map((category) => ({
      ...category,
      label: translateLabel(category.label || category.value)
    }));
    const games = meta.games.map((game) => ({
      ...game,
      label: translateLabel(game.label || game.value)
    }));
    res.json({
      categories,
      games,
      minItems: MIN_POOL_SIZE
    });
  } catch (error) {
    console.error('Error fetching bingo tasks metadata:', error);
    res.status(500).json({ error: 'Failed to load bingo tasks metadata' });
  }
});

// Bingo tasks pool for builder/templates
app.get('/api/bingo-tasks/pool', (req, res) => {
  try {
    const { type, value } = req.query;
    if (!type) {
      return res.status(400).json({ error: 'type query parameter is required' });
    }

    const locale = req.locale || 'en';
    let entries = [];
    let label = '';
    if (type === 'all') {
      entries = getAllTasksPool();
      label = 'All Bingo Tasks';
    } else if (type === 'category') {
      if (!value) return res.status(400).json({ error: 'value parameter required for category type' });
      entries = getCategoryPool(value);
      const meta = getBingoTasksMeta();
      const bucket = meta.categories.find(cat => cat.value === value);
      label = bucket ? bucket.label : value;
    } else if (type === 'game') {
      if (!value) return res.status(400).json({ error: 'value parameter required for game type' });
      entries = getGamePool(value);
      const meta = getBingoTasksMeta();
      const bucket = meta.games.find(game => game.value === value);
      label = bucket ? bucket.label : value;
    } else {
      return res.status(400).json({ error: 'Invalid type parameter' });
    }

    if (!entries || entries.length < MIN_POOL_SIZE) {
      return res.status(404).json({ error: 'Preset does not have enough items to build a card' });
    }

    const items = entries.map((entry) => ({
      id: entry.id,
      text: translateTaskText(locale, entry, entry.text),
      rawText: entry.text
    }));

    res.json({
      type,
      value: value || null,
      label,
      items,
      itemCount: items.length
    });
  } catch (error) {
    console.error('Error fetching bingo task pool:', error);
    res.status(500).json({ error: 'Failed to load bingo task pool' });
  }
});

// Game info endpoint (for checking mode and available colors)
app.get('/game-info/:code', async (req, res) => {
  const { code } = req.params;
  const game = await prisma.game.findUnique({
    where: { code: code.toUpperCase() },
    include: { players: { select: { color: true, name: true } } }
  });
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const takenColors = game.players.map(p => p.color).filter(Boolean);
  res.json({
    mode: game.mode,
    takenColors,
    playerCount: game.players.length,
    maxPlayers: game.mode === 'VS' ? 4 : 10,
    hostColor: game.players.find(p => p.color)?.color || null // Include info about host's color
  });
});

// Create game
app.post('/create', createJoinLimiter, csrfProtection, async (req, res) => {
  let winConditions = req.body.winConditions || [];
  if (!Array.isArray(winConditions)) {
    winConditions = [winConditions];
  }
  const {
    hostName,
    modeType,
    flagsEnabled,
    rerollsEnabled,
    hostColor,
    customCardCode,
    timerEnabled,
    timerDuration,
    bingoCardPreset,
    bingoCategory,
    bingoGame,
    captchaAnswer
  } = req.body;
  if (!validateCaptcha(req.session, CAPTCHA_TYPES.CREATE_GAME, captchaAnswer)) {
    return res.status(400).send('Captcha answer incorrect. Please try again.');
  }
  const code = generateCode();
  const mode = modeType === 'VS' ? 'VS' : 'REGULAR';

  if (mode !== 'VS') {
    if (timerEnabled === 'true') {
      if (!winConditions.includes('most_squares')) {
        winConditions.push('most_squares');
      }
    } else {
      winConditions = winConditions.filter(condition => condition !== 'most_squares');
    }
  }

  winConditions = [...new Set(winConditions)];

  // Fetch custom items if card code provided
  let customItems = null;
  let cardPresetDetails = null;
  const sanitizedCustomCard = (customCardCode || '').trim().toUpperCase();

  if (sanitizedCustomCard.length === 6) {
    try {
      const collection = await prisma.itemCollection.findUnique({
        where: { code: sanitizedCustomCard }
      });
      if (collection) {
        customItems = collection.items;
        cardPresetDetails = { type: 'custom_code', value: sanitizedCustomCard };

        // Increment usage count
        await prisma.itemCollection.update({
          where: { code: sanitizedCustomCard },
          data: { usageCount: { increment: 1 } }
        });
      }
    } catch (error) {
      console.error('Error fetching custom card:', error);
    }
  }

  if (!customItems) {
    const presetChoice = (bingoCardPreset || 'default').toLowerCase();
    const categoryValue = (bingoCategory || '').trim();
    const gameValue = (bingoGame || '').trim();
    const locale = req.locale || 'en';

    if (presetChoice === 'category') {
      if (!categoryValue) {
        return res.status(400).send('Please select a bingo task category.');
      }
      const entries = getCategoryPool(categoryValue);
      if (!entries.length || entries.length < MIN_POOL_SIZE) {
        return res.status(400).send(`Selected category does not have enough prompts (need ${MIN_POOL_SIZE}).`);
      }
      customItems = entries.map((entry) => translateTaskText(locale, entry, entry.text));
      cardPresetDetails = { type: 'category', value: categoryValue };
    } else if (presetChoice === 'game') {
      if (!gameValue) {
        return res.status(400).send('Please select a bingo task game.');
      }
      const entries = getGamePool(gameValue);
      if (!entries.length || entries.length < MIN_POOL_SIZE) {
        return res.status(400).send(`Selected game does not have enough prompts (need ${MIN_POOL_SIZE}).`);
      }
      customItems = entries.map((entry) => translateTaskText(locale, entry, entry.text));
      cardPresetDetails = { type: 'game', value: gameValue };
    } else if (presetChoice === 'all') {
      const entries = getAllTasksPool();
      if (!entries.length || entries.length < MIN_POOL_SIZE) {
        return res.status(400).send('Not enough bingo tasks available to build a deck.');
      }
      customItems = entries.map((entry) => translateTaskText(locale, entry, entry.text));
      cardPresetDetails = { type: 'all', value: 'all' };
    }
  }

  const sharedCard = mode === 'VS' ? generateCard(customItems) : null;

  // Validate host color for VS mode
  if (mode === 'VS') {
    const validColors = ['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE', 'ORANGE', 'PINK', 'CYAN'];
    if (!hostColor || !validColors.includes(hostColor)) {
      return res.status(400).send('Please select a color for VS mode');
    }
  }

  const rulesPayload = { winConditions };
  if (cardPresetDetails) {
    rulesPayload.cardPreset = cardPresetDetails;
  }

  const game = await prisma.game.create({
    data: {
      code,
      rules: rulesPayload,
      mode,
      sharedCard,
      customItems,
      flagsEnabled: flagsEnabled === 'true',
      rerollsEnabled: rerollsEnabled === 'true',
      timerEnabled: timerEnabled === 'true',
      timerDuration: timerEnabled === 'true' ? parseInt(timerDuration) || 300 : null,
      timerStatus: timerEnabled === 'true' ? 'not_started' : 'not_started',
      timerStartedAt: null,
      timerPausedAt: null,
      timerAccumulatedPause: 0
    },
  });

  // In VS mode, host doesn't get individual card, in regular mode they do
  const card = mode === 'VS' ? sharedCard : generateCard(customItems);
  const player = await prisma.player.create({
    data: {
      name: hostName,
      isHost: true,
      gameId: game.id,
      card,
      color: mode === 'VS' ? hostColor : null,
      stampedSquares: mode === 'VS' ? [] : null,
      themePreference: req.theme || DEFAULT_THEME
    },
  });
  req.session.gameId = game.id;
  req.session.playerId = player.id;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error on create:', err);
      return res.status(500).send('Failed to start game.');
    }
    res.redirect('/game');
  });
});

// Join game
app.post('/join', createJoinLimiter, csrfProtection, async (req, res) => {
  const { code, playerName, playerColor } = req.body;
  const sanitizedCode = (code || '').trim().toUpperCase();
  const game = await prisma.game.findUnique({ where: { code: sanitizedCode } });
  if (!game) return res.status(404).send('Game not found');
  const players = await prisma.player.findMany({ where: { gameId: game.id } });

  // Check player cap based on game mode
  const maxPlayers = game.mode === 'VS' ? 4 : 10;
  if (players.length >= maxPlayers) return res.status(400).send('Game full');
  if (players.some(p => p.name === playerName)) return res.status(400).send('Name taken');

  // VS mode validations
  if (game.mode === 'VS') {
    if (!playerColor) return res.status(400).send('Color selection required for VS mode');
    const validColors = ['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE', 'ORANGE', 'PINK', 'CYAN'];
    if (!validColors.includes(playerColor)) return res.status(400).send('Invalid color');
    if (players.some(p => p.color === playerColor)) return res.status(400).send('Color already taken');
  }

  // Determine card based on mode
  let card;
  const customItems = game.customItems || null;

  if (game.mode === 'VS') {
    // Use shared card for VS mode
    card = game.sharedCard;
  } else {
    // Generate a unique card for regular mode
    const existingPlayers = await prisma.player.findMany({
      where: { gameId: game.id },
      select: { card: true },
    });
    do {
      card = generateCard(customItems);
    } while (existingPlayers.some(p => JSON.stringify(p.card) === JSON.stringify(card)));
  }

  const player = await prisma.player.create({
    data: {
      name: playerName,
      gameId: game.id,
      card,
      color: game.mode === 'VS' ? playerColor : null,
      stampedSquares: game.mode === 'VS' ? [] : null,
      themePreference: req.theme || DEFAULT_THEME
    },
  });
  req.session.gameId = game.id;
  req.session.playerId = player.id;

  // Broadcast update
  const updatedGame = await prisma.game.findUnique({
    where: { id: game.id },
    include: { players: true },
  });
  io.to(game.id).emit('update_state', { game: updatedGame, players: updatedGame.players });

  req.session.save((err) => {
    if (err) {
      console.error('Session save error on join:', err);
      return res.status(500).send('Failed to join game.');
    }
    res.redirect('/game');
  });
});

// Game page
app.get('/game', async (req, res) => {
  const { gameId, playerId } = req.session;
  if (!gameId || !playerId) return res.redirect('/');
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { players: true },
  });
  if (!game) return res.redirect('/');
  const player = game.players.find(p => p.id === playerId);
  if (!player) return res.redirect('/');
  let requestTheme = normalizeTheme(req.theme);
  const playerTheme = normalizeTheme(player.themePreference);

  if (requestTheme && requestTheme !== playerTheme) {
    await persistPlayerThemePreference(req, requestTheme);
  } else if (!requestTheme && playerTheme) {
    persistThemePreference(req, res, playerTheme);
    req.theme = playerTheme;
    requestTheme = playerTheme;
  }

  const effectiveTheme = requestTheme || playerTheme || DEFAULT_THEME;

  if (!requestTheme && !playerTheme) {
    persistThemePreference(req, res, effectiveTheme);
    req.theme = effectiveTheme;
  }

  res.locals.theme = effectiveTheme;
  // Fetch chat messages for this game
  const rawMessages = await prisma.chatMessage.findMany({
    where: { gameId },
    orderBy: { createdAt: 'asc' },
    include: { player: { select: { id: true, name: true } } },
  });

  const messages = rawMessages.map(msg => ({
    id: msg.id,
    playerId: msg.playerId,
    content: msg.content,
    createdAt: msg.createdAt,
    playerName: msg.player?.name || 'Unknown player'
  }));

  res.render('game', { game, players: game.players, currentPlayer: player, messages });
});

// Popout card view (minimal, transparent, for streaming)
app.get('/game/:gameId/popout', async (req, res) => {
  const { gameId } = req.params;
  const { playerId } = req.query;

  if (!gameId || !playerId) return res.redirect('/');

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { players: true },
  });

  if (!game) return res.redirect('/');

  const player = game.players.find(p => p.id === playerId);
  if (!player) return res.redirect('/');

  const queryTheme = normalizeTheme(req.query?.theme);
  let requestTheme = normalizeTheme(req.theme);
  let playerTheme = normalizeTheme(player.themePreference);
  let effectiveTheme = queryTheme || requestTheme || playerTheme || DEFAULT_THEME;

  if (queryTheme && queryTheme !== playerTheme) {
    try {
      await prisma.player.update({ where: { id: player.id }, data: { themePreference: queryTheme } });
      playerTheme = queryTheme;
    } catch (error) {
      console.warn('Failed to update player theme preference from popout', error?.message || error);
    }
  } else if (!queryTheme && requestTheme && requestTheme !== playerTheme) {
    await persistPlayerThemePreference(req, requestTheme);
    playerTheme = requestTheme;
  } else if (!queryTheme && !requestTheme && playerTheme) {
    persistThemePreference(req, res, playerTheme);
    req.theme = playerTheme;
    requestTheme = playerTheme;
  }

  effectiveTheme = queryTheme || requestTheme || playerTheme || DEFAULT_THEME;

  persistThemePreference(req, res, effectiveTheme);
  req.theme = effectiveTheme;
  res.locals.theme = effectiveTheme;

  // Set session for socket authentication (needed for OBS Browser Source)
  req.session.gameId = gameId;
  req.session.playerId = playerId;

  res.render('popout', { game, players: game.players, currentPlayer: player, theme: effectiveTheme });
});

// Get game code (for copy, host-only)
app.get('/get-code', async (req, res) => {
  const { gameId, playerId } = req.session;
  if (!gameId || !playerId) return res.status(404).send('Not found');
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player || !player.isHost) return res.status(403).send('Forbidden');
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).send('Not found');
  res.send(game.code);
});

// Socket.io for real-time
io.on('connection', (socket) => {
  socket.on('join_room', async () => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;

    const playerKey = getPlayerKey(playerId);
    if (!playerKey) return;

    socket.join(gameId);
    if (flagsLeft[playerKey] === undefined) {
      flagsLeft[playerKey] = 2;
    }

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (!game) return;

    if (game.timerEnabled && game.timerStatus === 'running' && !timerIntervals[gameId]) {
      startGameTimer(gameId);
    }

    io.to(gameId).emit('update_state', { game, players: game.players });
  });

  socket.on('stamp', async ({ row, col }) => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;
    if (isOnCooldown(playerId, 'stamp', 200)) return;

    const player = await prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true }
    });
    if (!player || player.game.id !== gameId || player.game.status === 'ended') return;

    const game = player.game;
    const isVSMode = game.mode === 'VS';

    // Convert row and col to integers to ensure type consistency
    const rowInt = parseInt(row, 10);
    const colInt = parseInt(col, 10);
    if (Number.isNaN(rowInt) || Number.isNaN(colInt)) return;

    if (isVSMode) {
      // VS Mode stamping logic
      let stampedSquares = player.stampedSquares || [];

      const existingStampIndex = stampedSquares.findIndex(
        s => s.row === rowInt && s.col === colInt
      );

      if (existingStampIndex !== -1) {
        // Player is unstamping their own square
        stampedSquares.splice(existingStampIndex, 1);
      } else {
        // Check if another player has already stamped this square
        const allPlayers = await prisma.player.findMany({ where: { gameId } });
        const isStampedByOther = allPlayers.some(p => {
          if (p.id === playerId) return false;
          const squares = p.stampedSquares || [];
          return squares.some(s => s.row === rowInt && s.col === colInt);
        });

        if (!isStampedByOther) {
          // Add stamp with integer row/col
          stampedSquares.push({ row: rowInt, col: colInt, color: player.color });
        } else {
          // Square already stamped by another player, do nothing
          return;
        }
      }

      await prisma.player.update({
        where: { id: playerId },
        data: { stampedSquares }
      });

      // Check win condition for this player
      const updatedPlayers = await prisma.player.findMany({ where: { gameId } });
      let updatedGame = game;

      // Check traditional win conditions first
      const winResult = checkWin(stampedSquares, game.rules.winConditions, { isVSMode: true });
      if (winResult.won) {
        updatedGame = await prisma.game.update({
          where: { id: gameId },
          data: { status: 'ended', winner: player.name }
        });
        io.to(gameId).emit('win', { playerName: player.name, winCondition: winResult.condition });
      }
      // Check if board is full and most_squares is enabled
      else if (game.rules.winConditions.includes('most_squares')) {
        // Count total stamped squares across all players
        const totalStamped = updatedPlayers.reduce((sum, p) => {
          return sum + (p.stampedSquares || []).length;
        }, 0);

        // If all 25 squares are stamped, determine winner by most squares
        if (totalStamped === 25) {
          // Find player with most stamps
          let maxStamps = 0;
          let winner = null;
          let isTie = false;

          updatedPlayers.forEach(p => {
            const stampCount = (p.stampedSquares || []).length;
            if (stampCount > maxStamps) {
              maxStamps = stampCount;
              winner = p.name;
              isTie = false;
            } else if (stampCount === maxStamps) {
              isTie = true;
            }
          });

          if (winner && !isTie) {
            updatedGame = await prisma.game.update({
              where: { id: gameId },
              data: { status: 'ended', winner }
            });
            io.to(gameId).emit('win', { playerName: winner, winCondition: 'Most Squares' });
          }
        }
      }

      io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });

    } else {
      // Regular mode stamping logic (original)
      const card = player.card;
      const wasStamped = card[rowInt][colInt].stamped;
      card[rowInt][colInt].stamped = !wasStamped;
      await prisma.player.update({ where: { id: playerId }, data: { card } });

      const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
      let updatedGame = game;

      const winResult = checkWin(card, game.rules.winConditions, { isVSMode: false });
      if (!wasStamped && winResult.won) {
        updatedGame = await prisma.game.update({
          where: { id: gameId },
          data: { status: 'ended', winner: player.name }
        });
        io.to(gameId).emit('win', { playerName: player.name, winCondition: winResult.condition });
      }

      io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });
    }
  });

  socket.on('card_revealed', async () => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;

    // Update player's cardRevealed status in database
    await prisma.player.update({
      where: { id: playerId },
      data: { cardRevealed: true }
    });

    // Broadcast to all clients in the room that the card was revealed
    io.to(gameId).emit('card_revealed', { playerId });
  });

  socket.on('reroll', async ({ targetPlayerId, type, arg }) => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;
    if (!type) return;
    if (isOnCooldown(playerId, 'reroll', 4000)) return;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (!game || game.status === 'ended') return;

    const requestingPlayer = game.players.find(p => p.id === playerId);
    if (!requestingPlayer || !requestingPlayer.isHost) return;

    const targetId = targetPlayerId ? String(targetPlayerId) : null;

    if (game.mode === 'VS') {
      // VS Mode: Reroll shared card and clear stamps from affected squares
      const customItems = game.customItems || null;
      const newCard = rerollCard(game.sharedCard, type, arg, customItems);

      // Determine which positions were rerolled
      let positions = [];
      if (type === 'tile') {
        const [rowStr, colStr] = arg.split(',');
        const row = parseInt(rowStr) - 1;
        const col = parseInt(colStr) - 1;
        positions = [[row, col]];
      } else if (type === 'row') {
        const row = parseInt(arg) - 1;
        positions = Array.from({ length: 5 }, (_, col) => [row, col]);
      } else if (type === 'column') {
        const col = parseInt(arg) - 1;
        positions = Array.from({ length: 5 }, (_, row) => [row, col]);
      } else if (type === 'diagonal') {
        if (arg === 'main') {
          positions = Array.from({ length: 5 }, (_, i) => [i, i]);
        } else if (arg === 'anti') {
          positions = Array.from({ length: 5 }, (_, i) => [i, 4 - i]);
        }
      } else if (type === 'card') {
        positions = Array.from({ length: 25 }, (_, i) => [Math.floor(i / 5), i % 5]);
      }

      // Update shared card
      await prisma.game.update({
        where: { id: gameId },
        data: { sharedCard: newCard }
      });

      // Update all players' cards and clear stamps from rerolled positions
      for (const player of game.players) {
        let stampedSquares = player.stampedSquares || [];
        // Remove stamps from rerolled positions
        stampedSquares = stampedSquares.filter(s =>
          !positions.some(([r, c]) => r === s.row && c === s.col)
        );
        await prisma.player.update({
          where: { id: player.id },
          data: { card: newCard, stampedSquares }
        });
      }

      const updatedGame = await prisma.game.findUnique({
        where: { id: gameId },
        include: { players: true }
      });
      const updatedPlayers = await prisma.player.findMany({ where: { gameId } });
      io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });
    } else {
      // Regular mode: Reroll individual player's card
      const target = game.players.find(p => String(p.id) === targetId);
      if (!target) return;
      const customItems = game.customItems || null;
      const newCard = rerollCard(target.card, type, arg, customItems);
      await prisma.player.update({ where: { id: target.id }, data: { card: newCard } });
      const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
      io.to(gameId).emit('update_state', { game, players: updatedPlayers });
    }

  });

  socket.on('new_game', async () => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;
    if (isOnCooldown(playerId, 'new_game', 5000)) return;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (!game || game.status !== 'ended') return;
    const requestingPlayer = game.players.find(p => p.id === playerId);
    if (!requestingPlayer || !requestingPlayer.isHost) return;

    // Stop existing timer
    stopGameTimer(gameId);

    if (game.mode === 'VS') {
      // VS Mode: Generate new shared card and reset all player stamps
      const customItems = game.customItems || null;
      const newSharedCard = generateCard(customItems);

      const updateData = {
        status: 'active',
        winner: null,
        sharedCard: newSharedCard
      };

      // Reset timer if it was enabled
      if (game.timerEnabled) {
        updateData.timerStatus = 'not_started';
        updateData.timerStartedAt = null;
        updateData.timerPausedAt = null;
        updateData.timerAccumulatedPause = 0;
      }

      const updatedGame = await prisma.game.update({
        where: { id: gameId },
        data: updateData
      });

      // Reset all players with the new shared card and clear stamps
      for (const player of game.players) {
        await prisma.player.update({
          where: { id: player.id },
          data: { card: newSharedCard, stampedSquares: [], cardRevealed: false }
        });
      }

      const updatedPlayers = await prisma.player.findMany({ where: { gameId } });
      io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });
    } else {
      // Regular mode: Generate unique cards for each player
      const customItems = game.customItems || null;

      const updateData = {
        status: 'active',
        winner: null
      };

      // Reset timer if it was enabled
      if (game.timerEnabled) {
        updateData.timerStatus = 'not_started';
        updateData.timerStartedAt = null;
        updateData.timerPausedAt = null;
        updateData.timerAccumulatedPause = 0;
      }

      const updatedGame = await prisma.game.update({
        where: { id: gameId },
        data: updateData
      });

      const usedCards = [];
      for (const player of game.players) {
        let uniqueCard;
        do {
          uniqueCard = generateCard(customItems);
        } while (usedCards.includes(JSON.stringify(uniqueCard)));
        usedCards.push(JSON.stringify(uniqueCard));
        await prisma.player.update({
          where: { id: player.id },
          data: { card: uniqueCard, cardRevealed: false }
        });
      }

      const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
      io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });
    }
  });

  // Handle chat messages
  socket.on('chat_message', async ({ content }) => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;
    if (isOnCooldown(playerId, 'chat', 1000)) return;
    if (typeof content !== 'string' || content.length === 0 || content.length > 300) return;
    const newMsg = await prisma.chatMessage.create({ data: { gameId, playerId, content } });
    const playerInfo = await prisma.player.findUnique({ where: { id: playerId }, select: { name: true } });
    const playerName = playerInfo?.name || 'Unknown player';
    io.to(gameId).emit('new_message', {
      message: {
        id: newMsg.id,
        playerId: newMsg.playerId,
        content: newMsg.content,
        createdAt: newMsg.createdAt.toISOString(),
      },
      playerName,
    });
  });

  // Handle timer sync request
  socket.on('timer_sync_request', async () => {
    try {
      const { gameId } = getSocketIdentity(socket);
      if (!gameId) return;

      const game = await prisma.game.findUnique({
        where: { id: gameId }
      });

      if (game && game.timerEnabled) {
        const remainingSeconds = calculateRemainingTime(game);
        socket.emit('timer_update', { remainingSeconds });
      }
    } catch (error) {
      console.error('Timer sync error:', error);
    }
  });

  // Handle manual timer start
  socket.on('start_timer', async () => {
    try {
      const { gameId, playerId } = getSocketIdentity(socket);
      if (!gameId || !playerId) return;
      if (isOnCooldown(playerId, 'timer_control', 1000)) return;

      const player = await prisma.player.findUnique({
        where: { id: playerId },
        include: { game: true }
      });
      if (!player || player.gameId !== gameId || !player.isHost) return;

      const game = player.game;

      if (game && game.timerEnabled && game.timerStatus === 'not_started') {
        const startedAt = new Date();
        await prisma.game.update({
          where: { id: gameId },
          data: {
            timerStatus: 'running',
            timerStartedAt: startedAt,
            timerPausedAt: null,
            timerAccumulatedPause: 0
          }
        });

        // Start the server-side timer
        startGameTimer(gameId);

        // Broadcast to all clients
        io.to(gameId).emit('timer_started', {
          startedAt: startedAt.toISOString(),
          remainingSeconds: game.timerDuration
        });
      }
    } catch (error) {
      console.error('Error starting timer:', error);
    }
  });

  // Handle manual timer pause
  socket.on('pause_timer', async () => {
    try {
      const { gameId, playerId } = getSocketIdentity(socket);
      if (!gameId || !playerId) return;
      if (isOnCooldown(playerId, 'timer_control', 1000)) return;

      const player = await prisma.player.findUnique({
        where: { id: playerId },
        select: { isHost: true, gameId: true }
      });
      if (!player || player.gameId !== gameId || !player.isHost) return;

      await pauseGameTimer(gameId);
      await prisma.game.update({
        where: { id: gameId },
        data: { timerStatus: 'paused' }
      });
    } catch (error) {
      console.error('Error pausing timer:', error);
    }
  });

  // Handle manual timer resume
  socket.on('resume_timer', async () => {
    try {
      const { gameId, playerId } = getSocketIdentity(socket);
      if (!gameId || !playerId) return;
      if (isOnCooldown(playerId, 'timer_control', 1000)) return;

      const player = await prisma.player.findUnique({
        where: { id: playerId },
        select: { isHost: true, gameId: true }
      });
      if (!player || player.gameId !== gameId || !player.isHost) return;

      await resumeGameTimer(gameId);
      await prisma.game.update({
        where: { id: gameId },
        data: { timerStatus: 'running' }
      });
    } catch (error) {
      console.error('Error resuming timer:', error);
    }
  });

  // Handle manual timer reset
  socket.on('reset_timer', async () => {
    try {
      const { gameId, playerId } = getSocketIdentity(socket);
      if (!gameId || !playerId) return;
      if (isOnCooldown(playerId, 'timer_control', 1000)) return;

      const player = await prisma.player.findUnique({
        where: { id: playerId },
        include: { game: true }
      });
      if (!player || player.gameId !== gameId || !player.isHost) return;

      const game = player.game;
      if (game && game.timerEnabled) {
        stopGameTimer(gameId);
        await prisma.game.update({
          where: { id: gameId },
          data: {
            timerStatus: 'not_started',
            timerStartedAt: null,
            timerPausedAt: null,
            timerAccumulatedPause: 0
          }
        });

        // Broadcast reset to all clients
        io.to(gameId).emit('timer_reset', {
          duration: game.timerDuration
        });
      }
    } catch (error) {
      console.error('Error resetting timer:', error);
    }
  });

  // Handle throwing a flag for a questionable stamp
  socket.on('throw_flag', async ({ targetPlayerId, row, col }) => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;
    if (isOnCooldown(playerId, 'throw_flag', 10000)) return;

    const flaggerKey = getPlayerKey(playerId);
    const gameKey = String(gameId);
    const targetId = typeof targetPlayerId === 'number' ? targetPlayerId : parseInt(targetPlayerId, 10);
    if (!flaggerKey || Number.isNaN(targetId)) return;

    if (votesByGame[gameKey]) return;
    if (!flagsLeft[flaggerKey] || flagsLeft[flaggerKey] <= 0) return;

    // Fetch current game players
    const gameData = await prisma.game.findUnique({ where: { id: gameId }, include: { players: true } });
    if (!gameData) return;
    const players = gameData.players;
    if (!players || players.length < 2) return; // need at least 2 players

    flagsLeft[flaggerKey]--;

    // Initialize vote state (snapshot eligible voters)
    const voteState = { flaggerId: flaggerKey, targetPlayerId: String(targetId), row, col, votes: {}, totalPlayers: 0 };
    players.forEach(p => { voteState.votes[String(p.id)] = null; });
    voteState.totalPlayers = Object.keys(voteState.votes).length;
    votesByGame[gameKey] = voteState;

    const flagger = players.find(p => String(p.id) === flaggerKey);
    const target = players.find(p => String(p.id) === String(targetId));

    io.to(gameId).emit('start_vote', {
      flaggerId: flaggerKey,
      flaggerName: flagger?.name || 'Player',
      targetPlayerId: String(targetId),
      targetPlayerName: target?.name || 'Player',
      row,
      col
    });
  });

  // Handle casting a vote
  socket.on('cast_vote', ({ vote }) => {
    const { gameId, playerId } = getSocketIdentity(socket);
    if (!gameId || !playerId) return;

    const gameKey = String(gameId);
    const voteState = votesByGame[gameKey];
    if (!voteState) return;
    const pid = String(playerId);
    if (!(pid in voteState.votes)) return; // ignore non-eligible
    if (voteState.votes[pid] !== null) return; // already voted

    voteState.votes[pid] = vote === 'yes' ? 'yes' : 'no';

    // Count votes
    const voteValues = Object.values(voteState.votes);
    const votesFor = voteValues.filter(v => v === 'yes').length;
    const votesAgainst = voteValues.filter(v => v === 'no').length;
    const votesCast = voteValues.filter(v => v !== null).length;

    // Broadcast live update
    io.to(gameId).emit('vote_update', { votesFor, votesAgainst, votesCast, totalPlayers: voteState.totalPlayers });

    // Check if all eligible voters have voted
    const allVoted = voteValues.every(v => v === 'yes' || v === 'no');
    if (allVoted) {
      const success = votesFor > votesAgainst;

      // If vote passed, remove the stamp
      if (success) {
        (async () => {
          const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: { players: true }
          });
          if (!game) return;

          if (game.mode === 'VS') {
            // VS Mode: Remove stamp from target player's stampedSquares
            const targetPlayer = game.players.find(p => String(p.id) === String(voteState.targetPlayerId));
            if (targetPlayer) {
              let stampedSquares = targetPlayer.stampedSquares || [];
              stampedSquares = stampedSquares.filter(s =>
                !(s.row === voteState.row && s.col === voteState.col)
              );
              await prisma.player.update({
                where: { id: targetPlayer.id },
                data: { stampedSquares }
              });
              const updatedPlayers = await prisma.player.findMany({ where: { gameId } });
              io.to(gameId).emit('update_state', { game, players: updatedPlayers });
            }
          } else {
            // Regular mode: Unstamp the square on target player's card
            const targetPlayer = game.players.find(p => String(p.id) === String(voteState.targetPlayerId));
            if (targetPlayer) {
              const card = targetPlayer.card;
              card[voteState.row][voteState.col].stamped = false;
              await prisma.player.update({
                where: { id: targetPlayer.id },
                data: { card }
              });
              const updatedPlayers = await prisma.player.findMany({ where: { gameId } });
              io.to(gameId).emit('update_state', { game, players: updatedPlayers });
            }
          }
        })();
      }

      io.to(gameId).emit('vote_result', {
        success,
        votes: voteState.votes,
        flaggerId: voteState.flaggerId,
        targetPlayerId: voteState.targetPlayerId,
        row: voteState.row,
        col: voteState.col
      });
      delete votesByGame[gameKey];
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
