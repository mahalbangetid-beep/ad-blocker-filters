// Service worker entry point: core first, then every module's background.
import './core/background.js';
import './modules/lock/background.js';
import './modules/tabs/background.js';
import './modules/adblock/background.js';
import './modules/notes/background.js';
