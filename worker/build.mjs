// worker/build.mjs — bundle the Worker for Cloudflare.
//
// The game server is imported unchanged, so this build is where its Node
// assumptions are redirected to the Cloudflare shims: express, socket.io,
// node:http and node:os are aliased, while node:crypto / node:path / node:url
// stay external and are provided by the runtime's nodejs_compat flag.

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (name) => path.join(here, 'src', 'shims', name);

await build({
  entryPoints: [path.join(here, 'src', 'index.js')],
  outfile: path.join(here, 'dist', 'worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  mainFields: ['module', 'main'],
  logLevel: 'info',
  alias: {
    'socket.io': shim('socketio.js'),
    express: shim('express.js'),
    'node:http': shim('node-http.js'),
    'node:os': shim('node-os.js'),
    'node:url': shim('node-url.js'),
  },
  external: ['node:crypto', 'node:path'],
});
