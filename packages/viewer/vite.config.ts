// Dev server for the viewer. /cells/* and /aircraft are proxied to the cell
// server (`npm run server`, which generates cells on a miss); CELL_SERVER overrides
// its URL, and CELL_SERVER="" turns the proxy off so cells are served as
// static files from the public directory instead (data/export, or
// VIEWER_DATA), as the hermetic e2e test does.

import path from "node:path";
import { defineConfig } from "vite";

const repo = path.resolve(import.meta.dirname, "../..");
const cellServer = process.env.CELL_SERVER ?? "http://localhost:5174";

export default defineConfig({
  root: import.meta.dirname,
  publicDir: process.env.VIEWER_DATA ?? path.join(repo, "data/export"),
  server: {
    port: 5173,
    proxy: cellServer ? {
      "/cells": { target: cellServer, timeout: 600_000, proxyTimeout: 600_000 },
      "/aircraft": { target: cellServer },
    } : undefined,
  },
});
