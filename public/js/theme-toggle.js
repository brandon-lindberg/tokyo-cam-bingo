(function () {
  const body = document.body;
  if (!body) {
    return;
  }

  const Themes = {
    LIGHT: 'light',
    DARK: 'dark'
  };
  const themeMetaColors = {
    [Themes.LIGHT]: '#F0F8FF',
    [Themes.DARK]: '#27374D'
  };
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  const csrfTokenMeta = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrfTokenMeta ? csrfTokenMeta.getAttribute('content') : '';
  const switchers = Array.from(document.querySelectorAll('[data-theme-switcher]'));

  function normalizeTheme(value) {
    return value === Themes.DARK ? Themes.DARK : Themes.LIGHT;
  }

  function updateSwitcherState(theme) {
    switchers.forEach((switcher) => {
      switcher.setAttribute('data-current-theme', theme);
      const track = switcher.querySelector('.theme-toggle');
      if (track) {
        track.style.setProperty('--active-index', theme === Themes.DARK ? 1 : 0);
      }
      const options = switcher.querySelectorAll('[data-theme-value]');
      options.forEach((option) => {
        const isActive = option.getAttribute('data-theme-value') === theme;
        option.classList.toggle('is-active', isActive);
        option.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    });
  }

  function updateMetaThemeColor(theme) {
    if (!metaThemeColor) {
      return;
    }
    const nextColor = themeMetaColors[theme];
    if (nextColor) {
      metaThemeColor.setAttribute('content', nextColor);
    }
  }

  function applyTheme(theme) {
    const normalized = normalizeTheme(theme);
    body.dataset.theme = normalized;
    body.classList.remove('theme-dark', 'theme-light');
    body.classList.add(normalized === Themes.DARK ? 'theme-dark' : 'theme-light');
    updateSwitcherState(normalized);
    updateMetaThemeColor(normalized);
    return normalized;
  }

  let persistController = null;
  async function persistTheme(theme) {
    if (!csrfToken) {
      return;
    }
    if (persistController) {
      persistController.abort();
    }
    persistController = new AbortController();
    try {
      await fetch('/set-theme', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': csrfToken
        },
        credentials: 'same-origin',
        body: JSON.stringify({ theme }),
        signal: persistController.signal
      });
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Failed to persist theme preference', error);
      }
    }
  }

  function handleSwitcherClick(event) {
    const button = event.target.closest('[data-theme-value]');
    if (!button) {
      return;
    }
    const selectedTheme = button.getAttribute('data-theme-value');
    if (!selectedTheme || selectedTheme === body.dataset.theme) {
      return;
    }
    const normalized = applyTheme(selectedTheme);
    persistTheme(normalized);
  }

  switchers.forEach((switcher) => {
    switcher.addEventListener('click', handleSwitcherClick);
  });

  applyTheme(body.dataset.theme === Themes.DARK ? Themes.DARK : Themes.LIGHT);
})();
