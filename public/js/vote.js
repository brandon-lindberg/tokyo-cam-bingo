(function(){
  let currentVote = null;

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

  socket.on('start_vote', ({ flaggerId, flaggerName, targetPlayerId, targetPlayerName, row, col }) => {
    currentVote = { flaggerId, targetPlayerId, row, col };
    voteMessage.textContent = `Flag thrown by ${flaggerName} on ${targetPlayerName}`;
    voteCountEl.textContent = 'Votes: 0 yes, 0 no';
    voteResultEl.style.display = 'none';
    voteButtons.style.display = 'block';
    voteModal.style.display = 'flex';
  });

  socket.on('vote_update', ({ votesFor, votesAgainst, votesCast, totalPlayers }) => {
    voteCountEl.textContent = `Votes: ${votesFor} yes, ${votesAgainst} no`;
  });

  socket.on('vote_result', ({ success, votes }) => {
    voteButtons.style.display = 'none';
    voteOutcomeEl.textContent = success ? 'Vote passed!' : 'Vote failed!';
    voteDetailsUl.innerHTML = '';
    Object.entries(votes).forEach(([pid, v]) => {
      const li = document.createElement('li');
      const player = allPlayers.find(p => p.id === pid);
      const name = player ? player.name : pid;
      li.textContent = `${name}: ${v}`;
      voteDetailsUl.appendChild(li);
    });
    voteResultEl.style.display = 'block';
  });

  voteYesBtn.addEventListener('click', () => {
    if (!currentVote) return;
    socket.emit('cast_vote', { gameId, playerId, vote: 'yes' });
  });

  voteNoBtn.addEventListener('click', () => {
    if (!currentVote) return;
    socket.emit('cast_vote', { gameId, playerId, vote: 'no' });
  });

  voteCloseBtn.addEventListener('click', () => {
    voteModal.style.display = 'none';
    currentVote = null;
  });
})(); 