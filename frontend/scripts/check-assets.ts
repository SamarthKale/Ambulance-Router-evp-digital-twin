/**
 * npm run check:assets [-- --strict]
 *
 * Read-only report on the delivered models against the manifest (CLAUDE.md section 11):
 * triangles vs budget, size in the file and after the manifest's fit (vs the placeholder
 * size the city layout plans with), longest horizontal axis (forward sign unconfirmed),
 * driven parts, extensions, file size, the ATTRIBUTIONS.md row, Git LFS pointers, and the
 * manifest's owner/priority against the workbook (the source of truth).
 *
 * Errors (missing or unreadable file, workbook mismatch) exit 1. Warnings exit 0, or 1 with
 * --strict (for CI).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { NodeIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";

import { MANIFEST, SKYBOX, type AssetEntry, type AssetKey } from "../src/assets/manifest.ts";
import { matchPart } from "../src/assets/names.ts";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(FRONTEND, "..");
export const MODELS = path.join(REPO, "3d_models");
export const WORKBOOK = path.join(MODELS, "EmergencyFlow_3D_Asset_Checklist_Assigned.xlsx");
const ATTRIBUTIONS = path.join(REPO, "ATTRIBUTIONS.md");
const SIZE_TOLERANCE = 0.15;
const UNSUPPORTED = ["KHR_draco_mesh_compression", "EXT_meshopt_compression"]; // no decoders shipped

export interface Issue {
  level: "error" | "warning";
  key: string;
  message: string;
}

// ---- workbook (an .xlsx is a zip of XML; read it without a dependency) ----------------
function unzip(file: string): Map<string, Buffer> {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error(`${path.basename(file)} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + skip;
  }
  return files;
}

const xmlText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export interface WorkbookRow {
  asset: string;
  priority: string;
  owner: string;
}

/** The asset rows of the workbook's first sheet (namespace prefixes like `x:` allowed). */
export function readWorkbook(file = WORKBOOK): WorkbookRow[] {
  const zip = unzip(file);
  const ns = "(?:\\w+:)?";
  const tag = (name: string, flags = "g") => new RegExp(`<${ns}${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}${name}>`, flags);
  const strings = [...(zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(tag("si"))].map((m) =>
    xmlText([...m[1]!.matchAll(tag("t"))].map((t) => t[1]).join("")),
  );
  const sheet = zip.get("xl/worksheets/sheet1.xml")?.toString("utf8") ?? "";
  const cell = new RegExp(`<${ns}c r="([A-Z]+)\\d+"([^>]*?)(?:/>|>([\\s\\S]*?)</${ns}c>)`, "g");
  const rows = [...sheet.matchAll(tag("row"))].map((row) => {
    const cells: Record<string, string> = {};
    for (const c of row[1]!.matchAll(cell)) {
      const [, col, attrs, body = ""] = c;
      const v = body.match(tag("v", ""))?.[1];
      const inline = [...body.matchAll(tag("t"))].map((t) => t[1]).join("") || undefined;
      cells[col!] = attrs!.includes('t="s"') && v !== undefined ? strings[+v]! : xmlText(v ?? inline ?? "");
    }
    return cells;
  });
  const header = rows[0] ?? {};
  const column = (name: string) => Object.keys(header).find((k) => header[k] === name) ?? "";
  const [a, p, o] = [column("Asset"), column("Priority"), column("Owner")];
  return rows
    .slice(1)
    .filter((r) => r[a])
    .map((r) => ({ asset: r[a]!, priority: r[p] ?? "", owner: r[o] ?? "" }));
}

/** Manifest owner/priority against the workbook: every row covered, no row misattributed. */
export function checkWorkbook(rows: WorkbookRow[]): Issue[] {
  const issues: Issue[] = [];
  const entries = [
    ...(Object.entries(MANIFEST) as [string, AssetEntry][]),
    ["skybox", { ...SKYBOX } as unknown as AssetEntry] as [string, AssetEntry],
  ];
  for (const row of rows) {
    const covering = entries.filter(([, e]) => e.workbook === row.asset);
    if (covering.length === 0) issues.push({ level: "error", key: "workbook", message: `"${row.asset}" has no manifest entry` });
    for (const [key, e] of covering) {
      if (e.owner !== row.owner) issues.push({ level: "error", key, message: `owner ${e.owner}, workbook says ${row.owner}` });
      if (e.priority !== row.priority) issues.push({ level: "error", key, message: `priority ${e.priority}, workbook says ${row.priority}` });
    }
  }
  for (const [key, e] of entries) {
    if (e.workbook !== null && !rows.some((r) => r.asset === e.workbook)) {
      issues.push({ level: "error", key, message: `workbook asset "${e.workbook}" is not in the workbook` });
    }
  }
  return issues;
}

/** Files on disk and their ATTRIBUTIONS.md rows. */
export function checkFiles(): Issue[] {
  const issues: Issue[] = [];
  const attributions = fs.readFileSync(ATTRIBUTIONS, "utf8");
  const files = [...Object.entries(MANIFEST).map(([k, e]) => [k, e.file] as const), ["skybox", SKYBOX.file] as const];
  for (const [key, file] of files) {
    const full = path.join(MODELS, file);
    if (!fs.existsSync(full)) {
      issues.push({ level: "error", key, message: `missing file 3d_models/${file}` });
      continue;
    }
    const head = Buffer.alloc(64);
    const fd = fs.openSync(full, "r");
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    if (head.toString("utf8").startsWith("version https://git-lfs")) {
      issues.push({ level: "error", key, message: "Git LFS pointer, not the model: run `git lfs pull`" });
    }
    if (!attributions.includes(path.basename(file))) {
      issues.push({ level: "warning", key, message: `no ATTRIBUTIONS.md row for ${path.basename(file)}` });
    }
  }
  return issues;
}

// ---- models ---------------------------------------------------------------------------
interface ModelReport {
  key: AssetKey;
  mb: number;
  triangles: number;
  raw: number[];
  fitted: number[];
  longest: "x" | "z";
  parts: string;
  nodes: string[];
  extensions: string[];
}

function triangles(doc: Document): number {
  let n = 0;
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  scene?.traverse((node) => {
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      if (prim.getMode() !== 4) continue; // TRIANGLES
      n += Math.floor((prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")?.getCount() ?? 0) / 3);
    }
  });
  return n;
}

/** Size after the manifest's rotationY and fit, from the file's bounding box. */
export function fittedSize(entry: AssetEntry, min: number[], max: number[]): number[] {
  const yaw = entry.rotationY ?? 0;
  const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
  const xs: number[] = [];
  const zs: number[] = [];
  for (const x of [min[0]!, max[0]!]) {
    for (const z of [min[2]!, max[2]!]) {
      xs.push(c * x + s * z);
      zs.push(-s * x + c * z);
    }
  }
  const size = [Math.max(...xs) - Math.min(...xs), max[1]! - min[1]!, Math.max(...zs) - Math.min(...zs)];
  let scale = entry.scale ?? 1;
  if (entry.fit) {
    const measured = size["xyz".indexOf(entry.fit.axis)]!;
    if (measured > 0) scale = entry.fit.meters / measured;
  }
  return size.map((v) => v * scale);
}

async function inspect(io: NodeIO, key: AssetKey, issues: Issue[]): Promise<ModelReport | null> {
  const entry: AssetEntry = MANIFEST[key];
  const full = path.join(MODELS, entry.file);
  let doc: Document;
  try {
    doc = await io.read(full);
  } catch (error) {
    issues.push({ level: "error", key, message: `cannot read: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0]!;
  const { min, max } = getBounds(scene);
  const raw = max.map((v, i) => v - min[i]!);
  const fitted = fittedSize(entry, min, max);
  const extensions = root.listExtensionsUsed().map((e) => e.extensionName);
  const nodes = root.listNodes().map((n) => n.getName()).filter(Boolean);
  const driven = [...(entry.requiredParts ?? []), ...(entry.optionalParts ?? [])];
  const found = new Set(nodes.map((n) => matchPart(n, driven, entry.aliases)).filter((p): p is string => p !== null));
  const missing = (entry.requiredParts ?? []).filter((p) => !found.has(p));
  let bytes = fs.statSync(full).size;
  for (const buffer of root.listBuffers()) {
    const uri = buffer.getURI();
    if (uri && entry.file.endsWith(".gltf")) bytes += fs.statSync(path.join(path.dirname(full), uri)).size;
  }
  for (const texture of root.listTextures()) {
    const uri = texture.getURI();
    if (uri && entry.file.endsWith(".gltf")) bytes += fs.statSync(path.join(path.dirname(full), uri)).size;
  }
  const tris = triangles(doc);
  if (tris > entry.triBudget) issues.push({ level: "warning", key, message: `${tris} triangles, guideline ${entry.triBudget} (renderer LOD handles it; file stays as delivered)` });
  for (const ext of extensions.filter((e) => UNSUPPORTED.includes(e))) {
    issues.push({ level: "error", key, message: `${ext}: needs a self-hosted decoder in public/` });
  }
  if (missing.length) issues.push({ level: "warning", key, message: `missing required parts ${missing.join(", ")} (generated stand-ins are used)` });
  const drift = fitted.map((v, i) => Math.abs(v - entry.placeholder.size[i]!) / Math.max(0.01, entry.placeholder.size[i]!));
  if (Math.max(...drift) > SIZE_TOLERANCE) {
    issues.push({ level: "warning", key, message: `placeholder size ${entry.placeholder.size.join(" x ")} vs fitted model ${fitted.map((v) => v.toFixed(2)).join(" x ")}` });
  }
  const longest = fitted[0]! > fitted[2]! ? "x" : "z";
  if (entry.fit?.axis === "z" && longest !== "z") {
    issues.push({ level: "warning", key, message: "fitted along z (forward) but the longest horizontal axis is x: check rotationY" });
  }
  return {
    key,
    mb: bytes / 1e6,
    triangles: tris,
    raw,
    fitted,
    longest,
    parts: driven.length ? `${[...found].join(", ") || "-"}${missing.length ? ` (missing ${missing.join(", ")})` : ""}` : "",
    nodes,
    extensions,
  };
}

/** Files in 3d_models/ no manifest entry uses (a .gltf's buffers and textures count as used). */
function unmapped(): string[] {
  const used = new Set([...Object.values(MANIFEST).map((e) => e.file), SKYBOX.file].map((f) => path.join(MODELS, f)));
  for (const e of Object.values(MANIFEST)) {
    if (!e.file.endsWith(".gltf")) continue;
    const json = JSON.parse(fs.readFileSync(path.join(MODELS, e.file), "utf8")) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    for (const r of [...(json.buffers ?? []), ...(json.images ?? [])]) if (r.uri) used.add(path.join(MODELS, path.dirname(e.file), decodeURIComponent(r.uri)));
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (/\.(glb|gltf|bin|png|jpe?g|webp|exr|hdr)$/i.test(d.name) && !used.has(p)) out.push(path.relative(MODELS, p));
    }
  };
  walk(MODELS);
  return out;
}

const fmt = (v: number[]) => v.map((x) => (x >= 100 ? x.toFixed(0) : x.toFixed(2))).join(" x ");

async function main(): Promise<number> {
  const strict = process.argv.includes("--strict");
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const issues: Issue[] = [...checkFiles()];
  const rows = readWorkbook();
  issues.push(...checkWorkbook(rows));
  console.log(`check:assets  ${Object.keys(MANIFEST).length} manifest entries + skybox · workbook rows: ${rows.length}\n`);
  console.log(["key".padEnd(18), "MB".padStart(6), "tris".padStart(7), "budget".padStart(7), "  file size (units)".padEnd(28), "fitted (m)".padEnd(22), "long", "parts / extensions"].join(" "));
  for (const key of Object.keys(MANIFEST) as AssetKey[]) {
    if (issues.some((i) => i.key === key && i.level === "error")) continue;
    const r = await inspect(io, key, issues);
    if (!r) continue;
    const extra = [r.parts, r.extensions.length ? `[${r.extensions.join(", ")}]` : ""].filter(Boolean).join(" ");
    console.log(
      [key.padEnd(18), r.mb.toFixed(2).padStart(6), String(r.triangles).padStart(7), String(MANIFEST[key].triBudget).padStart(7),
        `  ${fmt(r.raw)}`.padEnd(28), fmt(r.fitted).padEnd(22), r.longest.padEnd(4), extra].join(" "),
    );
  }
  const loose = unmapped();
  if (loose.length) issues.push(...loose.map((f) => ({ level: "warning" as const, key: "3d_models", message: `not used by the manifest: ${f}` })));
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  console.log("\nforward: the longest horizontal axis after rotationY; its sign is unconfirmed (check /assets).");
  for (const i of [...errors, ...warnings]) console.log(`${i.level === "error" ? "ERROR" : "warn "}  ${i.key}: ${i.message}`);
  console.log(`\n${errors.length} errors, ${warnings.length} warnings${strict ? " (strict)" : ""}`);
  return errors.length || (strict && warnings.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
