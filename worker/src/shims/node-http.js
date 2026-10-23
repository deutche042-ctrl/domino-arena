// worker/src/shims/node-http.js
// The game server only needs createServer(app) so it can hand the app to
// socket.io and call listen(). On Workers there is no listening socket: the
// Durable Object's fetch handler dispatches into the app instead, so listen()
// is a no-op that records the port.
//
// The created server is remembered because it is the one place that holds both
// halves the Worker needs: __handler is the express app, __io is the socket.io
// shim instance (set by the socket.io shim's constructor).

let lastServer = null;

function createServer(handler) {
  const server = {
    __handler: handler,
    __port: null,
    __listening: false,
    listen(port, ...rest) {
      server.__port = typeof port === 'number' ? port : Number(port) || 0;
      server.__listening = true;
      for (const arg of rest) if (typeof arg === 'function') arg();
      return server;
    },
    close(callback) {
      server.__listening = false;
      if (typeof callback === 'function') callback();
      return server;
    },
    address() {
      return { address: '0.0.0.0', family: 'IPv4', port: server.__port || 0 };
    },
    on() {
      return server;
    },
    once() {
      return server;
    },
    setTimeout() {
      return server;
    },
  };
  lastServer = server;
  return server;
}

function getLastServer() {
  return lastServer;
}

function get() {
  throw new Error('node:http client requests are not available in this shim');
}

export { createServer, get, getLastServer };
export default { createServer, get, getLastServer };
