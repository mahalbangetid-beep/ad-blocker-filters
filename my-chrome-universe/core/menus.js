// Shared context menu: each module registers a provider; one serialized rebuild owns the menu.
import { MODULES, isModuleEnabled } from './modules.js';

const providers = new Map();
let queue = Promise.resolve();

export function registerMenuProvider(moduleId, provider) {
  providers.set(moduleId, provider);
}

function removeAll() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const ret = chrome.contextMenus.removeAll(finish);
    if (ret && typeof ret.then === 'function') ret.then(finish, finish);
  });
}

async function build() {
  await removeAll();
  for (const { id } of MODULES) {
    const provider = providers.get(id);
    if (!provider || !(await isModuleEnabled(id))) continue;
    // One broken provider must not take the other modules' items with it.
    try {
      for (const props of await provider()) {
        chrome.contextMenus.create(props, () => { void chrome.runtime.lastError; });
      }
    } catch (err) {
      console.warn(`Context menu provider "${id}" failed:`, err);
    }
  }
}

export function rebuildMenus() {
  const run = queue.then(build);
  queue = run.catch(() => {});
  return run;
}
