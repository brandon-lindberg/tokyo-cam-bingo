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

// In-memory flags and voting state
const flagsLeft = {}; // playerId -> remaining flags
const votesByGame = {}; // gameId -> active vote state

// Ensure session secret is provided
if (!process.env.SESSION_SECRET) {
  console.error('Error: SESSION_SECRET environment variable is required');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
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
  } else {
    return card;
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
  const player = await prisma.player.create({
    data: { name: hostName, isHost: true, gameId: game.id, card },
  });
  req.session.gameId = game.id;
  req.session.playerId = player.id;
  res.redirect('/game');
});

// Join game
app.post('/join', async (req, res) => {
  const { code, playerName } = req.body;
  const game = await prisma.game.findUnique({ where: { code } });
  if (!game) return res.status(404).send('Game not found');
  const players = await prisma.player.findMany({ where: { gameId: game.id } });
  if (players.length >= 10) return res.status(400).send('Game full');
  if (players.some(p => p.name === playerName)) return res.status(400).send('Name taken');
  // Generate a unique card that doesn't match existing players' cards
  const existingPlayers = await prisma.player.findMany({
    where: { gameId: game.id },
    select: { card: true },
  });
  let uniqueCard;
  do {
    uniqueCard = generateCard();
  } while (existingPlayers.some(p => JSON.stringify(p.card) === JSON.stringify(uniqueCard)));
  const player = await prisma.player.create({
    data: { name: playerName, gameId: game.id, card: uniqueCard },
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
    io.to(gameId).emit('update_state', { game, players: game.players });
  });

  socket.on('stamp', async ({ gameId, playerId, row, col }) => {
    const player = await prisma.player.findUnique({ 
      where: { id: playerId },
      include: { game: true }
    });
    if (!player || player.game.id !== gameId || player.game.status === 'ended') return;
    const card = player.card;
    const wasStamped = card[row][col].stamped;
    card[row][col].stamped = !wasStamped;
    await prisma.player.update({ where: { id: playerId }, data: { card } });

    const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
    let updatedGame = player.game;

    if (!wasStamped && checkWin(card, player.game.rules.winConditions)) {
      updatedGame = await prisma.game.update({
        where: { id: gameId },
        data: { status: 'ended', winner: player.name }
      });
      io.to(gameId).emit('win', { playerName: player.name });
    }

    io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });
  });

  socket.on('reroll', async ({ gameId, targetPlayerId, type, arg }) => {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (game.status === 'ended') return;
    const target = game.players.find(p => p.id === targetPlayerId);
    if (!target) return;
    const newCard = rerollCard(target.card, type, arg);
    await prisma.player.update({ where: { id: target.id }, data: { card: newCard } });
    const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
    io.to(gameId).emit('update_state', { game, players: updatedPlayers });
  });

  socket.on('new_game', async ({ gameId }) => {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (game.status !== 'ended') return;

    // Reset game
    const updatedGame = await prisma.game.update({
      where: { id: gameId },
      data: { status: 'active', winner: null }
    });

    // Reset cards for all players with unique cards
    const usedCards = [];
    for (const player of game.players) {
      let uniqueCard;
      do {
        uniqueCard = generateCard();
      } while (usedCards.includes(JSON.stringify(uniqueCard)));
      usedCards.push(JSON.stringify(uniqueCard));
      await prisma.player.update({
        where: { id: player.id },
        data: { card: uniqueCard }
      });
    }

    const updatedPlayers = await prisma.player.findMany({ where: { gameId: gameId } });
    io.to(gameId).emit('update_state', { game: updatedGame, players: updatedPlayers });
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