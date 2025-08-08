(function(){
  let currentVote = null;
  let autoCloseTimer = null;

  const voteModal = document.getElementById('vote-modal');
  const voteMessage = document.getElementById('vote-modal-message');
  const voteCountEl = document.getElementById('vote-count');
  const voteButtons = document.getElementById('vote-buttons');
  const voteResultEl = document.getElementById('vote-result');
  const voteOutcomeEl = document.getElementById('vote-outcome');
  const voteDetailsUl = document.getElementById('vote-details');
  const voteYesBtn = document.getElementById('vote-yes');
  const voteNoBtn = document.getElementById('vote-no');
  const voteCloseBtn = document.getElementById('vote-close');

  function showModal() {
    voteModal.style.display = 'flex';
  }
  function hideModal() {
    voteModal.style.display = 'none';
    currentVote = null;
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }

  socket.on('start_vote', ({ flaggerId, flaggerName, targetPlayerId, targetPlayerName, row, col }) => {
    currentVote = { flaggerId, targetPlayerId, row, col };
    voteMessage.textContent = `Flag thrown by ${flaggerName} on ${targetPlayerName}`;
    voteCountEl.textContent = 'Votes: 0 yes, 0 no';
    voteResultEl.style.display = 'none';
    voteButtons.style.display = 'flex';
    voteYesBtn.disabled = false;
    voteNoBtn.disabled = false;
    showModal();
  });

  socket.on('vote_update', ({ votesFor, votesAgainst, votesCast, totalPlayers }) => {
    voteCountEl.textContent = `Votes: ${votesFor} yes, ${votesAgainst} no`;
  });

  socket.on('vote_result', ({ success, votes }) => {
    voteButtons.style.display = 'none';
    voteOutcomeEl.textContent = success ? 'Vote passed!' : 'Vote failed!';
    voteOutcomeEl.className = 'modal-subtitle';
    voteOutcomeEl.classList.add('badge', success ? 'success' : 'error');
    voteDetailsUl.innerHTML = '';
    Object.entries(votes).forEach(([pid, v]) => {
      const li = document.createElement('li');
      li.className = 'vote-item';
      const player = allPlayers.find(p => p.id === pid);
      const name = player ? player.name : pid;
      const label = document.createElement('span');
      label.textContent = name;
      const pill = document.createElement('span');
      pill.className = `vote-pill ${v === 'yes' ? 'vote-yes' : 'vote-no'}`;
      pill.textContent = v ? v.toUpperCase() : '—';
      li.appendChild(label);
      li.appendChild(pill);
      voteDetailsUl.appendChild(li);
    });
    voteResultEl.style.display = 'block';
    // Auto-close after 10s
    autoCloseTimer = setTimeout(hideModal, 10000);
  });

  voteYesBtn.addEventListener('click', () => {
    if (!currentVote) return;
    voteYesBtn.disabled = true;
    voteNoBtn.disabled = true;
    socket.emit('cast_vote', { gameId, playerId, vote: 'yes' });
  });

  voteNoBtn.addEventListener('click', () => {
    if (!currentVote) return;
    voteYesBtn.disabled = true;
    voteNoBtn.disabled = true;
    socket.emit('cast_vote', { gameId, playerId, vote: 'no' });
  });

  voteCloseBtn.addEventListener('click', hideModal);

  // Close if clicking on backdrop after results are shown
  voteModal.addEventListener('click', (e) => {
    if (e.target === voteModal && voteResultEl.style.display === 'block') {
      hideModal();
    }
  });
  // Close on Esc after results are shown
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && voteModal.style.display === 'flex' && voteResultEl.style.display === 'block') {
      hideModal();
    }
  });
})(); 