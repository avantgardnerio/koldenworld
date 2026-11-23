import path from "node:path";

/** Gitignored directory for downloaded and generated data. */
export const DATA_DIR = path.resolve(import.meta.dirname, "../../../data");
