// Dev server for the viewer. /cells/* and /aircraft are proxied to the cell
// server (`npm run server`, which generates cells on a miss); CELL_SERVER overrides
// its URL, and CELL_SERVER="" turns the proxy off so cells are served as
// static files from the public directory instead (data/export, or
// VIEWER_DATA), as the hermetic e2e test does. /ground/<token>/<table> goes to
// the Rust cell generator (`cellgen serve`; CELLGEN_SERVER overrides its URL)
// as /cells/<token>/<table>.

import path from "node:path";
import { defineConfig } from "vite";

const repo = path.resolve(import.meta.dirname, "../..");
const cellServer = process.env.CELL_SERVER ?? "http://127.0.0.1:5174";
const cellgenServer = process.env.CELLGEN_SERVER ?? "http://127.0.0.1:5175";

export default defineConfig({
  root: import.meta.dirname,
  publicDir: process.env.VIEWER_DATA ?? path.join(repo, "data/export"),
  server: {
    port: 5173,
    // Demos to friends: Caddy on bgdesktop terminates TLS and basic auth, then proxies here.
    allowedHosts: ["koldenworld.squarelabs.net"],
    proxy: cellServer ? {
      "/cells": { target: cellServer, timeout: 600_000, proxyTimeout: 600_000 },
      "/aircraft": { target: cellServer },
      "/ground": {
        target: cellgenServer, timeout: 600_000, proxyTimeout: 600_000,
        rewrite: (p) => p.replace(/^\/ground\//, "/cells/"),
      },
    } : undefined,
  },
});
