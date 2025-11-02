(() => {
  const HIDE_DELAY_MS = 1000;
  const TRANSITION_BUFFER_MS = 700;
  let hideScheduled = false;

  const hideSplash = () => {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;

    splash.classList.add('splash-screen--hidden');
    document.body.classList.remove('splash-active');

    window.setTimeout(() => {
      if (splash.parentElement) {
        splash.remove();
      }
    }, TRANSITION_BUFFER_MS);
  };

  const scheduleHide = () => {
    if (hideScheduled) return;
    hideScheduled = true;
    window.setTimeout(hideSplash, HIDE_DELAY_MS);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleHide, { once: true });
  } else {
    scheduleHide();
  }
})();
