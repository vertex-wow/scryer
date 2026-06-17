import * as nodePath from "path";
import * as nodeFs from "fs";
import { parseToc, type TocFile } from "../parser/toc.js";

export interface AddonNode {
  name: string;
  tocPath: string;
  toc: TocFile;
  addonDir: string;
}

export interface AddonGraphResult {
  /** Required dep addons in topological load order (before the main addon). */
  loadOrder: AddonNode[];
  /** Required dep names that could not be located in any search path. */
  missing: string[];
  /** Cycles detected — each entry is the dep name chain that forms the cycle. */
  cycles: string[][];
}

export interface AddonGraphOptions {
  mainToc: TocFile;
  /** Name of the main addon (used to prevent it loading as its own dep). */
  mainAddonName: string;
  /** Directories that directly contain addon subdirectories (e.g. Interface/AddOns). Tried in order. */
  searchPaths: string[];
  /** TOC family suffix to prefer ("Mainline", "Classic", …). Falls back to plain name. */
  tocFamily: string;
  readFile: (absPath: string) => Promise<string>;
  /** Synchronous path existence check — injectable for tests. */
  existsSync?: (path: string) => boolean;
}

function findTocPath(
  addonName: string,
  searchPaths: string[],
  tocFamily: string,
  existsSync: (p: string) => boolean,
): string | null {
  for (const searchPath of searchPaths) {
    if (!searchPath) continue;
    const addonDir = nodePath.join(searchPath, addonName);
    for (const tocName of [`${addonName}_${tocFamily}.toc`, `${addonName}.toc`]) {
      const tocPath = nodePath.join(addonDir, tocName);
      if (existsSync(tocPath)) return tocPath;
    }
  }
  return null;
}

/**
 * Resolve the full required-dependency graph for a TOC file.
 *
 * Performs a depth-first traversal of ## RequiredDeps (and ## Dependencies) chains,
 * topologically sorts the result, detects cycles (which are broken without failing),
 * and records any deps that could not be located.
 *
 * Optional deps (## OptionalDeps) are not loaded — they are purely informational.
 */
export async function resolveAddonGraph(opts: AddonGraphOptions): Promise<AddonGraphResult> {
  const { mainToc, mainAddonName, searchPaths, tocFamily, readFile } = opts;
  const existsSync = opts.existsSync ?? nodeFs.existsSync;

  const nodes = new Map<string, AddonNode>();
  const missing: string[] = [];
  const cycles: string[][] = [];

  async function loadNode(name: string): Promise<AddonNode | null> {
    const key = name.toLowerCase();
    if (nodes.has(key)) return nodes.get(key)!;

    const tocPath = findTocPath(name, searchPaths, tocFamily, existsSync);
    if (!tocPath) {
      if (!missing.includes(name)) missing.push(name);
      return null;
    }

    let content: string;
    try {
      content = await readFile(tocPath);
    } catch {
      if (!missing.includes(name)) missing.push(name);
      return null;
    }

    const toc = parseToc(content, tocPath);
    const addonDir = nodePath.dirname(tocPath);
    const node: AddonNode = { name, tocPath, toc, addonDir };
    nodes.set(key, node);
    return node;
  }

  // state tracks DFS status per addon name (lowercased)
  const state = new Map<string, "visiting" | "done">();
  const loadOrder: AddonNode[] = [];

  // Seed "done" with the main addon so it can never appear as its own dep.
  state.set(mainAddonName.toLowerCase(), "done");

  async function visit(name: string, visiting: readonly string[]): Promise<void> {
    const key = name.toLowerCase();
    if (state.get(key) === "done") return;
    if (visiting.some((v) => v.toLowerCase() === key)) {
      cycles.push([...visiting, name]);
      return;
    }

    const node = await loadNode(name);
    if (!node) return;

    state.set(key, "visiting");
    const nextVisiting = [...visiting, name];

    for (const dep of node.toc.requiredDeps) {
      await visit(dep, nextVisiting);
    }

    state.set(key, "done");
    loadOrder.push(node);
  }

  for (const dep of mainToc.requiredDeps) {
    await visit(dep, []);
  }

  return { loadOrder, missing, cycles };
}
