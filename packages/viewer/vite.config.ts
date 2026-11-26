// Dev server for the viewer. /ground/<token>/<table>.arrow and /aircraft are
// proxied to the Rust cell generator (`cellgen serve`, which builds cells on a
// miss; CELLGEN_SERVER overrides its URL).
// CELLGEN_SERVER="" turns the proxy off, so cells are served as static files
// from a public directory instead (VIEWER_DATA, or the harness's), as the
// hermetic e2e test does. `vite build` writes the release build to dist/,
// which `cellgen serve --static` serves (the container, docs/serverless-plan.md).

import { defineConfig } from "vite";

const cellgenServer = process.env.CELLGEN_SERVER ?? "http://127.0.0.1:5175";

export default defineConfig({
  root: import.meta.dirname,
  publicDir: process.env.VIEWER_DATA ?? false,
  server: {
    port: 5173,
    // Demos to friends: Caddy on bgdesktop terminates TLS and basic auth, then proxies here.
    allowedHosts: ["koldenworld.squarelabs.net"],
    proxy: cellgenServer ? {
      "/aircraft": { target: cellgenServer },
      "/ground": { target: cellgenServer, timeout: 600_000, proxyTimeout: 600_000 },
    } : undefined,
  },
});
