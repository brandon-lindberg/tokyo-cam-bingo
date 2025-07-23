const rerollStates = {};

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
  if (type === 'card') {
    instruct.style.display = 'none';
    randomBtn.style.display = 'none';
    selectCard(playerId);
  } else if (type === 'random') {
    instruct.style.display = 'none';
    randomBtn.style.display = 'block';
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

  const row = parseInt(td.dataset.row);
  const col = parseInt(td.dataset.col);
  if (isNaN(row) || isNaN(col) || row < 0 || row > 4 || col < 0 || col > 4) return;

  clearSelection(playerId);

  let positions = [];
  let arg = '';

  switch (state.type) {
    case 'tile':
      positions = [[row, col]];
      arg = `${row + 1},${col + 1}`;
      break;
    case 'row':
      positions = Array.from({ length: 5 }, (_, c) => [row, c]);
      arg = `${row + 1}`;
      break;
    case 'column':
      positions = Array.from({ length: 5 }, (_, r) => [r, col]);
      arg = `${col + 1}`;
      break;
    case 'diagonal':
      const isMain = row === col;
      const isAnti = row + col === 4;
      if (!isMain && !isAnti) return;
      if (isMain && isAnti) { // Center
        arg = 'main';
        positions = Array.from({ length: 5 }, (_, i) => [i, i]);
      } else if (isMain) {
        arg = 'main';
        positions = Array.from({ length: 5 }, (_, i) => [i, i]);
      } else if (isAnti) {
        arg = 'anti';
        positions = Array.from({ length: 5 }, (_, i) => [i, 4 - i]);
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
  const positions = Array.from({ length: 25 }, (_, i) => [Math.floor(i / 5), i % 5]);
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
  if (!state || !state.type || (state.type !== 'card' && !state.arg)) {
    alert('Please select a type and an area to re-roll.');
    return;
  }
  const emitType = state.type === 'random' ? 'tile' : state.type;
  window.socket.emit('reroll', {
    gameId,
    targetPlayerId: playerId,
    type: emitType,
    arg: state.arg
  });
  exitRerollMode(playerId);
}

function exitRerollMode(playerId) {
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

function updateLeaderboard(players) {
  const leaderboardBody = document.querySelector('#leaderboard tbody');
  leaderboardBody.innerHTML = ''; // Clear existing

  // Compute scores
  const scoredPlayers = players.map(player => {
    const card = player.card;
    let score = 0;
    let stampedCount = 0;

    // Count stamped tiles
    card.flat().forEach(tile => {
      if (tile.stamped) stampedCount++;
    });

    // Completed rows
    score += card.filter(row => row.every(t => t.stamped)).length;

    // Completed columns
    for (let col = 0; col < 5; col++) {
      let complete = true;
      for (let row = 0; row < 5; row++) {
        if (!card[row][col].stamped) {
          complete = false;
          break;
        }
      }
      if (complete) score++;
    }

    // Diagonals
    let mainComplete = true;
    let antiComplete = true;
    for (let i = 0; i < 5; i++) {
      if (!card[i][i].stamped) mainComplete = false;
      if (!card[i][4 - i].stamped) antiComplete = false;
    }
    if (mainComplete) score++;
    if (antiComplete) score++;

    return { id: player.id, name: player.name, score, stampedCount };
  });

  // Sort: score desc, then stamped desc
  scoredPlayers.sort((a, b) => b.score - a.score || b.stampedCount - a.stampedCount);

  // Render with clickable names (except own)
  scoredPlayers.forEach((p, index) => {
    const tr = document.createElement('tr');
    const nameTd = `<td>${p.id === playerId ? p.name : `<span style="cursor: pointer; text-decoration: underline;" onclick="showPlayerCard('${p.id}')">${p.name}</span>`}</td>`;
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
  const r = Math.floor(Math.random() * 5);
  const c = Math.floor(Math.random() * 5);
  state.arg = `${r+1},${c+1}`;
  state.selectedCells = [[r, c]];
  highlightSelection(playerId, state.selectedCells);
}

// Modify confirmReroll to treat random as tile
function confirmReroll(playerId) {
  const state = rerollStates[playerId];
  if (!state || !state.type || (state.type !== 'card' && !state.arg)) {
    alert('Please select a type and an area to re-roll.');
    return;
  }
  const emitType = state.type === 'random' ? 'tile' : state.type;
  window.socket.emit('reroll', {
    gameId,
    targetPlayerId: playerId,
    type: emitType,
    arg: state.arg
  });
  exitRerollMode(playerId);
}