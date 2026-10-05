/**
 * Vite plugin: serve the team's deliveries in 3d_models/ at /models/ exactly as delivered.
 *
 * The files are never copied into src/ or public/, renamed or re-encoded (CLAUDE.md
 * section 11). Dev and preview stream them from disk; a production build copies them
 * byte for byte into dist/models/ with the same folder and file names.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { Plugin } from "vite";

export const MODELS_URL = "/models";

const CONTENT_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".exr": "image/x-exr",
  ".hdr": "image/vnd.radiance",
};

/** Absolute file for a request path below /models/, or null (unknown type, outside the folder). */
export function resolveModelFile(root: string, urlPath: string): string | null {
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath.split("?")[0] ?? "");
  } catch {
    return null;
  }
  const file = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  if (!file.startsWith(root + path.sep)) return null;
  if (!(path.extname(file).toLowerCase() in CONTENT_TYPES)) return null;
  return file;
}

function handler(root: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const file = resolveModelFile(root, req.url ?? "");
    if (!file) return next();
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "no-cache"); // revalidate: cheap 304s for the 72 MB skybox
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader("Content-Type", CONTENT_TYPES[path.extname(file).toLowerCase()]!);
      res.setHeader("Content-Length", stat.size);
      fs.createReadStream(file).pipe(res);
    });
  };
}

export function deliveredModels(root: string): Plugin {
  const absolute = path.resolve(root);
  let outDir = "dist";
  let building = false;
  return {
    name: "emergencyflow-delivered-models",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      building = config.command === "build" && !config.build.watch;
    },
    configureServer(server) {
      server.middlewares.use(MODELS_URL, handler(absolute));
    },
    configurePreviewServer(server) {
      server.middlewares.use(MODELS_URL, handler(absolute));
    },
    closeBundle() {
      if (!building) return; // the dev server calls this hook on shutdown too
      // byte-exact copy, same names; the workbook and other documents are not served
      fs.cpSync(absolute, path.join(outDir, MODELS_URL.slice(1)), {
        recursive: true,
        filter: (src) =>
          fs.statSync(src).isDirectory() || path.extname(src).toLowerCase() in CONTENT_TYPES,
      });
    },
  };
}
