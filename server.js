const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const itemsList = JSON.parse(fs.readFileSync('items.json'));
const uuid = require('uuid');
require('dotenv').config();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Helper to generate random code
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper to generate 5x5 card
function generateCard() {
  const shuffled = [...itemsList].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, 25);
  return Array.from({ length: 5 }, (_, i) => 
    selected.slice(i * 5, (i + 1) * 5).map(item => ({ item, stamped: false }))
  );
}

// Helper to re-roll part of card
function rerollCard(card, type, arg) {
  const newCard = card.map(row => row.slice()); // Deep copy
  let positions = [];

  if (type === 'tile') {
    const [row, col] = arg.split(',').map(n => parseInt(n) - 1);
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

  // Get current items on card to avoid dups
  const currentItems = new Set(card.flat().map(t => t.item));
  const available = itemsList.filter(i => !currentItems.has(i));

  positions.forEach(([r, c]) => {
    if (available.length === 0) return; // Fallback if list exhausted
    const newItem = available[Math.floor(Math.random() * available.length)];
    newCard[r][c] = { item: newItem, stamped: false };
    // Remove to avoid dups in this re-roll
    available.splice(available.indexOf(newItem), 1);
  });

  return newCard;
}

// Helper to check win
function checkWin(card, rules) {
  // Row checks
  const stampedRows = card.map(row => row.every(t => t.stamped));
  const rowCount = stampedRows.filter(Boolean).length;

  // Column checks
  const stampedColumns = Array(5).fill(true);
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 5; row++) {
      if (!card[row][col].stamped) {
        stampedColumns[col] = false;
        break;
      }
    }
  }
  const colCount = stampedColumns.filter(Boolean).length;

  // Diagonal checks
  const diagonals = {
    main: card.every((row, i) => row[i].stamped),
    anti: card.every((row, i) => row[4 - i].stamped),
  };

  // Full card check
  const full = card.flat().every(t => t.stamped);

  if (rules.includes('row') && rowCount >= 1) return true;
  if (rules.includes('2rows') && rowCount >= 2) return true;
  if (rules.includes('3rows') && rowCount >= 3) return true;
  if (rules.includes('column') && colCount >= 1) return true;
  if (rules.includes('2columns') && colCount >= 2) return true;
  if (rules.includes('3columns') && colCount >= 3) return true;
  if (rules.includes('diagonals') && (diagonals.main || diagonals.anti)) return true;
  if (rules.includes('full') && full) return true;
  return false;
}

// Home page
app.get('/', (req, res) => res.render('home'));

// Create game
app.post('/create', async (req, res) => {
  let winConditions = req.body.winConditions || [];
  if (!Array.isArray(winConditions)) {
    winConditions = [winConditions];
  }
  const { hostName } = req.body;
  const code = generateCode();
  const game = await prisma.game.create({
    data: { code, rules: { winConditions } },
  });
  const card = generateCard();
  await prisma.player.create({
    data: { name: hostName, isHost: true, gameId: game.id, card },
  });
  res.redirect(`/game/${code}?playerName=${hostName}`);
});

// Join game
app.post('/join', async (req, res) => {
  const { code, playerName } = req.body;
  const game = await prisma.game.findUnique({ where: { code } });
  if (!game) return res.status(404).send('Game not found');
  const players = await prisma.player.findMany({ where: { gameId: game.id } });
  if (players.length >= 10) return res.status(400).send('Game full');
  if (players.some(p => p.name === playerName)) return res.status(400).send('Name taken');
  const card = generateCard();
  await prisma.player.create({
    data: { name: playerName, gameId: game.id, card },
  });
  res.redirect(`/game/${code}?playerName=${playerName}`);
});

// Game page
app.get('/game/:code', async (req, res) => {
  const { code } = req.params;
  const { playerName } = req.query;
  const game = await prisma.game.findUnique({
    where: { code },
    include: { players: true },
  });
  if (!game) return res.status(404).send('Game not found');
  const player = game.players.find(p => p.name === playerName);
  if (!player) return res.status(404).send('Player not found');
  res.render('game', { game, players: game.players, currentPlayer: player });
});

// Socket.io for real-time
io.on('connection', (socket) => {
  socket.on('join_room', async ({ code, playerName }) => {
    socket.join(code);
    const game = await prisma.game.findUnique({
      where: { code },
      include: { players: true },
    });
    io.to(code).emit('update_state', { game, players: game.players });
  });

  socket.on('stamp', async ({ code, playerId, row, col }) => {
    const player = await prisma.player.findUnique({ 
      where: { id: playerId },
      include: { game: true }
    });
    if (!player || player.game.status === 'ended') return;
    const card = player.card;
    card[row][col].stamped = true;
    await prisma.player.update({ where: { id: playerId }, data: { card } });

    const updatedPlayers = await prisma.player.findMany({ where: { gameId: player.gameId } });
    let updatedGame = player.game;

    if (checkWin(card, player.game.rules.winConditions)) {
      updatedGame = await prisma.game.update({
        where: { id: player.gameId },
        data: { status: 'ended', winner: player.name }
      });
      io.to(code).emit('win', { playerName: player.name });
    }

    io.to(code).emit('update_state', { game: updatedGame, players: updatedPlayers });
  });

  socket.on('reroll', async ({ code, targetPlayerName, type, arg }) => {
    const game = await prisma.game.findUnique({
      where: { code },
      include: { players: true },
    });
    if (game.status === 'ended') return;
    const target = game.players.find(p => p.name === targetPlayerName);
    if (!target) return;
    const newCard = rerollCard(target.card, type, arg);
    await prisma.player.update({ where: { id: target.id }, data: { card: newCard } });
    const updatedPlayers = await prisma.player.findMany({ where: { gameId: game.id } });
    io.to(code).emit('update_state', { game, players: updatedPlayers });
  });

  socket.on('new_game', async ({ code }) => {
    const game = await prisma.game.findUnique({
      where: { code },
      include: { players: true },
    });
    if (game.status !== 'ended') return;

    // Reset game
    const updatedGame = await prisma.game.update({
      where: { id: game.id },
      data: { status: 'active', winner: null }
    });

    // Reset cards for all players
    for (const player of game.players) {
      const newCard = generateCard();
      await prisma.player.update({
        where: { id: player.id },
        data: { card: newCard }
      });
    }

    const updatedPlayers = await prisma.player.findMany({ where: { gameId: game.id } });
    io.to(code).emit('update_state', { game: updatedGame, players: updatedPlayers });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));