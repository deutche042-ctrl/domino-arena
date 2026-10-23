'use strict';
/*
 * Domino Arena — in-app server launcher (Android / @capawesome/capacitor-nodejs).
 *
 * Why CommonJS (`.cjs`): this file is the Node.js project entry resolved from
 * `main` in the sibling package.json. It must run through the plugin's bridge
 * module, and that module is CommonJS-only (`require('events')`,
 * `process._linkedBinding('capacitor_bridge')`). Requiring `bridge` is also what
 * flips the plugin to ready — bridge/index.js sends `ready-for-app-events` on
 * the system channel and Nodejs.java turns that into `ready = true`, without
 * which `Nodejs.send()` rejects with NODE_NOT_READY.
 *
 * On the device the plugin copies the whole project directory (this file,
 * server-bundle.cjs and public/) from the APK assets into
 * <filesDir>/capawesome_nodejs/nodejs-project and runs `node index.cjs` in it,
 * with NODE_PATH covering that directory plus the plugin's builtin_modules.
 *
 * Layout it expects next to itself:
 *   index.cjs            this launcher
 *   server-bundle.cjs    esbuild CJS bundle of server/server.js (+ engine/)
 *   public/              the game client, served by the bundle
 */

const path = require('node:path');
const http = require('node:http');

const PORT = String(process.env.DOMINO_PORT || process.env.PORT || 3000);
const RUNTIME_DIR = __dirname;
// The bundle serves the client from DOMINO_PUBLIC_DIR (server/server.js). On the
// device that is the `public/` copy sitting next to this file.
const PUBLIC_DIR = process.env.DOMINO_PUBLIC_DIR || path.join(RUNTIME_DIR, 'public');
// Two callers: the device (no env set → sibling bundle) and verify-launcher.mjs,
// which runs this very file from mobile/node/ and points at the assembled bundle.
const BUNDLE = process.env.DOMINO_SERVER_BUNDLE || path.join(RUNTIME_DIR, 'server-bundle.cjs');
const READY_TIMEOUT_MS = Number(process.env.DOMINO_READY_TIMEOUT_MS || 30000);

function log(message) { console.log('[domino-mobile] ' + message); }
function warn(message) { console.warn('[domino-mobile] ' + message); }

// The bundle reads both of these at load time.
process.env.PORT = PORT;
process.env.DOMINO_PUBLIC_DIR = PUBLIC_DIR;

// The Android side has no stop() and no restart (the plugin exposes only
// isReady/send/start, and `started` is one-shot), so a crash here means a dead
// game until the app is relaunched. Keep the process alive and log loudly.
process.on('uncaughtException', (err) => warn('uncaughtException: ' + ((err && err.stack) || err)));
process.on('unhandledRejection', (err) => warn('unhandledRejection: ' + ((err && err.stack) || err)));

// `bridge` only resolves inside the app (NODE_PATH = project dir + builtin_modules).
let bridge = null;
try {
  bridge = require('bridge');
  log('bridge module attached — app event channel is live');
} catch (err) {
  warn('bridge module not available (' + ((err && err.message) || err) + ') — continuing without the app channel');
}

log('runtime dir  : ' + RUNTIME_DIR);
log('server bundle: ' + BUNDLE);
log('public dir   : ' + PUBLIC_DIR);
log('port         : ' + PORT);

if (bridge) {
  // The plugin forwards its own lifecycle on the system channel; the server
  // keeps running in the background, we only want the log trail on device.
  try {
    bridge.app.on('pause', () => log('app paused — server keeps running'));
    bridge.app.on('resume', () => log('app resumed'));
  } catch (err) {
    warn('could not subscribe to app lifecycle events: ' + ((err && err.message) || err));
  }
}

log('starting server bundle …');
require(BUNDLE);   // listens on PORT as a side effect of being loaded
log('server bundle loaded');

function probeHealthz(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: Number(PORT), path: '/healthz', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ ok: res.statusCode === 200 && body.trim() === 'ok', status: res.statusCode, body: body.trim() }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

// `Nodejs.start()` resolves before Node is actually running, so the only honest
// readiness signal is the server answering for itself. Log it in one clear line
// and mirror it to the app channel.
(async () => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const res = await probeHealthz(1500);
    if (res.ok) {
      log('READY — Domino Arena server answered /healthz on http://127.0.0.1:' + PORT + ' (ok)');
      if (bridge) {
        try { bridge.channel.post('server-ready', { port: Number(PORT) }); }
        catch (err) { warn('could not post server-ready: ' + ((err && err.message) || err)); }
      }
      return;
    }
    if (Date.now() >= deadline) {
      warn('NOT READY — no /healthz answer within ' + READY_TIMEOUT_MS + ' ms (last: ' + (res.error || ('HTTP ' + res.status)) + ')');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();
