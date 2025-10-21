/**
 * Game Timer Client-Side Logic
 * Handles countdown display, visual urgency states, and server synchronization
 */

class GameTimer {
  constructor(socket) {
    this.socket = socket;
    this.gameId = document.body.dataset.gameId;
    this.timerEnabled = document.body.dataset.timerEnabled === 'true';
    this.timerDuration = parseInt(document.body.dataset.timerDuration) || 0;
    this.timerStatus = document.body.dataset.timerStatus || 'not_started';
    this.timerStartedAt = document.body.dataset.timerStartedAt;
    this.pauseOnReroll = document.body.dataset.pauseOnReroll === 'true';

    this.remainingSeconds = this.timerDuration;
    this.isPaused = false;
    this.interval = null;

    this.timerElements = {
      desktop: document.getElementById('timer-value'),
      mobile: document.getElementById('timer-value-mobile'),
      containerDesktop: document.getElementById('game-timer'),
      containerMobile: document.getElementById('game-timer-mobile')
    };

    if (this.timerEnabled) {
      this.init();
      this.updateButtonVisibility(this.timerStatus);
      this.updateStatusText();
    }
  }

  syncWithGame(game) {
    const enabled = !!game.timerEnabled;
    this.timerEnabled = enabled;
    this.timerDuration = enabled ? (game.timerDuration || 0) : 0;
    this.pauseOnReroll = !!game.pauseTimerOnReroll;
    this.timerStatus = game.timerStatus || 'not_started';
    this.timerStartedAt = game.timerStartedAt ? new Date(game.timerStartedAt).toISOString() : null;
    if (!enabled) {
      this.stop();
      this.remainingSeconds = 0;
      this.isPaused = false;
      this.updateDisplay();
      this.updateVisualState();
      this.updateButtonVisibility('not_started');
      return;
    }

    if (this.timerStatus === 'running') {
      if (this.timerStartedAt) {
        this.calculateRemainingTime();
      } else {
        this.remainingSeconds = this.timerDuration;
      }
      this.isPaused = false;
      this.startCountdown();
      this.updateButtonVisibility('running');
    } else if (this.timerStatus === 'paused') {
      this.isPaused = true;
      this.stop();
      if (typeof game.remainingSeconds === 'number') {
        this.remainingSeconds = game.remainingSeconds;
      }
      this.updateDisplay();
      this.updateVisualState();
      this.updateButtonVisibility('paused');
    } else {
      this.resetToInitial();
    }
  }

  resetToInitial() {
    this.stop();
    this.timerStatus = 'not_started';
    this.isPaused = false;
    this.remainingSeconds = this.timerDuration;
    this.updateDisplay();
    this.updateVisualState();
    this.updateButtonVisibility('not_started');
  }

  init() {
    // Calculate initial remaining time if timer has started
    if (this.timerStatus === 'running' && this.timerStartedAt) {
      this.calculateRemainingTime();
      this.startCountdown();
    } else {
      // Show initial duration
      this.remainingSeconds = this.timerDuration;
      this.updateDisplay();
    }

    // Listen for timer events from server
    this.socket.on('timer_started', (data) => {
      this.handleTimerStarted(data);
    });

    this.socket.on('timer_update', (data) => {
      this.handleTimerUpdate(data);
    });

    this.socket.on('timer_paused', () => {
      this.handlePaused();
    });

    this.socket.on('timer_resumed', (data) => {
      this.handleResumed(data);
    });

    this.socket.on('timer_reset', (data) => {
      this.handleReset(data);
    });

    this.socket.on('timer_expired', (data) => {
      this.handleExpiry(data);
    });
  }

  updateButtonVisibility(status) {
    const buttons = {
      start: [...document.querySelectorAll('#start-timer-btn, #start-timer-btn-mobile')],
      pause: [...document.querySelectorAll('#pause-timer-btn, #pause-timer-btn-mobile')],
      resume: [...document.querySelectorAll('#resume-timer-btn, #resume-timer-btn-mobile')],
      reset: [...document.querySelectorAll('#reset-timer-btn, #reset-timer-btn-mobile')]
    };

    // Hide all buttons first
    Object.values(buttons).flat().forEach(btn => {
      if (btn) btn.style.display = 'none';
    });

    // Show appropriate buttons based on status
    switch(status) {
      case 'not_started':
        buttons.start.forEach(btn => { if (btn) btn.style.display = 'block'; });
        break;
      case 'running':
        buttons.pause.forEach(btn => { if (btn) btn.style.display = 'block'; });
        buttons.reset.forEach(btn => { if (btn) btn.style.display = 'block'; });
        break;
      case 'paused':
        buttons.resume.forEach(btn => { if (btn) btn.style.display = 'block'; });
        buttons.reset.forEach(btn => { if (btn) btn.style.display = 'block'; });
        break;
      case 'expired':
        // No buttons shown when expired
        break;
    }
  }

  updateStatusText() {}

  handleTimerStarted(data) {
    this.timerStatus = 'running';
    this.timerStartedAt = data.startedAt;
    this.remainingSeconds = data.remainingSeconds || this.timerDuration;
    this.updateButtonVisibility('running');
    this.updateStatusText();
    this.startCountdown();
  }

  handlePaused() {
    this.timerStatus = 'paused';
    this.isPaused = true;
    this.updateButtonVisibility('paused');
    this.updateStatusText();
  }

  handleResumed(data) {
    this.timerStatus = 'running';
    this.isPaused = false;
    if (data && data.remainingSeconds !== undefined) {
      this.remainingSeconds = data.remainingSeconds;
    }
    this.updateButtonVisibility('running');
    this.updateStatusText();
    this.updateDisplay();
  }

  handleReset(data) {
    this.timerStatus = 'not_started';
    this.timerStartedAt = null;
    this.remainingSeconds = this.timerDuration;
    this.isPaused = false;
    this.stop();
    this.updateDisplay();
    this.updateButtonVisibility('not_started');
    this.updateStatusText();
  }

  calculateRemainingTime() {
    const startedAt = new Date(this.timerStartedAt);
    const now = new Date();
    const elapsedSeconds = Math.floor((now - startedAt) / 1000);
    this.remainingSeconds = Math.max(0, this.timerDuration - elapsedSeconds);
  }

  startCountdown() {
    if (this.interval) {
      clearInterval(this.interval);
    }

    // Update display immediately
    this.updateDisplay();

    // Update every second
    this.interval = setInterval(() => {
      if (!this.isPaused && this.remainingSeconds > 0) {
        this.remainingSeconds--;
        this.updateDisplay();
        this.updateVisualState();

        // Sync with server every 30 seconds
        if (this.remainingSeconds % 30 === 0) {
          this.socket.emit('timer_sync_request', { gameId: this.gameId });
        }

        // Timer expired on client side
        if (this.remainingSeconds === 0) {
          this.stop();
          // Server will handle expiry logic and emit timer_expired
        }
      }
    }, 1000);
  }

  updateDisplay() {
    const hours = Math.floor(this.remainingSeconds / 3600);
    const minutes = Math.floor((this.remainingSeconds % 3600) / 60);
    const seconds = this.remainingSeconds % 60;

    let display;
    if (hours > 0) {
      display = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      display = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    if (this.timerElements.desktop) {
      this.timerElements.desktop.textContent = display;
    }
    if (this.timerElements.mobile) {
      this.timerElements.mobile.textContent = display;
    }
  }

  updateVisualState() {
    const containers = [this.timerElements.containerDesktop, this.timerElements.containerMobile];

    containers.forEach(container => {
      if (!container) return;

      // Remove existing state classes
      container.classList.remove('timer-warning', 'timer-danger');

      // Add appropriate class based on remaining time
      if (this.remainingSeconds <= 60) {
        // Last minute - danger state (red/yellow pulsing)
        container.classList.add('timer-danger');
      } else if (this.remainingSeconds <= 300) {
        // Last 5 minutes - warning state (pink pulsing)
        container.classList.add('timer-warning');
      }
      // Otherwise, default state (purple gradient)
    });
  }


  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  handleTimerUpdate(data) {
    // Sync with server time
    if (data.remainingSeconds !== undefined) {
      this.remainingSeconds = data.remainingSeconds;
      this.updateDisplay();
      this.updateVisualState();
    }
  }

  handleExpiry(data) {
    this.stop();
    this.remainingSeconds = 0;
    this.updateDisplay();

    // Show expiry modal
    showTimerExpiredModal(data);
  }
}

// Show timer expired modal
function showTimerExpiredModal(data) {
  const modal = document.getElementById('timer-expired-modal');
  if (!modal) return;

  const titleElement = document.getElementById('timer-expired-title');
  const messageElement = document.getElementById('timer-expired-message');
  const winnerElement = document.getElementById('timer-expired-winner');

  if (data.winner) {
    titleElement.textContent = 'Time\'s Up!';
    messageElement.textContent = 'The timer has expired.';
    winnerElement.textContent = `Winner: ${data.winner}`;
    winnerElement.style.display = 'block';
  } else if (data.tie) {
    titleElement.textContent = 'Time\'s Up!';
    messageElement.textContent = 'The game has ended in a tie.';
    winnerElement.style.display = 'none';
  } else {
    titleElement.textContent = 'Time\'s Up!';
    messageElement.textContent = 'The game has ended. No winner was determined.';
    winnerElement.style.display = 'none';
  }

  modal.style.display = 'flex';
}

// Close timer expired modal
function closeTimerExpiredModal() {
  const modal = document.getElementById('timer-expired-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// Global control functions for button onclick handlers
function startTimer() {
  if (window.socket && window.gameTimer) {
    const gameId = document.body.dataset.gameId;
    window.socket.emit('start_timer', { gameId });
  }
}

function pauseTimer() {
  if (window.socket && window.gameTimer) {
    const gameId = document.body.dataset.gameId;
    window.socket.emit('pause_timer', { gameId });
  }
}

function resumeTimer() {
  if (window.socket && window.gameTimer) {
    const gameId = document.body.dataset.gameId;
    window.socket.emit('resume_timer', { gameId });
  }
}

function resetTimer() {
  if (window.socket && window.gameTimer) {
    const gameId = document.body.dataset.gameId;
    if (confirm('Are you sure you want to reset the timer? This will reset it to the original duration.')) {
      window.socket.emit('reset_timer', { gameId });
    }
  }
}

// Export for use in game.js
window.GameTimer = GameTimer;
window.closeTimerExpiredModal = closeTimerExpiredModal;
window.startTimer = startTimer;
window.pauseTimer = pauseTimer;
window.resumeTimer = resumeTimer;
window.resetTimer = resetTimer;
