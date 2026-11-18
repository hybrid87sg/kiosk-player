// The dashboard's theme (0.11.3): "light", "dark", or automatic (the computer's own
// setting). Chosen in the side menu and remembered in this browser. Loaded before the
// page draws, so it never flashes the wrong colours.
(function () {
  var KEY = 'kiosk-theme';
  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }
  apply(saved());
  window.kioskTheme = {
    get: function () { var t = saved(); return t === 'light' || t === 'dark' ? t : 'auto'; },
    set: function (theme) {
      try {
        if (theme === 'light' || theme === 'dark') localStorage.setItem(KEY, theme);
        else localStorage.removeItem(KEY);
      } catch (e) { /* private window: this visit only */ }
      apply(theme);
    },
  };
})();
