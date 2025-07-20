function manualReroll(code, targetPlayerName, playerId) {
    const type = document.getElementById(`reroll-type-${playerId}`).value;
    const arg = document.getElementById(`reroll-arg-${playerId}`).value;
    socket.emit('reroll', { code, targetPlayerName, type, arg });
  }