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
function checkWin(cardOrStamps, rules) {
  // Handle VS mode (array of {row, col, color}) vs regular mode (5x5 card)
  const isVSMode = Array.isArray(cardOrStamps) && cardOrStamps.length > 0 && cardOrStamps[0].hasOwnProperty('row');

  let stampedGrid = Array(5).fill(null).map(() => Array(5).fill(false));

  if (isVSMode) {
    // Convert stampedSquares array to grid
    cardOrStamps.forEach(({ row, col }) => {
      stampedGrid[row][col] = true;
    });
  } else {
    // Regular mode - convert card to stamped grid
    const card = cardOrStamps;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        stampedGrid[row][col] = card[row][col].stamped;
      }
    }
  }

  // Row checks
  const stampedRows = stampedGrid.map(row => row.every(cell => cell));
  const rowCount = stampedRows.filter(Boolean).length;

  // Column checks
  const stampedColumns = Array(5).fill(true);
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 5; row++) {
      if (!stampedGrid[row][col]) {
        stampedColumns[col] = false;
        break;
      }
    }
  }
  const colCount = stampedColumns.filter(Boolean).length;

  // Diagonal checks
  const diagonals = {
    main: stampedGrid.every((row, i) => row[i]),
    anti: stampedGrid.every((row, i) => row[4 - i]),
  };

  // Full card check
  const full = stampedGrid.flat().every(cell => cell);

  // Note: most_squares is handled separately in stamp event, not here
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
  const { hostName, vsMode, flagsEnabled, rerollsEnabled, hostColor } = req.body;
  const code = generateCode();
  const mode = vsMode === 'true' ? 'VS' : 'REGULAR';
  const sharedCard = mode === 'VS' ? generateCard() : null;

  // Validate host color for VS mode
  if (mode === 'VS') {
    const validColors = ['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE', 'ORANGE', 'PINK', 'CYAN'];
    if (!hostColor || !validColors.includes(hostColor)) {
      return res.status(400).send('Please select a color for VS mode');
    }
  }

  const game = await prisma.game.create({
    data: {
      code,
      rules: { winConditions },
      mode,
      sharedCard,
      flagsEnabled: flagsEnabled === 'true',
      rerollsEnabled: rerollsEnabled === 'true'
    },
  });

  // In VS mode, host doesn't get individual card, in regular mode they do
  const card = mode === 'VS' ? sharedCard : generateCard();
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
      card = generateCard();
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
      if (checkWin(stampedSquares, game.rules.winConditions)) {
        updatedGame = await prisma.game.update({
          where: { id: gameId },
          data: { status: 'ended', winner: player.name }
        });
        io.to(gameId).emit('win', { playerName: player.name });
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
            io.to(gameId).emit('win', { playerName: winner });
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

      if (!wasStamped && checkWin(card, game.rules.winConditions)) {
        updatedGame = await prisma.game.update({
          where: { id: gameId },
          data: { status: 'ended', winner: player.name }
        });
        io.to(gameId).emit('win', { playerName: player.name });
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
      const newCard = rerollCard(game.sharedCard, type, arg);

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
      const newCard = rerollCard(target.card, type, arg);
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

    if (game.mode === 'VS') {
      // VS Mode: Generate new shared card and reset all player stamps
      const newSharedCard = generateCard();

      const updatedGame = await prisma.game.update({
        where: { id: gameId },
        data: { status: 'active', winner: null, sharedCard: newSharedCard }
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
      const updatedGame = await prisma.game.update({
        where: { id: gameId },
        data: { status: 'active', winner: null }
      });

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