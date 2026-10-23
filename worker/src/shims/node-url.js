// worker/src/shims/node-url.js
// server.js computes its own directory with fileURLToPath(import.meta.url).
// Inside a bundled Worker that value is not a usable URL, and the runtime's own
// implementation throws on it, so this shim answers with a stable placeholder
// path. The path is only used to pick a default static-file directory, which the
// Worker serves from its assets binding instead.

const PLACEHOLDER = '/worker';

function fileURLToPath(input) {
  try {
    if (input instanceof URL) return decodeURIComponent(input.pathname);
    if (typeof input === 'string') return decodeURIComponent(new URL(input).pathname);
  } catch {
    /* fall through to the placeholder */
  }
  return PLACEHOLDER;
}

function pathToFileURL(input) {
  const value = String(input ?? '');
  return new URL(value.startsWith('/') ? `file://${value}` : `file:///${value}`);
}

function urlToHttpOptions(url) {
  return { pathname: url.pathname, search: url.search, protocol: url.protocol };
}

export { fileURLToPath, pathToFileURL, urlToHttpOptions };
export default { fileURLToPath, pathToFileURL, urlToHttpOptions };
