// Classic script, loaded synchronously in <head>: sets theme/motion/accent before first paint.
(function () {
  try {
    var el = document.documentElement, a = {};
    try { a = JSON.parse(localStorage.getItem('mcu:appearance')) || {}; } catch (e) { a = {}; }
    var light = a.theme === 'light';
    if (a.theme === 'auto' || !a.theme) { try { light = matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { light = false; } }
    var m = a.motion;
    if (m !== 'full' && m !== 'balanced' && m !== 'minimal') {
      var rm = false; try { rm = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { rm = false; }
      m = rm ? 'minimal' : 'full';
    }
    el.dataset.ui = light ? 'light' : 'dark';
    el.dataset.motion = m;
    el.dataset.accent = a.accent === 'ion' || a.accent === 'nova' ? a.accent : 'solar';
  } catch (e) { /* never block page load */ }
})();
