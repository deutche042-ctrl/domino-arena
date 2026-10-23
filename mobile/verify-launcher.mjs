#!/usr/bin/env node
/*
 * Domino Arena — launcher proof (`node verify-launcher.mjs`).
 *
 * Starts the in-app server as a child process, waits until it answers
 * http://127.0.0.1:3000/healthz, fetches /host-info, kills it, prints one JSON
 * report and exits 0 only if every pass really passed.
 *
 * Two passes, both required:
 *   1. "source-launcher"  runs `node node/index.cjs` (the file kept in the repo),
 *                         pointed at the assembled bundle via env.
 *   2. "device-layout"    runs `node www/nodejs/index.cjs` with no env at all —
 *                         exactly what the plugin does on Android after it
 *                         copies assets/public/nodejs into its files dir.
 *
 * Before each pass the port is checked to be free, so a leftover server can
 * never make the run look green.
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MOBILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DOMINO_PORT || 3000);
const BASE = 'http://127.0.0.1:' + PORT;
const READY_TIMEOUT_MS = Number(process.env.DOMINO_READY_TIMEOUT_MS || 30000);

const report = { ok: false, startedAt: new Date().toISOString(), port: PORT, base: BASE, passes: [], preconditions: [] };

function request(pathname, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ reached: true, status: res.statusCode, body: body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ reached: false, error: err.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPortFree(ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const res = await request('/healthz', 800);
    if (!res.reached) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

function killTree(child) {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
      setTimeout(() => resolve(), 500);
    }, 5000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function runPass(name, entryAbs, extraEnv) {
  const rel = path.relative(MOBILE_DIR, entryAbs).split(path.sep).join('/');
  const pass = { name, entry: rel, command: 'node ' + rel, env: extraEnv, ok: false };

  if (!existsSync(entryAbs)) {
    pass.error = 'entry not found: ' + entryAbs;
    report.passes.push(pass);
    return false;
  }

  const free = await waitForPortFree(5000);
  if (!free) {
    pass.error = 'port ' + PORT + ' already answers /healthz before start — refusing to run (result would prove nothing)';
    report.passes.push(pass);
    return false;
  }

  const startedAt = Date.now();
  const child = spawn(process.execPath, [rel], {
    cwd: MOBILE_DIR,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pass.pid = child.pid;

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let exitedEarly = null;
  child.once('exit', (code, signal) => { exitedEarly = { code, signal }; });

  // 1. wait for /healthz
  let health = null;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await request('/healthz', 1500);
    if (res.reached && res.status === 200 && res.body.trim() === 'ok') { health = res; break; }
    if (exitedEarly) break;
    await sleep(250);
  }
  pass.readyMs = Date.now() - startedAt;
  pass.healthz = health ? { reached: true, status: health.status, body: health.body.trim() } : { reached: false, error: 'no 200 "ok" from /healthz within ' + READY_TIMEOUT_MS + ' ms' };

  // 2. /host-info, same child
  if (health) {
    const res = await request('/host-info', 3000);
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* reported as null */ }
    pass.hostInfo = { reached: res.reached, status: res.status, json };
  } else {
    pass.hostInfo = { reached: false, skipped: true };
  }

  pass.launcherLogLine = /READY — .*\/healthz .*\(ok\)/.test(stdout) ? stdout.split(/\r?\n/).find((l) => l.includes('READY —')) : null;
  pass.exitBeforeProbe = exitedEarly;

  await killTree(child);
  pass.stdout = stdout;
  pass.stderr = stderr;

  const hi = pass.hostInfo;
  pass.ok = !!(health && hi && hi.reached && hi.status === 200 && hi.json && Number(hi.json.port) === PORT && Array.isArray(hi.json.ips));
  if (!pass.ok) {
    pass.error = pass.error || 'healthz/host-info contract not satisfied';
  }
  report.passes.push(pass);
  return pass.ok;
}

async function main() {
  // Static layout: the plugin looks for assets at "public/" + nodeDir, which is
  // assets/public/nodejs on the device — that is www/nodejs here.
  const pkgPath = path.join(MOBILE_DIR, 'www', 'nodejs', 'package.json');
  const cfgPath = path.join(MOBILE_DIR, 'capacitor.config.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null;
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
  report.preconditions.push(
    { check: 'capacitor.config.json webDir', value: cfg?.webDir, ok: cfg?.webDir === 'www' },
    { check: 'plugins.Nodejs.nodeDir (must resolve inside webDir)', value: cfg?.plugins?.Nodejs?.nodeDir, ok: cfg?.plugins?.Nodejs?.nodeDir === 'nodejs' },
    { check: 'plugins.Nodejs.startMode', value: cfg?.plugins?.Nodejs?.startMode, ok: cfg?.plugins?.Nodejs?.startMode === 'manual' },
    { check: 'www/nodejs/package.json main', value: pkg?.main, ok: pkg?.main === 'index.cjs' },
    { check: 'www/nodejs/index.cjs exists', ok: existsSync(path.join(MOBILE_DIR, 'www', 'nodejs', 'index.cjs')) },
    { check: 'www/nodejs/server-bundle.cjs exists', ok: existsSync(path.join(MOBILE_DIR, 'www', 'nodejs', 'server-bundle.cjs')) },
    { check: 'www/nodejs/public/index.html exists', ok: existsSync(path.join(MOBILE_DIR, 'www', 'nodejs', 'public', 'index.html')) },
  );
  for (const p of report.preconditions) {
    console.log('[check] ' + p.check + ': ' + p.value + ' → ' + (p.ok ? 'ok' : 'FAIL'));
  }
  const preOk = report.preconditions.every((p) => p.ok);
  if (!preOk) {
    report.ok = false;
    report.error = 'preconditions failed — run `node sync.mjs` first';
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const bundle = path.join(MOBILE_DIR, 'www', 'nodejs', 'server-bundle.cjs');
  const nodePublic = path.join(MOBILE_DIR, 'www', 'nodejs', 'public');

  // Pass 1 — `node node/index.cjs` (the repo copy), told where the assembled
  // artifacts are.
  const p1 = await runPass('source-launcher', path.join(MOBILE_DIR, 'node', 'index.cjs'), {
    DOMINO_SERVER_BUNDLE: bundle,
    DOMINO_PUBLIC_DIR: nodePublic,
  });
  // Pass 2 — the shipped layout, no env overrides, entry resolved from
  // www/nodejs/package.json main, public/ next to the launcher.
  const p2 = await runPass('device-layout', path.join(MOBILE_DIR, 'www', 'nodejs', 'index.cjs'), {});

  report.ok = p1 && p2;
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  console.log(report.ok
    ? '[verify] OK — in-app server answered /healthz and /host-info on ' + BASE
    : '[verify] FAILED — see passes[] above');
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  report.ok = false;
  report.error = String((err && err.stack) || err);
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
});
