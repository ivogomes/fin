// Fin's appearance (Settings → Display): light, dark, or the system's, saved per browser. A plain
// script in the <head>, so the picked theme is on the page before anything is drawn and it never
// flashes the other one. app.js changes it with finTheme.set().
(() => {
  const BAR = { light: '#A4D5CF', dark: '#1B3836' }; // the header's colour, for the browser's bar
  const apply = (theme) => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    // The theme-color tags follow the system; a picked theme sets both to its own colour.
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.content = BAR[theme] ?? BAR[m.media.includes('dark') ? 'dark' : 'light'];
    });
  };
  let saved = 'system';
  try { saved = JSON.parse(localStorage.getItem('finance:theme')) ?? 'system'; } catch { /* private mode */ }
  apply(saved);
  window.finTheme = {
    get: () => document.documentElement.dataset.theme ?? 'system',
    set: (theme) => {
      apply(theme);
      try { localStorage.setItem('finance:theme', JSON.stringify(theme)); } catch { /* this visit only */ }
    },
  };
})();
