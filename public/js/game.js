const rerollStates = {};
const translate = (key, vars) => (typeof window.t === 'function' ? window.t(key, vars) : key);

function getBoardSize() {
  const body = document.body;
  if (!body) return 5;
  const parsed = Number(body.dataset.boardSize);
  if (Number.isInteger(parsed) && parsed >= 3 && parsed <= 10) {
    return parsed;
  }
  return 5;
}

function enterRerollMode(playerId) {
  if (rerollStates[playerId]) return; // Already in mode

  rerollStates[playerId] = {
    type: '',
    arg: '',
    selectedCells: [],
    clickListener: null
  };

  const modeDiv = document.getElementById(`reroll-mode-${playerId}`);
  modeDiv.style.display = 'block';

  // Reset reroll controls for a fresh start
  const typeSelect = document.getElementById(`reroll-type-${playerId}`);
  typeSelect.value = '';
  const randomBtn = document.getElementById(`select-random-button-${playerId}`);
  randomBtn.style.display = 'none';

  const instruct = document.getElementById(`selection-instruct-${playerId}`);
  instruct.style.display = 'none'; // Initially hidden until type selected

  const table = document.getElementById(`card-${playerId}`);
  table.classList.add('reroll-mode');

  // Add click listener for selection
  const handleClick = (e) => handleCardClick(playerId, e);
  rerollStates[playerId].clickListener = handleClick;
  table.addEventListener('click', handleClick);
  // Hide streamer toggle button when entering reroll mode
  const rerollSection = document.querySelector('.reroll-section');
  if (rerollSection) rerollSection.classList.add('reroll-active');
}

function handleTypeChange(playerId) {
  const select = document.getElementById(`reroll-type-${playerId}`);
  const type = select.value;
  const state = rerollStates[playerId];
  if (!state) return;

  state.type = type;
  clearSelection(playerId);

  const instruct = document.getElementById(`selection-instruct-${playerId}`);
  const randomBtn = document.getElementById(`select-random-button-${playerId}`);
  // reset button
  randomBtn.onclick = null;
  randomBtn.textContent = translate('game.reroll.randomButtonDefault');

  if (type === 'card') {
    instruct.style.display = 'none';
    randomBtn.style.display = 'none';
    selectCard(playerId);
  } else if (type === 'random') {
    instruct.style.display = 'none';
    randomBtn.style.display = 'block';
    randomBtn.textContent = translate('game.reroll.randomButton');
    randomBtn.onclick = () => selectRandomTile(playerId);
  } else if (type === 'random_row') {
    instruct.style.display = 'none';
    randomBtn.style.display = 'block';
    randomBtn.textContent = translate('game.reroll.randomRowButton');
    randomBtn.onclick = () => selectRandomRow(playerId);
  } else if (type === 'random_column') {
    instruct.style.display = 'none';
    randomBtn.style.display = 'block';
    randomBtn.textContent = translate('game.reroll.randomColumnButton');
    randomBtn.onclick = () => selectRandomColumn(playerId);
  } else if (type === 'random_diagonal') {
    instruct.style.display = 'none';
    randomBtn.style.display = 'block';
    randomBtn.textContent = translate('game.reroll.randomDiagonalButton');
    randomBtn.onclick = () => selectRandomDiagonal(playerId);
  } else if (type) {
    instruct.style.display = 'block';
    randomBtn.style.display = 'none';
  } else {
    instruct.style.display = 'none';
    randomBtn.style.display = 'none';
  }
}

function handleCardClick(playerId, e) {
  let td = e.target.closest('td');
  if (!td) return;

  const state = rerollStates[playerId];
  if (!state || !state.type || state.type === 'card') return;

  const row = parseInt(td.dataset.row, 10);
  const col = parseInt(td.dataset.col, 10);
  const boardSize = getBoardSize();
  if (
    Number.isNaN(row) ||
    Number.isNaN(col) ||
    row < 0 || row >= boardSize ||
    col < 0 || col >= boardSize
  ) {
    return;
  }
  const lastIndex = boardSize - 1;

  clearSelection(playerId);

  let positions = [];
  let arg = '';

  switch (state.type) {
    case 'tile':
      positions = [[row, col]];
      arg = `${row + 1},${col + 1}`;
      break;
    case 'row':
      positions = Array.from({ length: boardSize }, (_, c) => [row, c]);
      arg = `${row + 1}`;
      break;
    case 'column':
      positions = Array.from({ length: boardSize }, (_, r) => [r, col]);
      arg = `${col + 1}`;
      break;
    case 'diagonal':
      const isMain = row === col;
      const isAnti = row + col === lastIndex;
      if (!isMain && !isAnti) return;
      if (isMain && isAnti) { // Center
        arg = 'main';
        positions = Array.from({ length: boardSize }, (_, i) => [i, i]);
      } else if (isMain) {
        arg = 'main';
        positions = Array.from({ length: boardSize }, (_, i) => [i, i]);
      } else if (isAnti) {
        arg = 'anti';
        positions = Array.from({ length: boardSize }, (_, i) => [i, lastIndex - i]);
      }
      break;
  }

  if (positions.length > 0) {
    state.arg = arg;
    state.selectedCells = positions;
    highlightSelection(playerId, positions);
  }
}

function selectCard(playerId) {
  const boardSize = getBoardSize();
  const positions = Array.from({ length: boardSize * boardSize }, (_, i) => [Math.floor(i / boardSize), i % boardSize]);
  const state = rerollStates[playerId];
  state.arg = '';
  state.selectedCells = positions;
  highlightSelection(playerId, positions);
}

function highlightSelection(playerId, positions) {
  const table = document.getElementById(`card-${playerId}`);
  positions.forEach(([r, c]) => {
    table.rows[r].cells[c].classList.add('selected');
  });
}

function clearSelection(playerId) {
  const state = rerollStates[playerId];
  if (!state) return;
  const table = document.getElementById(`card-${playerId}`);
  state.selectedCells.forEach(([r, c]) => {
    if (table.rows[r] && table.rows[r].cells[c]) {
      table.rows[r].cells[c].classList.remove('selected');
    }
  });
  state.selectedCells = [];
  state.arg = '';
}

function confirmReroll(playerId) {
  const state = rerollStates[playerId];
  if (!state || !state.type) {
    alert(translate('alerts.rerollMissingSelection'));
    return;
  }
  // Types that require argument selection prior to confirm
  const requiresArg = ['tile', 'row', 'column', 'diagonal', 'random', 'random_row', 'random_column', 'random_diagonal'];
  if (requiresArg.includes(state.type) && !state.arg && state.type !== 'card') {
    alert(translate('alerts.rerollMissingSelection'));
    return;
  }
  // Map random_* types to base types for the server
  let emitType = state.type;
  if (state.type === 'random') emitType = 'tile';
  else if (state.type === 'random_row') emitType = 'row';
  else if (state.type === 'random_column') emitType = 'column';
  else if (state.type === 'random_diagonal') emitType = 'diagonal';

  window.socket.emit('reroll', {
    gameId,
    targetPlayerId: playerId,
    type: emitType,
    arg: state.arg
  });
  exitRerollMode(playerId);
}

function exitRerollMode(playerId) {
  // Show streamer toggle button again after exiting reroll mode
  const rerollSection = document.querySelector('.reroll-section');
  if (rerollSection) rerollSection.classList.remove('reroll-active');
  const modeDiv = document.getElementById(`reroll-mode-${playerId}`);
  modeDiv.style.display = 'none';

  const table = document.getElementById(`card-${playerId}`);
  table.classList.remove('reroll-mode');
  if (rerollStates[playerId].clickListener) {
    table.removeEventListener('click', rerollStates[playerId].clickListener);
  }

  clearSelection(playerId);
  delete rerollStates[playerId];
}

function updateLeaderboard(players, gameMode) {
  const leaderboardBody = document.querySelector('#leaderboard tbody');
  if (!leaderboardBody) return;
  leaderboardBody.innerHTML = ''; // Clear existing
  const boardSize = getBoardSize();
  const lastIndex = boardSize - 1;

  const getTile = (cardData, row, col) => {
    if (!Array.isArray(cardData)) return undefined;
    const rowData = Array.isArray(cardData[row]) ? cardData[row] : [];
    return rowData[col];
  };

  // Compute scores
  const scoredPlayers = players.map(player => {
    let score = 0;
    let stampedCount = 0;

    if (gameMode === 'VS') {
      // VS mode: Use stampedSquares
      const squares = player.stampedSquares || [];
      stampedCount = squares.length;

      // Create grid to check win conditions
      let stampedGrid = Array.from({ length: boardSize }, () => Array(boardSize).fill(false));
      squares.forEach(({ row, col }) => {
        const rIndex = Number(row);
        const cIndex = Number(col);
        if (
          !Number.isNaN(rIndex) &&
          !Number.isNaN(cIndex) &&
          rIndex >= 0 && rIndex < boardSize &&
          cIndex >= 0 && cIndex < boardSize
        ) {
          stampedGrid[rIndex][cIndex] = true;
        }
      });

      // Completed rows
      score += stampedGrid.filter(row => row.every(cell => cell)).length;

      // Completed columns
      for (let col = 0; col < boardSize; col++) {
        let complete = true;
        for (let row = 0; row < boardSize; row++) {
          if (!stampedGrid[row][col]) {
            complete = false;
            break;
          }
        }
        if (complete) score++;
      }

      // Diagonals
      let mainComplete = true;
      let antiComplete = true;
      for (let i = 0; i < boardSize; i++) {
        if (!stampedGrid[i][i]) mainComplete = false;
        if (!stampedGrid[i][lastIndex - i]) antiComplete = false;
      }
      if (mainComplete) score++;
      if (antiComplete) score++;
    } else {
      // Regular mode: Use card
      const card = Array.isArray(player.card) ? player.card : [];
      card.forEach(row => {
        if (!Array.isArray(row)) return;
        row.forEach(tile => {
          if (tile && tile.stamped) stampedCount++;
        });
      });

      score += card.filter(row => Array.isArray(row) && row.length && row.every(t => t && t.stamped)).length;

      for (let col = 0; col < boardSize; col++) {
        let complete = true;
        for (let row = 0; row < boardSize; row++) {
          const tile = getTile(card, row, col);
          if (!tile || !tile.stamped) {
            complete = false;
            break;
          }
        }
        if (complete) score++;
      }

      let mainComplete = true;
      let antiComplete = true;
      for (let i = 0; i < boardSize; i++) {
        const mainTile = getTile(card, i, i);
        const antiTile = getTile(card, i, lastIndex - i);
        if (!mainTile || !mainTile.stamped) mainComplete = false;
        if (!antiTile || !antiTile.stamped) antiComplete = false;
      }
      if (mainComplete) score++;
      if (antiComplete) score++;
    }

    return { id: player.id, name: player.name, score, stampedCount, color: player.color, cardRevealed: player.cardRevealed };
  });

  // Sort: score desc, then stamped desc
  scoredPlayers.sort((a, b) => b.score - a.score || b.stampedCount - a.stampedCount);

  // Render with clickable names (except own) and color badges for VS mode
  scoredPlayers.forEach((p, index) => {
    const tr = document.createElement('tr');
    const colorBadge = gameMode === 'VS' && p.color ? `<span class="color-badge ${p.color}"></span>` : '';
    const isCurrentPlayer = typeof playerId !== 'undefined' && String(p.id) === String(playerId);
    const canViewCard = !isCurrentPlayer && Boolean(p.cardRevealed);
    const nameContent = isCurrentPlayer
      ? p.name
      : (canViewCard ? `<span style="cursor: pointer; text-decoration: underline;" onclick="showPlayerCard('${p.id}')">${p.name}</span>` : p.name);
    const nameTd = `<td>${colorBadge}${nameContent}</td>`;
    tr.innerHTML = `
      <td>${index + 1}</td>
      ${nameTd}
      <td>${p.score}</td>
      <td>${p.stampedCount}</td>
    `;
    leaderboardBody.appendChild(tr);
  });
}

// Add helper to pick a random tile
function selectRandomTile(playerId) {
  const state = rerollStates[playerId];
  if (!state) return;
  clearSelection(playerId);
  const boardSize = getBoardSize();
  const r = Math.floor(Math.random() * boardSize);
  const c = Math.floor(Math.random() * boardSize);
  state.arg = `${r+1},${c+1}`;
  state.selectedCells = [[r, c]];
  highlightSelection(playerId, state.selectedCells);
}

function selectRandomRow(playerId) {
  const state = rerollStates[playerId];
  if (!state) return;
  clearSelection(playerId);
  const boardSize = getBoardSize();
  const r = Math.floor(Math.random() * boardSize);
  state.arg = `${r + 1}`;
  state.selectedCells = Array.from({ length: boardSize }, (_, c) => [r, c]);
  highlightSelection(playerId, state.selectedCells);
}

function selectRandomColumn(playerId) {
  const state = rerollStates[playerId];
  if (!state) return;
  clearSelection(playerId);
  const boardSize = getBoardSize();
  const c = Math.floor(Math.random() * boardSize);
  state.arg = `${c + 1}`;
  state.selectedCells = Array.from({ length: boardSize }, (_, r) => [r, c]);
  highlightSelection(playerId, state.selectedCells);
}

function selectRandomDiagonal(playerId) {
  const state = rerollStates[playerId];
  if (!state) return;
  clearSelection(playerId);
  const boardSize = getBoardSize();
  const lastIndex = boardSize - 1;
  const isMain = Math.random() < 0.5;
  state.arg = isMain ? 'main' : 'anti';
  state.selectedCells = isMain
    ? Array.from({ length: boardSize }, (_, i) => [i, i])
    : Array.from({ length: boardSize }, (_, i) => [i, lastIndex - i]);
  highlightSelection(playerId, state.selectedCells);
}

// Modify confirmReroll to treat random as tile
function confirmReroll(playerId) {
  const state = rerollStates[playerId];
  if (!state || !state.type) {
    alert(translate('alerts.rerollMissingSelection'));
    return;
  }
  const requiresArg = ['tile', 'row', 'column', 'diagonal', 'random', 'random_row', 'random_column', 'random_diagonal'];
  if (requiresArg.includes(state.type) && !state.arg && state.type !== 'card') {
    alert(translate('alerts.rerollMissingSelection'));
    return;
  }
  let emitType = state.type === 'random' ? 'tile' : state.type;
  if (state.type === 'random_row') emitType = 'row';
  if (state.type === 'random_column') emitType = 'column';
  if (state.type === 'random_diagonal') emitType = 'diagonal';
  window.socket.emit('reroll', {
    gameId,
    targetPlayerId: playerId,
    type: emitType,
    arg: state.arg
  });
  exitRerollMode(playerId);
}
