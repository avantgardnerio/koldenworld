// Dev server for the viewer. Exported areas are served as static files:
// data/export/<area>/*.arrow → /<area>/*.arrow. VIEWER_DATA overrides the directory.

import path from "node:path";
import { defineConfig } from "vite";

const repo = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  root: import.meta.dirname,
  publicDir: process.env.VIEWER_DATA ?? path.join(repo, "data/export"),
  server: { port: 5173 },
});
