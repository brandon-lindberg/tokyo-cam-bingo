(() => {
  const HIDE_DELAY_MS = 2500; // fade-out starts at 2.5s mark
  const TRANSITION_BUFFER_MS = 600;
  let hideScheduled = false;

  const hideSplash = () => {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;

    splash.classList.remove('splash-screen--visible');
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

  const initSplash = () => {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;

    window.requestAnimationFrame(() => {
      splash.classList.add('splash-screen--visible');
    });

    scheduleHide();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSplash, { once: true });
  } else {
    initSplash();
  }
})();
