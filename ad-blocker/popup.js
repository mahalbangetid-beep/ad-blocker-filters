const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const number = new Intl.NumberFormat('id-ID');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

async function render() {
  const state = await send('ab:getPopupState', { tabId: tab.id });
  const supported = Boolean(state.host);

  $('site-box').hidden = !supported;
  $('unsupported').hidden = supported;
  $('pick').disabled = !supported || state.paused || state.allowlisted;
  $('host').textContent = state.site || '';
  $('site-toggle').checked = !state.allowlisted && !state.paused;
  $('site-toggle').disabled = state.paused;
  $('state').textContent = state.paused
    ? 'Pemblokiran dijeda di semua situs'
    : state.allowlisted ? 'Iklan diizinkan di situs ini' : 'Iklan diblokir di situs ini';

  $('page-count').textContent = number.format(state.pageBlocked);
  $('total-count').textContent = number.format(state.totalBlocked);
  $('pause').textContent = state.paused ? 'Lanjutkan pemblokiran' : 'Jeda di semua situs';
  $('pause').classList.toggle('primary', state.paused);
  return state;
}

let state = await render();

$('site-toggle').addEventListener('change', async (e) => {
  await send('ab:setAllowlisted', { domain: state.site, allowlisted: !e.target.checked, tabId: tab.id });
  state = await render();
});

$('pause').addEventListener('click', async () => {
  await send('ab:setPaused', { paused: !state.paused, tabId: tab.id });
  state = await render();
});

$('pick').addEventListener('click', async () => {
  await send('ab:startPicker', { tabId: tab.id });
  window.close();
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Keep the page counter live while the popup is open.
setInterval(async () => {
  state = await render();
}, 1000);
