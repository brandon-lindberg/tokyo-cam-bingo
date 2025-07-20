const rerollStates = {};

function enterRerollMode(playerId, code, playerName) {
  if (rerollStates[playerId]) return; // Already in mode

  rerollStates[playerId] = {
    code,
    playerName,
    type: '',
    arg: '',
    selectedCells: [],
    clickListener: null
  };

  const modeDiv = document.getElementById(`reroll-mode-${playerId}`);
  modeDiv.style.display = 'block';

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
  if (type === 'card') {
    instruct.style.display = 'none';
    selectCard(playerId);
  } else if (type) {
    instruct.style.display = 'block';
  } else {
    instruct.style.display = 'none';
  }
}

function handleCardClick(playerId, e) {
  const state = rerollStates[playerId];
  if (!state || !state.type || state.type === 'card') return;

  if (e.target.tagName !== 'TD') return;

  const td = e.target;
  const row = parseInt(td.dataset.row);
  const col = parseInt(td.dataset.col);

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
        // Default to main
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

  window.socket.emit('reroll', {
    code: state.code,
    targetPlayerName: state.playerName,
    type: state.type,
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