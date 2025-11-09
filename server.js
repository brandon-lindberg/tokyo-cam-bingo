const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const itemsList = JSON.parse(fs.readFileSync('items.json'));
const uuid = require('uuid');
const session = require('express-session');
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
require('dotenv').config();
const packageJson = require('./package.json');
const { checkWin } = require('./utils/checkWin');
const {
  MIN_POOL_SIZE,
  getBingoTasksMeta,
  getCategoryPool,
  getGamePool,
  getAllTasksPool
} = require('./utils/bingoTasks');

// In-memory flags and voting state
const flagsLeft = {}; // playerId -> remaining flags
const votesByGame = {}; // gameId -> active vote state
const timerIntervals = {}; // gameId -> setInterval reference for timer

// Ensure session secret is provided
if (!process.env.SESSION_SECRET) {
  console.error('Error: SESSION_SECRET environment variable is required');
  process.exit(1);
}

app.set('view engine', 'ejs');

const buildVersion = process.env.APP_BUILD_VERSION || process.env.BUILD_ID || packageJson.version;
const enableServiceWorker = process.env.ENABLE_SERVICE_WORKER === 'true';

app.locals.assetVersion = buildVersion;
app.locals.enableServiceWorker = enableServiceWorker;

app.use((req, res, next) => {
  res.locals.assetVersion = app.locals.assetVersion;
  res.locals.enableServiceWorker = app.locals.enableServiceWorker;
  next();
});

// Add cache control middleware - no caching for HTML/dynamic content
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static('public', {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

// Serve PWA files from root
app.use('/site.webmanifest', express.static('site.webmanifest'));
app.use('/favicon.ico', express.static('favicon.ico'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
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
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

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
app.get('/', (req, res) => res.render('home'));

// Card builder page
app.get('/card-builder', (req, res) => res.render('card-builder'));

// Create custom card collection
app.post('/api/card-collections', async (req, res) => {
  try {
    const { name, items } = req.body;

    // Validation
    if (!name || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Name and items array required' });
    }

    if (items.length < 25) {
      return res.status(400).json({ error: 'Minimum 25 items required' });
    }

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
        items: items
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
      itemCount: collection.items.length
    });
  } catch (error) {
    console.error('Error fetching card collection:', error);
    res.status(500).json({ error: 'Failed to fetch card collection' });
  }
});

// Update card collection by code
app.put('/api/card-collections/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { name, items } = req.body;

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

// Bingo tasks metadata for preset selection
app.get('/api/bingo-tasks/meta', (req, res) => {
  try {
    const meta = getBingoTasksMeta();
    res.json({
      ...meta,
      minItems: MIN_POOL_SIZE
    });
  } catch (error) {
    console.error('Error fetching bingo tasks metadata:', error);
    res.status(500).json({ error: 'Failed to load bingo tasks metadata' });
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
app.post('/create', async (req, res) => {
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
    bingoGame
  } = req.body;
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
      }
    } catch (error) {
      console.error('Error fetching custom card:', error);
    }
  }

  if (!customItems) {
    const presetChoice = (bingoCardPreset || 'default').toLowerCase();
    const categoryValue = (bingoCategory || '').trim();
    const gameValue = (bingoGame || '').trim();

    if (presetChoice === 'category') {
      if (!categoryValue) {
        return res.status(400).send('Please select a bingo task category.');
      }
      const pool = getCategoryPool(categoryValue);
      if (!pool.length || pool.length < MIN_POOL_SIZE) {
        return res.status(400).send(`Selected category does not have enough prompts (need ${MIN_POOL_SIZE}).`);
      }
      customItems = pool;
      cardPresetDetails = { type: 'category', value: categoryValue };
    } else if (presetChoice === 'game') {
      if (!gameValue) {
        return res.status(400).send('Please select a bingo task game.');
      }
      const pool = getGamePool(gameValue);
      if (!pool.length || pool.length < MIN_POOL_SIZE) {
        return res.status(400).send(`Selected game does not have enough prompts (need ${MIN_POOL_SIZE}).`);
      }
      customItems = pool;
      cardPresetDetails = { type: 'game', value: gameValue };
    } else if (presetChoice === 'all') {
      const pool = getAllTasksPool();
      if (!pool.length || pool.length < MIN_POOL_SIZE) {
        return res.status(400).send('Not enough bingo tasks available to build a deck.');
      }
      customItems = pool;
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
      stampedSquares: mode === 'VS' ? [] : null
    },
  });
  req.session.gameId = game.id;
  req.session.playerId = player.id;
  res.redirect('/game');
});

// Join game
app.post('/join', async (req, res) => {
  const { code, playerName, playerColor } = req.body;
  const game = await prisma.game.findUnique({ where: { code } });
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
      stampedSquares: game.mode === 'VS' ? [] : null
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

  res.redirect('/game');
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
  // Fetch chat messages for this game
  const messages = await prisma.chatMessage.findMany({
    where: { gameId },
    orderBy: { createdAt: 'asc' },
    include: { player: { select: { id: true, name: true } } },
  });

  res.render('game', { game, players: game.players, currentPlayer: player, messages });
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
  socket.on('join_room', async ({ gameId, playerId }) => {
    socket.join(gameId);
    // Initialize flags for player
    if (flagsLeft[playerId] === undefined) {
      flagsLeft[playerId] = 2;
    }
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    // Start timer if it's already running (for reconnections)
    if (game.timerEnabled && game.timerStatus === 'running' && !timerIntervals[gameId]) {
      startGameTimer(gameId);
    }

    io.to(gameId).emit('update_state', { game, players: game.players });
  });

  socket.on('stamp', async ({ gameId, playerId, row, col }) => {
    const player = await prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true }
    });
    if (!player || player.game.id !== gameId || player.game.status === 'ended') return;

    const game = player.game;
    const isVSMode = game.mode === 'VS';

    // Convert row and col to integers to ensure type consistency
    const rowInt = parseInt(row);
    const colInt = parseInt(col);

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

  socket.on('reroll', async ({ gameId, targetPlayerId, type, arg }) => {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (game.status === 'ended') return;

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
      const target = game.players.find(p => p.id === targetPlayerId);
      if (!target) return;
      const customItems = game.customItems || null;
      const newCard = rerollCard(target.card, type, arg, customItems);
      await prisma.player.update({ where: { id: target.id }, data: { card: newCard } });
      const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
      io.to(gameId).emit('update_state', { game, players: updatedPlayers });
    }

  });

  socket.on('new_game', async ({ gameId }) => {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (game.status !== 'ended') return;

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
          data: { card: newSharedCard, stampedSquares: [] }
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
          data: { card: uniqueCard }
        });
      }

      const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
      io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });
    }
  });

  // Handle chat messages
  socket.on('chat_message', async ({ gameId, playerId, content }) => {
    if (typeof content !== 'string' || content.length === 0 || content.length > 300) return;
    const newMsg = await prisma.chatMessage.create({ data: { gameId, playerId, content } });
    const playerInfo = await prisma.player.findUnique({ where: { id: playerId }, select: { name: true } });
    io.to(gameId).emit('new_message', {
      message: {
        id: newMsg.id,
        playerId: newMsg.playerId,
        content: newMsg.content,
        createdAt: newMsg.createdAt.toISOString(),
      },
      playerName: playerInfo.name,
    });
  });

  // Handle timer sync request
  socket.on('timer_sync_request', async ({ gameId }) => {
    try {
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
  socket.on('start_timer', async ({ gameId }) => {
    try {
      const game = await prisma.game.findUnique({
        where: { id: gameId }
      });

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
  socket.on('pause_timer', async ({ gameId }) => {
    try {
      await pauseGameTimer(gameId);

      const game = await prisma.game.findUnique({
        where: { id: gameId }
      });

      if (game) {
        await prisma.game.update({
          where: { id: gameId },
          data: { timerStatus: 'paused' }
        });
      }
    } catch (error) {
      console.error('Error pausing timer:', error);
    }
  });

  // Handle manual timer resume
  socket.on('resume_timer', async ({ gameId }) => {
    try {
      await resumeGameTimer(gameId);

      const game = await prisma.game.findUnique({
        where: { id: gameId }
      });

      if (game) {
        await prisma.game.update({
          where: { id: gameId },
          data: { timerStatus: 'running' }
        });
      }
    } catch (error) {
      console.error('Error resuming timer:', error);
    }
  });

  // Handle manual timer reset
  socket.on('reset_timer', async ({ gameId }) => {
    try {
      const game = await prisma.game.findUnique({
        where: { id: gameId }
      });

      if (game && game.timerEnabled) {
        // Stop the timer
        stopGameTimer(gameId);

        // Reset timer fields
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
  socket.on('throw_flag', async ({ gameId, flaggerId, targetPlayerId, row, col }) => {
    // Prevent concurrent votes
    if (votesByGame[gameId]) return;
    // Ensure flagger has flags
    if (!flagsLeft[flaggerId] || flagsLeft[flaggerId] <= 0) return;

    // Fetch current game players
    const gameData = await prisma.game.findUnique({ where: { id: gameId }, include: { players: true } });
    if (!gameData) return;
    const players = gameData.players;
    if (!players || players.length < 2) return; // need at least 2 players

    flagsLeft[flaggerId]--;

    // Initialize vote state (snapshot eligible voters)
    const voteState = { flaggerId: String(flaggerId), targetPlayerId: String(targetPlayerId), row, col, votes: {}, totalPlayers: 0 };
    players.forEach(p => { voteState.votes[String(p.id)] = null; });
    voteState.totalPlayers = Object.keys(voteState.votes).length;
    votesByGame[gameId] = voteState;

    const flagger = players.find(p => String(p.id) === String(flaggerId));
    const target = players.find(p => String(p.id) === String(targetPlayerId));

    io.to(gameId).emit('start_vote', {
      flaggerId: String(flaggerId),
      flaggerName: flagger?.name || 'Player',
      targetPlayerId: String(targetPlayerId),
      targetPlayerName: target?.name || 'Player',
      row,
      col
    });
  });

  // Handle casting a vote
  socket.on('cast_vote', ({ gameId, playerId, vote }) => {
    const voteState = votesByGame[gameId];
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
      delete votesByGame[gameId];
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
