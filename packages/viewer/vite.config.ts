// Dev server for the viewer. /ground/<token>/<table>.arrow and /aircraft are
// proxied to the Rust cell generator (`cellgen serve`, which builds cells on a
// miss; CELLGEN_SERVER overrides its URL), /ground as its /cells/<token>/<table>.
// CELLGEN_SERVER="" turns the proxy off, so cells are served as static files
// from the public directory instead (data/export, or VIEWER_DATA), as the
// hermetic e2e test does.

import path from "node:path";
import { defineConfig } from "vite";

const repo = path.resolve(import.meta.dirname, "../..");
const cellgenServer = process.env.CELLGEN_SERVER ?? "http://127.0.0.1:5175";

export default defineConfig({
  root: import.meta.dirname,
  publicDir: process.env.VIEWER_DATA ?? path.join(repo, "data/export"),
  server: {
    port: 5173,
    // Demos to friends: Caddy on bgdesktop terminates TLS and basic auth, then proxies here.
    allowedHosts: ["koldenworld.squarelabs.net"],
    proxy: cellgenServer ? {
      "/aircraft": { target: cellgenServer },
      "/ground": {
        target: cellgenServer, timeout: 600_000, proxyTimeout: 600_000,
        rewrite: (p) => p.replace(/^\/ground\//, "/cells/"),
      },
    } : undefined,
  },
});
