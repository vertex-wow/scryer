import * as fs from "fs";
import * as path from "path";
import { resolveCI } from "./blizzard-registry.js";
import { parseToc } from "./toc.js";
import { parseXmlFile } from "./xml.js";
import { collectTexturePaths } from "./collect-textures.js";

const TOC_SUFFIXES = ["_Mainline.toc", ".toc"];

function findTocPath(addonDir: string, addonName: string): string | null {
  for (const suffix of TOC_SUFFIXES) {
    const p = resolveCI(addonDir, `${addonName}${suffix}`);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      // try next suffix
    }
  }
  return null;
}

function loadXmlTextures(xmlPath: string, out: Set<string>, visited: Set<string>): void {
  const abs = path.resolve(xmlPath);
  if (visited.has(abs)) return;
  visited.add(abs);

  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    return;
  }

  let doc;
  try {
    doc = parseXmlFile(abs, content);
  } catch {
    return;
  }

  // Collect from concrete frames and template frames (both define textures directly).
  for (const p of collectTexturePaths([...doc.frames, ...doc.templates.values()])) {
    out.add(p);
  }

  const baseDir = path.dirname(abs);
  for (const inc of doc.includes) {
    loadXmlTextures(resolveCI(baseDir, inc), out, visited);
  }
}

/**
 * Collect all texture file paths referenced across a set of WoW addons.
 *
 * Discovers XML files via each addon's TOC, parses them (following <Include>
 * chains), and returns every distinct raw texture path found — across all
 * concrete frames, templates, and their children. No inheritance resolution
 * is applied; this is a raw enumeration of every file= attribute in the XML
 * corpus.
 *
 * Suitable as input to a batch extraction call or to pre-warm the asset cache
 * before a preview renders.
 *
 * @param addonsDir  Absolute path to the `Interface/AddOns/` directory.
 * @param addonNames Addon folder names to scan (order-insensitive).
 */
export function collectAddonTexturePaths(addonsDir: string, addonNames: string[]): string[] {
  if (!addonsDir || addonNames.length === 0) return [];

  const out = new Set<string>();
  const visited = new Set<string>();

  for (const addonName of addonNames) {
    const addonDir = resolveCI(addonsDir, addonName);
    const tocPath = findTocPath(addonDir, addonName);
    if (!tocPath) continue;

    let tocContent: string;
    try {
      tocContent = fs.readFileSync(tocPath, "utf-8");
    } catch {
      continue;
    }
    const toc = parseToc(tocContent);

    for (const file of toc.files) {
      if (file.toLowerCase().endsWith(".xml")) {
        loadXmlTextures(resolveCI(addonDir, file), out, visited);
      }
    }
  }

  return Array.from(out);
}
