// Headless harness: start the Vite dev server and headless Chromium, open the
// viewer, and wait until it reports ready (or an error). Used by the e2e test
// and the screenshot script.

import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import type { ViewerStatus } from "../src/main.ts";

const viewerRoot = path.resolve(import.meta.dirname, "..");

export interface Session {
  page: Page;
  status(): Promise<Omit<ViewerStatus, "pixel">>;
  pixel(x: number, y: number): Promise<[number, number, number]>;
  close(): Promise<void>;
}

export interface OpenOptions {
  dataDir?: string;   // static ground/<token>/*.arrow instead of the cell server
  query?: string;     // e.g. "graph=1&radius=300"
  hash?: string;      // camera, "#lat,lon,alt,yaw,pitch"; default is the viewer's default view
  width: number;
  height: number;
  timeoutMs?: number; // how long to wait for the first cells (the cell server may download OSM)
}

export async function openViewer(o: OpenOptions): Promise<Session> {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    if (o.dataDir) process.env.CELLGEN_SERVER = "";  // read by vite.config.ts
    server = await createServer({
      configFile: path.join(viewerRoot, "vite.config.ts"),
      ...(o.dataDir ? { publicDir: o.dataDir } : {}),
      server: { port: 0, strictPort: false },
      logLevel: "warn",
    });
    await server.listen();
    const base = server.resolvedUrls!.local[0]!;

    // Software WebGL (SwiftShader): no GPU needed, and pixels are deterministic.
    browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1 });
    const logs: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
    page.on("pageerror", (e) => logs.push(e.message));

    await page.goto(`${base}?${o.query ?? ""}${o.hash ?? ""}`);
    await page.waitForFunction(() => window.viewer?.state !== "loading", null, { timeout: o.timeoutMs ?? 30_000 });

    const status = () => page.evaluate(() => {
      const { pixel: _, ...rest } = window.viewer;
      return rest;
    });
    const s = await status();
    if (s.state === "error") throw new Error(`viewer: ${s.error}\n${logs.join("\n")}`);

    const b = browser, srv = server;
    return {
      page,
      status,
      pixel: (x, y) => page.evaluate(([x, y]) => window.viewer.pixel!(x, y), [x, y] as const),
      async close() {
        await b.close();
        await srv.close();
      },
    };
  } catch (err) {
    await browser?.close();
    await server?.close();
    throw err;
  }
}
