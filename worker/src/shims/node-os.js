// worker/src/shims/node-os.js
// Workers have no network interfaces to enumerate. The game only asks so that
// /host-info can list LAN addresses for the local-link QR flow, which does not
// apply to a deployed server, so an empty map is the honest answer.

const os = {
  networkInterfaces() {
    return {};
  },
  platform() {
    return 'linux';
  },
  type() {
    return 'Linux';
  },
  arch() {
    return 'x64';
  },
  hostname() {
    return 'cloudflare-worker';
  },
  tmpdir() {
    return '/tmp';
  },
  cpus() {
    return [];
  },
  totalmem() {
    return 0;
  },
  freemem() {
    return 0;
  },
};

export default os;
export const networkInterfaces = os.networkInterfaces;
export const platform = os.platform;
export const hostname = os.hostname;
