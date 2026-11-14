#!/usr/bin/env node
/**
 * Build a static export for GitHub Pages.
 * Stashes Next.js route handlers (BFF) which are incompatible with `output: 'export'`,
 * then restores them after the build.
 *
 * Defaults for project Pages when unset:
 *   NEXT_PUBLIC_BASE_PATH=/CycleGen
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const apiDir = path.join(root, "src", "app", "api");
const stashDir = path.join(root, ".static-export-stash", "api");

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function stashApi() {
  if (!fs.existsSync(apiDir)) return false;
  fs.rmSync(stashDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stashDir), { recursive: true });
  fs.renameSync(apiDir, stashDir);
  return true;
}

function restoreApi(didStash) {
  if (!didStash) return;
  if (fs.existsSync(apiDir)) {
    fs.rmSync(apiDir, { recursive: true, force: true });
  }
  fs.renameSync(stashDir, apiDir);
  fs.rmSync(path.dirname(stashDir), { recursive: true, force: true });
}

function finalizePagesArtifact(outDir) {
  // GitHub Pages runs Jekyll by default; disable it so `_next/` is published.
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
  // Ensure a root 404 for project Pages deep links.
  const notFound = path.join(outDir, "404.html");
  if (!fs.existsSync(notFound)) {
    const nested = path.join(outDir, "404", "index.html");
    if (fs.existsSync(nested)) {
      fs.copyFileSync(nested, notFound);
    }
  }
}

let didStash = false;
try {
  didStash = stashApi();
  const basePath =
    (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "") || "/CycleGen";
  run("npx", ["next", "build"], {
    CYCLEGEN_STATIC_EXPORT: "1",
    NEXT_PUBLIC_STATIC_EXPORT: "1",
    NEXT_PUBLIC_API_MODE: "direct",
    NEXT_PUBLIC_BASE_PATH: basePath,
    // Ensure Pages demo flags survive even if the shell env was empty.
    NEXT_PUBLIC_DEMO_OSRM_ONLY:
      process.env.NEXT_PUBLIC_DEMO_OSRM_ONLY || "1",
    NEXT_PUBLIC_DISABLE_HERE: process.env.NEXT_PUBLIC_DISABLE_HERE || "1",
  });
  const out = path.join(root, "out");
  if (!fs.existsSync(out)) {
    console.error("static-export: expected frontend/out after build");
    process.exit(1);
  }
  finalizePagesArtifact(out);
  if (!fs.existsSync(path.join(out, "index.html"))) {
    console.error("static-export: missing out/index.html");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(out, ".nojekyll"))) {
    console.error("static-export: missing out/.nojekyll");
    process.exit(1);
  }
  console.log(`static-export: OK → frontend/out (basePath=${basePath})`);
} finally {
  restoreApi(didStash);
}
