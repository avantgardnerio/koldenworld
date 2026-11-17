import path from "node:path";

/** Gitignored directory for downloaded and generated data. */
export const DATA_DIR = path.resolve(import.meta.dirname, "../../../data");

export const exportDir = (area: string) => path.join(DATA_DIR, "export", area);

export const osmPaths = (area: string) => ({
  raw: path.join(DATA_DIR, "osm", `${area}.json`),
  meta: path.join(DATA_DIR, "osm", `${area}.meta.json`),
});
