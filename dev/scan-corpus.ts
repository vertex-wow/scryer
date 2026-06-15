/**
 * scan-corpus — mine Blizzard addon Lua + XML files for API usage patterns.
 *
 * Walks _reference/wow-ui-source/Interface/AddOns/ and produces a JSON corpus
 * keyed by API name. Each entry holds up to MAX_SITES call sites with context.
 *
 * Usage:
 *   pnpm scan-corpus [--max-sites N] [--out <path>] [--ref-dir <path>]
 *
 * Output: .plan/api-corpus/corpus.json
 *
 * Key scheme:
 *   "CreateFrame"          — standalone PascalCase global call
 *   "C_Timer.After"        — C_Namespace.Method call
 *   "NineSliceUtil.Apply"  — Namespace.Method call (non-C_*)
 *   ":SetPoint"            — colon method call (receiver unknown)
 *
 * Addon scan order: canonical prewarmed addons first (so their call sites fill
 * sample slots before the remaining ~300 addons). All addons including
 * deprecated ones are included.
 */

import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = path.join(__dirname, "..");
const DEFAULT_REF_DIR = path.join(
  PROJECT_ROOT,
  "_reference",
  "wow-ui-source",
  "Interface",
  "AddOns",
);
const DEFAULT_OUT = path.join(PROJECT_ROOT, ".plan", "api-corpus", "corpus.json");
const DEFAULT_MAX_SITES = 25;
const CONTEXT_LINES = 3;

// Canonical addons scanned first so their sites fill the sample slots.
const PRIORITY_ADDONS = [
  "Blizzard_SharedXMLBase",
  "Blizzard_Colors",
  "Blizzard_SharedXML",
  "Blizzard_FrameXML",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CallSite {
  addon: string;
  file: string;
  line: number;
  ctx: string[];
}

interface ApiEntry {
  total: number;
  sites: CallSite[];
}

interface XmlCorpus {
  /** Frame type tag names sorted by frequency. */
  frameTypes: Record<string, number>;
  /** inherits= values sorted by frequency. */
  inherits: Record<string, number>;
  /** <OnLoad>, <OnClick> etc. event names, sorted by frequency. */
  scriptEvents: Record<string, number>;
  /** function="GlobalHandler" values on script event tags. */
  scriptFunctions: Record<string, number>;
  /** method="MixinMethod" values on script event tags. */
  scriptMethods: Record<string, number>;
}

interface Corpus {
  generatedAt: string;
  addonCount: number;
  fileCount: { lua: number; xml: number };
  lua: Record<string, ApiEntry>;
  xml: XmlCorpus;
}

// ---------------------------------------------------------------------------
// Lua regexes
// ---------------------------------------------------------------------------

// C_Namespace.Method(  →  key "C_Namespace.Method"
const C_CALL_RE = /\b(C_[A-Za-z0-9]+)\.([A-Za-z0-9_]+)\s*\(/g;

// PascalNS.Method(  →  key "PascalNS.Method"  (second char must be alpha so C_ is excluded)
const NS_CALL_RE = /\b([A-Z][A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)\s*\(/g;

// :Method(  →  key ":Method"
const METHOD_CALL_RE = /:([A-Za-z][A-Za-z0-9_]*)\s*\(/g;

// StandaloneCall(  →  key "StandaloneCall"
// Negative lookbehind for . : word-char prevents matching NS/method RHS.
const GLOBAL_CALL_RE = /(?<![.:\w])([A-Z][A-Za-z0-9_]+)\s*\(/g;

// ---------------------------------------------------------------------------
// XML regexes
// ---------------------------------------------------------------------------

// Opening tags that start with uppercase (WoW frame/widget element names)
const XML_TAG_RE = /<([A-Z][A-Za-z0-9]*)\b/g;
// inherits attribute (may be comma-separated list)
const XML_INHERITS_RE = /\binherits="([^"]+)"/g;
// <OnLoad ...>, <OnClick ...> etc. — the event name is the tag itself
const XML_SCRIPT_EVENT_RE = /<(On[A-Z][A-Za-z0-9]*)\b/g;
// function="GlobalHandler" on any script event tag
const XML_SCRIPT_FN_RE = /<On[A-Za-z]+\b[^>]*\bfunction="([^"]+)"/g;
// method="MixinMethod" on any script event tag
const XML_SCRIPT_METHOD_RE = /<On[A-Za-z]+\b[^>]*\bmethod="([^"]+)"/g;

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function* walkFiles(dir: string, ext: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, ext);
    } else if (entry.name.toLowerCase().endsWith(ext)) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Lua scanner
// ---------------------------------------------------------------------------

function scanLuaLines(
  lines: string[],
  addon: string,
  file: string,
  lua: Record<string, ApiEntry>,
  maxSites: number,
): void {
  function addSite(key: string, lineIdx: number): void {
    let entry = lua[key];
    if (!entry) {
      entry = { total: 0, sites: [] };
      lua[key] = entry;
    }
    entry.total++;
    if (entry.sites.length < maxSites) {
      const start = Math.max(0, lineIdx - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, lineIdx + CONTEXT_LINES);
      entry.sites.push({
        addon,
        file,
        line: lineIdx + 1,
        ctx: lines.slice(start, end + 1),
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*--/.test(line)) continue; // skip pure comment lines

    for (const m of line.matchAll(C_CALL_RE)) {
      addSite(`${m[1]}.${m[2]}`, i);
    }
    for (const m of line.matchAll(NS_CALL_RE)) {
      // Guard: NS_CALL_RE won't produce C_* keys (second char is alpha-only)
      // but re-check in case a name like "Ca_Foo" slips through
      if (!m[1].startsWith("C_")) addSite(`${m[1]}.${m[2]}`, i);
    }
    for (const m of line.matchAll(METHOD_CALL_RE)) {
      addSite(`:${m[1]}`, i);
    }
    for (const m of line.matchAll(GLOBAL_CALL_RE)) {
      addSite(m[1], i);
    }
  }
}

// ---------------------------------------------------------------------------
// XML scanner
// ---------------------------------------------------------------------------

function scanXmlContent(content: string, xml: XmlCorpus): void {
  for (const m of content.matchAll(XML_TAG_RE)) {
    xml.frameTypes[m[1]] = (xml.frameTypes[m[1]] ?? 0) + 1;
  }
  for (const m of content.matchAll(XML_INHERITS_RE)) {
    for (const raw of m[1].split(/\s*,\s*/)) {
      const name = raw.trim();
      if (name) xml.inherits[name] = (xml.inherits[name] ?? 0) + 1;
    }
  }
  for (const m of content.matchAll(XML_SCRIPT_EVENT_RE)) {
    xml.scriptEvents[m[1]] = (xml.scriptEvents[m[1]] ?? 0) + 1;
  }
  for (const m of content.matchAll(XML_SCRIPT_FN_RE)) {
    xml.scriptFunctions[m[1]] = (xml.scriptFunctions[m[1]] ?? 0) + 1;
  }
  for (const m of content.matchAll(XML_SCRIPT_METHOD_RE)) {
    xml.scriptMethods[m[1]] = (xml.scriptMethods[m[1]] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let maxSites = DEFAULT_MAX_SITES;
let outFile = DEFAULT_OUT;
let refDir = DEFAULT_REF_DIR;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--max-sites":
      maxSites = parseInt(args[++i], 10);
      break;
    case "--out":
      outFile = args[++i];
      break;
    case "--ref-dir":
      refDir = args[++i];
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sortByCount(obj: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(obj).sort(([, a], [, b]) => b - a));
}

async function run(): Promise<void> {
  if (!fs.existsSync(refDir)) {
    console.error(`Reference dir not found: ${refDir}`);
    process.exit(1);
  }

  // Build ordered addon list: priority first, then alphabetical
  const allAddons = fs
    .readdirSync(refDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const priority = PRIORITY_ADDONS.filter((a) => allAddons.includes(a));
  const rest = allAddons.filter((a) => !PRIORITY_ADDONS.includes(a));
  const ordered = [...priority, ...rest];

  const corpus: Corpus = {
    generatedAt: new Date().toISOString(),
    addonCount: ordered.length,
    fileCount: { lua: 0, xml: 0 },
    lua: {},
    xml: { frameTypes: {}, inherits: {}, scriptEvents: {}, scriptFunctions: {}, scriptMethods: {} },
  };

  console.log(`Scanning ${ordered.length} addons from ${refDir}`);
  console.log(`Max sites per key: ${maxSites}`);

  let addonsDone = 0;
  const tick = Math.max(1, Math.floor(ordered.length / 40));

  for (const addonName of ordered) {
    const addonDir = path.join(refDir, addonName);

    for (const luaPath of walkFiles(addonDir, ".lua")) {
      corpus.fileCount.lua++;
      const content = fs.readFileSync(luaPath, "utf-8");
      const lines = content.split("\n");
      const relFile = path.relative(addonDir, luaPath).replace(/\\/g, "/");
      scanLuaLines(lines, addonName, relFile, corpus.lua, maxSites);
    }

    for (const xmlPath of walkFiles(addonDir, ".xml")) {
      corpus.fileCount.xml++;
      const content = fs.readFileSync(xmlPath, "utf-8");
      scanXmlContent(content, corpus.xml);
    }

    addonsDone++;
    if (addonsDone % tick === 0) process.stdout.write(".");
  }
  console.log(" done");

  // Sort lua keys alphabetically
  const sortedLua: Record<string, ApiEntry> = {};
  for (const key of Object.keys(corpus.lua).sort()) {
    sortedLua[key] = corpus.lua[key];
  }
  corpus.lua = sortedLua;

  // Sort XML frequency maps by count descending
  corpus.xml.frameTypes = sortByCount(corpus.xml.frameTypes);
  corpus.xml.inherits = sortByCount(corpus.xml.inherits);
  corpus.xml.scriptEvents = sortByCount(corpus.xml.scriptEvents);
  corpus.xml.scriptFunctions = sortByCount(corpus.xml.scriptFunctions);
  corpus.xml.scriptMethods = sortByCount(corpus.xml.scriptMethods);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(corpus, null, 2), "utf-8");

  const luaKeys = Object.keys(corpus.lua).length;
  const sizeMb = (fs.statSync(outFile).size / 1_048_576).toFixed(1);

  console.log(`\nResults:`);
  console.log(`  Addons:           ${corpus.addonCount}`);
  console.log(`  Lua files:        ${corpus.fileCount.lua}`);
  console.log(`  XML files:        ${corpus.fileCount.xml}`);
  console.log(`  Lua API keys:     ${luaKeys}`);
  console.log(`  XML frame types:  ${Object.keys(corpus.xml.frameTypes).length}`);
  console.log(`  XML inherits:     ${Object.keys(corpus.xml.inherits).length}`);
  console.log(`  XML script events:${Object.keys(corpus.xml.scriptEvents).length}`);
  console.log(`  XML script fns:   ${Object.keys(corpus.xml.scriptFunctions).length}`);
  console.log(`  XML script meths: ${Object.keys(corpus.xml.scriptMethods).length}`);
  console.log(`  Output:           ${outFile} (${sizeMb} MB)`);
}

run().catch((err: unknown) => {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
