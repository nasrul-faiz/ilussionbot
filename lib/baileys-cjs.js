/**
 * CommonJS bridge for the ESM-only @whiskeysockets/baileys v7
 * This module pre-loads baileys and exports everything synchronously.
 * 
 * Usage: require('./lib/baileys-cjs') instead of require('@whiskeysockets/baileys')
 * This module must be initialized before use via: await require('./lib/baileys-cjs').init()
 */
'use strict';

let _baileys = null;
let _initialized = false;
let _initPromise = null;

async function init() {
  if (_initialized) return _baileys;
  if (_initPromise) return _initPromise;
  
  _initPromise = (async () => {
    const mod = await import('@whiskeysockets/baileys');
    _baileys = mod;
    _initialized = true;
    // Expose all exports on this module
    Object.assign(module.exports, mod);
    module.exports.default = mod.default || mod.makeWASocket;
    return mod;
  })();
  
  return _initPromise;
}

module.exports = {
  init,
  get initialized() { return _initialized; }
};
