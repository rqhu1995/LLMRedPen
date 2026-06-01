// LLMRedPen: minimal Bun static server.
// Serves index.html, app.js, style.css, favicon.svg over localhost so
// that the browser File System Access API (which requires a secure
// context) works against folders the user picks at runtime.
//
// No filesystem IO happens here — all paper-folder reads and writes
// go through the browser's FSA against a user-granted directory handle.

import { serve, file } from "bun";
import { join, normalize } from "node:path";

const PORT = Number(process.env.MDA_PORT ?? 5173);
const ROOT = import.meta.dir;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".md":   "text/markdown; charset=utf-8",
  ".tex":  "application/x-tex; charset=utf-8",
};

function contentType(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  return TYPES[path.slice(idx).toLowerCase()] ?? "application/octet-stream";
}

serve({
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";

    // Prevent path traversal.
    const fullPath = normalize(join(ROOT, path));
    if (!fullPath.startsWith(ROOT)) {
      return new Response("Forbidden", { status: 403 });
    }

    const f = file(fullPath);
    if (!(await f.exists())) {
      return new Response("Not found: " + path, { status: 404 });
    }

    return new Response(f, {
      headers: { "Content-Type": contentType(path) },
    });
  },
});

console.log(`LLMRedPen → http://localhost:${PORT}/`);
console.log(`(Use Chrome / Edge / Arc / Brave — File System Access API required.)`);
