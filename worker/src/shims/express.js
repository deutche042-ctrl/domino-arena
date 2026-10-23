// worker/src/shims/express.js
// The slice of Express the game server actually uses: app.set/use/get,
// express.static, and a (req, res) handler pair with the response helpers
// server.js calls. Requests arrive as a fetch Request and leave as a Response
// so the Worker can serve them directly.

function buildRequest(request) {
  const url = new URL(request.url);
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '0.0.0.0';
  return {
    method: request.method,
    url: url.pathname + url.search,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: request.headers,
    protocol: 'https',
    ip,
    socket: { remoteAddress: ip },
    get header() {
      return url.pathname;
    },
  };
}

class ResponseBuilder {
  constructor() {
    this.statusCode = 200;
    this._headers = new Headers();
    this._body = null;
    this._ended = false;
    this._resolve = null;
    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  _finish(body) {
    if (this._ended) return;
    this._ended = true;
    this._body = body === undefined ? null : body;
    this._resolve();
  }

  setHeader(name, value) {
    this._headers.set(name, String(value));
  }

  getHeader(name) {
    return this._headers.get(name);
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(payload) {
    this._headers.set('Content-Type', 'application/json; charset=utf-8');
    this._finish(JSON.stringify(payload));
    return this;
  }

  send(payload) {
    if (payload === undefined || payload === null) this._finish(null);
    else if (typeof payload === 'object') return this.json(payload);
    else this._finish(String(payload));
    return this;
  }

  end(payload) {
    this._finish(payload === undefined ? null : payload);
    return this;
  }

  toResponse() {
    return new Response(this._body, { status: this.statusCode, headers: this._headers });
  }
}

function compilePath(path) {
  const pattern = String(path)
    .replace(/\/+$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\:([A-Za-z_][A-Za-z0-9_]*)/g, '(?<$1>[^/]+)');
  return new RegExp(`^${pattern || '/'}/?$`);
}

function createApp() {
  const layers = [];
  const routes = new Map();
  const settings = new Map();

  const app = function app(req, res) {
    // Node-style call signature; unused on Workers but kept for parity.
    return app.__dispatch(req, res);
  };

  app.set = (key, value) => {
    settings.set(key, value);
    return app;
  };

  app.get = (path, ...handlers) => {
    routes.set(compilePath(path), handlers);
    return app;
  };

  app.use = (pathOrHandler, maybeHandler) => {
    if (typeof pathOrHandler === 'function') layers.push({ match: null, handler: pathOrHandler });
    else layers.push({ match: compilePath(pathOrHandler), handler: maybeHandler });
    return app;
  };

  /** Run the middleware chain, then the matching route. Returns a Response. */
  app.__dispatch = async (request) => {
    const req = buildRequest(request);
    const res = new ResponseBuilder();
    let index = -1;

    const next = async () => {
      index += 1;
      if (index < layers.length) {
        const layer = layers[index];
        if (layer.match && !layer.match.test(req.path)) return next();
        const out = layer.handler(req, res, next);
        if (out && typeof out.then === 'function') await out;
        if (res._ended) return undefined;
        return next();
      }
      for (const [pattern, handlers] of routes) {
        const match = pattern.exec(req.path);
        if (!match) continue;
        req.params = match.groups || {};
        for (const handler of handlers) {
          const out = handler(req, res, next);
          if (out && typeof out.then === 'function') await out;
          if (res._ended) return undefined;
        }
        return undefined;
      }
      // No route matched: let the asset layer answer.
      res.status(404).send('Not Found');
      return undefined;
    };

    await next();
    if (!res._ended) res.status(404).send('Not Found');
    return res.toResponse();
  };

  return app;
}

/** Static files are served by the Worker's assets binding, so this is a no-op. */
function staticMiddleware() {
  return function staticNoop(req, res, next) {
    return next();
  };
}

function express() {
  return createApp();
}

express.static = staticMiddleware;
express.Router = () => createApp();

export default express;
export { express };
