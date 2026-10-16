// Core service-worker wiring shared by all modules.
import { onModuleStatesChanged } from './modules.js';
import { rebuildMenus } from './menus.js';

// Context menus are rebuilt from the module providers whenever they may be stale.
chrome.runtime.onInstalled.addListener(() => { rebuildMenus().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { rebuildMenus().catch(() => {}); });
onModuleStatesChanged(() => { rebuildMenus().catch(() => {}); });
