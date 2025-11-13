(function () {
  const toggleAttribute = 'aria-expanded';

  function initMenu(button) {
    const menuId = button.getAttribute('aria-controls');
    if (!menuId) return;
    const menu = document.getElementById(menuId);
    if (!menu) return;

    let isOpen = false;

    function openMenu() {
      if (isOpen) return;
      isOpen = true;
      button.setAttribute(toggleAttribute, 'true');
      menu.hidden = false;
      menu.dataset.open = 'true';
    }

    function closeMenu() {
      if (!isOpen) return;
      isOpen = false;
      button.setAttribute(toggleAttribute, 'false');
      menu.hidden = true;
      delete menu.dataset.open;
    }

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const expanded = button.getAttribute(toggleAttribute) === 'true';
      if (expanded) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    menu.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    document.addEventListener('click', (event) => {
      if (!isOpen) return;
      if (menu.contains(event.target) || button.contains(event.target)) {
        return;
      }
      closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (!isOpen) return;
      if (event.key === 'Escape') {
        closeMenu();
        button.focus();
      }
    });
  }

  const buttons = document.querySelectorAll('[data-preferences-toggle]');
  buttons.forEach(initMenu);
})();
