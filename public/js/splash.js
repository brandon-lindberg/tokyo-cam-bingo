(() => {
  const SCREENS = [
    { id: 'splash-screen', duration: 2000 },
    { id: 'splash-screen-2', duration: 2000 }
  ];
  const TRANSITION_BUFFER_MS = 600;
  let currentScreenIndex = 0;
  let hideScheduled = false;

  const hideCurrentScreen = () => {
    const splash = document.getElementById(SCREENS[currentScreenIndex].id);
    if (!splash) return;

    splash.classList.remove('splash-screen--visible');
    splash.classList.add('splash-screen--hidden');

    window.setTimeout(() => {
      if (splash.parentElement) {
        splash.remove();
      }
      // Check if there's a next screen
      if (currentScreenIndex < SCREENS.length - 1) {
        currentScreenIndex++;
        showNextScreen();
      } else {
        // All screens done
        document.body.classList.remove('splash-active');
      }
    }, TRANSITION_BUFFER_MS);
  };

  const scheduleHide = () => {
    if (hideScheduled) return;
    hideScheduled = true;
    window.setTimeout(hideCurrentScreen, SCREENS[currentScreenIndex].duration);
  };

  const showNextScreen = () => {
    const splash = document.getElementById(SCREENS[currentScreenIndex].id);
    if (!splash) return;

    window.requestAnimationFrame(() => {
      splash.classList.add('splash-screen--visible');
    });

    hideScheduled = false; // Reset for next screen
    scheduleHide();
  };

  const initSplash = () => {
    showNextScreen();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSplash, { once: true });
  } else {
    initSplash();
  }
})();
