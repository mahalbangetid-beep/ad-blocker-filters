// Welcome scene from the prototype: flash and ring, "Welcome to" letter by letter, star particles
// that form the title, tagline, progress bar and "Lewati". Styles live in components.css (.welcome).
import { hydrateIcons } from './icons.js';
import { motionLevel, wait } from './motion.js';

const EYEBROW = 'Welcome to';
const TITLE = ['My', 'Chrome', 'Universe'];
const TAG = 'Ruang browsing pribadimu. Terkunci rapat, tab tertata, bebas iklan.';

function build(container) {
  container.replaceChildren();
  const flash = document.createElement('div');
  flash.className = 'w-flash';
  const ring = document.createElement('div');
  ring.className = 'w-ring';

  const center = document.createElement('div');
  center.className = 'w-center';
  const eyebrow = document.createElement('p');
  eyebrow.className = 'w-eyebrow';
  eyebrow.setAttribute('aria-label', EYEBROW);
  [...EYEBROW].forEach((c, i) => {
    const s = document.createElement('span');
    s.textContent = c;
    s.setAttribute('aria-hidden', 'true');
    s.style.setProperty('--i', i);
    eyebrow.append(s);
  });
  const title = document.createElement('h1');
  title.className = 'w-title';
  TITLE.forEach((word, i) => {
    if (i) title.append(' ');
    const s = document.createElement('span');
    s.textContent = word;
    title.append(s);
  });
  const tag = document.createElement('p');
  tag.className = 'w-tag';
  tag.textContent = TAG;
  center.append(eyebrow, title, tag);

  const foot = document.createElement('div');
  foot.className = 'w-foot';
  foot.innerHTML = '<div class="w-progress"><i></i></div><button class="w-skip" type="button">Lewati <i data-ic="arrowRight"></i></button>';
  hydrateIcons(foot);

  container.append(flash, ring, center, foot);
  return { title, skip: foot.querySelector('.w-skip') };
}

// Plays the welcome in `container` and resolves when it ends (about 4.8 s, 3.2 s in minimal motion)
// or is skipped (button, click anywhere, Enter, Esc). The scene then zooms away on its own.
export function playWelcome(container, sky) {
  const minimal = motionLevel() === 'minimal';
  const total = minimal ? 3200 : 4800;
  const { title, skip } = build(container);
  container.classList.add('welcome');
  container.classList.remove('leave-zoom', 'is-active');
  container.style.setProperty('--dur', `${total}ms`);
  container.hidden = false;
  void container.offsetWidth; // restart the CSS timeline
  container.classList.add('is-active');
  skip.focus({ preventScroll: true });

  let done = false;
  sky?.setMode('welcome');
  if (!minimal && sky) {
    // Particles need the final glyph positions, so wait for the display font.
    document.fonts.ready.then(() => requestAnimationFrame(() => { if (!done) sky.buildText(title); }));
  }

  return new Promise((resolve) => {
    let timer = 0;
    const onKey = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        finish();
      }
    };
    async function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      container.removeEventListener('click', finish);
      document.removeEventListener('keydown', onKey, true);
      sky?.scatter();
      sky?.setMode('orbit');
      container.classList.add('leave-zoom');
      await wait(480);
      resolve();
      await wait(320);
      container.hidden = true;
      container.classList.remove('is-active', 'leave-zoom');
      container.replaceChildren();
    }
    timer = setTimeout(finish, total);
    container.addEventListener('click', finish);
    document.addEventListener('keydown', onKey, true);
  });
}
