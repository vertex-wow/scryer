/**
 * gen-api-stubs — extract Blizzard_APIDocumentationGenerated and emit TypeScript stubs
 *
 * Usage (after building dev scripts):
 *   pnpm run gen-api-stubs [retail|classic|classic_era] [options]
 *   node dist/gen-api-stubs.js [retail|classic|classic_era] [options]
 *
 * Options:
 *   --wow-dir <path>      WoW root directory (or installDir in dev/config.local.json)
 *   --casc-tool <path>    cascTool binary path (or cascToolPath in dev/config.local.json)
 *   --temp-dir <dir>      Temp extraction dir (default: os.tmpdir()/wow-api-stubs-<flavor>)
 *   --out-dir <dir>       Stub output root (default: src/lua/api-stubs)
 *   --listfile-dir <dir>  Listfile cache dir (default: .wow-assets)
 *   --skip-extract        Skip extraction, use files already in --temp-dir
 *
 * Generated stubs are Lua code strings (not TS functions) so that return values are
 * real Lua tables — wasmoon converts JS objects to userdata, which breaks pairs/ipairs.
 *
 * Retail run  → src/lua/api-stubs/retail/<NS>.ts + manifest.retail.ts + index.ts
 * Classic run → src/lua/api-stubs/classic/<NS>.ts (delta only) + manifest.classic.ts + index.ts
 * Era run     → src/lua/api-stubs/classic_era/<NS>.ts (delta only) + manifest.classic_era.ts + index.ts
 *
 * Stubs accumulate and are never deleted — the manifest tracks what each flavor exposes.
 * Files whose source hash is unchanged are not rewritten (preserves git cleanliness).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LuaFactory } from "wasmoon";
import { extractPaths, type ExtractCoreOptions, type Flavor } from "../src/assets/extract-core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocField {
  Name: string;
  Type: string;
  Nilable: boolean;
  IsArray?: boolean; // not used in retail docs, kept for future compat
  InnerType?: string; // present when Type="table" (typed array)
}

interface DocFunction {
  Name: string;
  Type?: string;
  Arguments?: DocField[];
  Returns?: DocField[];
  Documentation?: string[];
}

interface DocTable {
  Name: string;
  Type: string;
  Fields?: DocField[];
}

interface DocEvent {
  Name: string;
  LiteralName?: string;
  Type?: string;
}

interface DocModule {
  Name: string;
  Type?: string;
  Namespace?: string;
  Functions?: DocFunction[];
  Tables?: DocTable[];
  Events?: DocEvent[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, "..");
const WASM_PATH = path.join(PROJECT_ROOT, "node_modules/wasmoon/dist/glue.wasm");
const API_DOC_GLOB = "Interface/AddOns/Blizzard_APIDocumentationGenerated/**";
const API_DOC_SUBPATH = path.join("Interface", "AddOns", "Blizzard_APIDocumentationGenerated");

const FLAVOR_SUBDIR: Record<string, string> = {
  classic: "_classic_",
  classic_era: "_classic_era_",
};

// Lua sandbox for parsing APIDocumentation files.
// String.raw prevents JS from processing backslashes — Lua parser handles them.
const PARSE_SANDBOX = String.raw`
local function _jsonStr(s)
  return '"'..s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t')..'"'
end
local function _ser(v, d)
  d = d or 0
  if d > 12 then return '"..."' end
  local t = type(v)
  if t == "nil" then return "null"
  elseif t == "boolean" then return v and "true" or "false"
  elseif t == "number" then return tostring(v)
  elseif t == "string" then return _jsonStr(v)
  elseif t == "table" then
    if v[1] ~= nil then
      local p = {}; local i = 1
      while v[i] ~= nil do p[i] = _ser(v[i], d+1); i = i+1 end
      return "["..table.concat(p, ",").."]"
    else
      local p = {}
      for k, val in pairs(v) do
        if type(k) == "string" then p[#p+1] = _jsonStr(k)..":".._ser(val, d+1) end
      end
      return "{"..table.concat(p, ",").."}"
    end
  end
  return "null"
end
_SER = _ser

-- Collector for APIDocumentation:AddDocumentationTable (colon call, self is first arg)
_collected = {}
APIDocumentation = {
  AddDocumentationTable = function(self, t)
    _collected[#_collected+1] = t
  end,
}

-- Stub Constants.* for files that set validation constants
Constants = setmetatable({}, {
  __index = function(tbl, k)
    local sub = setmetatable({}, {
      __index = function() return 0 end,
      __newindex = function() end,
    })
    rawset(tbl, k, sub)
    return sub
  end,
  __newindex = function() end,
})

-- Stub Enum.* for files that reference enum values
Enum = setmetatable({}, {
  __index = function(t, k)
    local sub = setmetatable({}, { __index = function() return 0 end })
    rawset(t, k, sub)
    return sub
  end,
})

-- Global constants used by some documentation files
MAX_STABLE_SLOTS = 0
NUM_PET_SLOTS_THAT_NEED_LEARNED_SPELL = 0
EXTRA_PET_STABLE_SLOT = 0
`;

// ---------------------------------------------------------------------------
// Config + CLI
// ---------------------------------------------------------------------------

interface DevConfig {
  installDir?: string;
  cascToolPath?: string;
}

function loadDevConfig(): DevConfig {
  const p = path.join(PROJECT_ROOT, "dev", "config.local.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as DevConfig;
  } catch {
    return {};
  }
}

const args = process.argv.slice(2);
const FLAVORS = new Set<string>(["retail", "classic", "classic_era"]);

let flavor: Flavor = "retail";
let wowDirArg: string | undefined;
let cascToolArg: string | undefined;
let tempDirArg: string | undefined;
let outDir = path.join(PROJECT_ROOT, "src", "lua", "api-stubs");
let listfileDir = path.join(PROJECT_ROOT, ".wow-assets");
let skipExtract = false;

let i = 0;
if (args[0] && !args[0].startsWith("--")) {
  if (!FLAVORS.has(args[0])) {
    console.error(`Unknown flavor: ${args[0]}. Must be retail, classic, or classic_era.`);
    process.exit(1);
  }
  flavor = args[0] as Flavor;
  i = 1;
}

for (; i < args.length; i++) {
  switch (args[i]) {
    case "--wow-dir":
      wowDirArg = args[++i];
      break;
    case "--casc-tool":
      cascToolArg = args[++i];
      break;
    case "--temp-dir":
      tempDirArg = args[++i];
      break;
    case "--out-dir":
      outDir = args[++i];
      break;
    case "--listfile-dir":
      listfileDir = args[++i];
      break;
    case "--skip-extract":
      skipExtract = true;
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

const devConfig = loadDevConfig();
const wowDir = wowDirArg ?? devConfig.installDir;
const cascToolPath = cascToolArg ?? devConfig.cascToolPath;
const tempDir = tempDirArg ?? path.join(os.tmpdir(), `wow-api-stubs-${flavor}`);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Walk path components case-insensitively from base.
 * Needed because the plain listfile has lowercase paths, so rustydemon extracts
 * to e.g. interface/addons/... rather than Interface/AddOns/...
 */
async function findDirCaseInsensitive(base: string, subpath: string): Promise<string | null> {
  const parts = subpath.split(path.sep).filter(Boolean);

  async function resolve(current: string, remaining: string[]): Promise<string | null> {
    if (remaining.length === 0) return current;
    const [part, ...rest] = remaining;
    let entries: string[];
    try {
      entries = await fs.promises.readdir(current);
    } catch {
      return null;
    }
    const matches = entries.filter((e) => e.toLowerCase() === part.toLowerCase());
    if (matches.length === 0) return null;
    // Try each match; when at the final component prefer the non-empty directory.
    const candidates: string[] = [];
    for (const m of matches) {
      const resolved = await resolve(path.join(current, m), rest);
      if (resolved) candidates.push(resolved);
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    // Multiple candidates — pick the one with content.
    for (const c of candidates) {
      const sub = await fs.promises.readdir(c).catch(() => [] as string[]);
      if (sub.length > 0) return c;
    }
    return candidates[0];
  }

  return resolve(base, parts);
}

async function extractApiDocs(): Promise<string> {
  if (skipExtract) {
    const found = await findDirCaseInsensitive(tempDir, API_DOC_SUBPATH);
    if (!found) {
      console.error(`--skip-extract: directory not found under: ${tempDir}`);
      process.exit(1);
    }
    console.log(`Skipping extraction, using: ${found}`);
    return found;
  }

  if (!wowDir) {
    console.error(
      "Error: --wow-dir is required (or set installDir in dev/config.local.json).\n" +
        "  Copy dev/config.json.example to dev/config.local.json and fill in installDir.",
    );
    process.exit(1);
  }

  if (flavor === "retail") {
    const opts: ExtractCoreOptions = {
      flavor,
      outDir: tempDir,
      wowDir,
      cascToolPath,
      listfileDir,
      log: console.log,
    };
    console.log(`Extracting Blizzard_APIDocumentationGenerated (retail) → ${tempDir}`);
    await extractPaths([API_DOC_GLOB], opts);
  } else {
    const subdir = FLAVOR_SUBDIR[flavor];
    if (!subdir) {
      console.error(`No flavor subdir known for: ${flavor}`);
      process.exit(1);
    }
    const srcDir = path.join(
      wowDir,
      subdir,
      "Interface",
      "AddOns",
      "Blizzard_APIDocumentationGenerated",
    );
    if (!fs.existsSync(srcDir)) {
      console.error(`Blizzard_APIDocumentationGenerated not found: ${srcDir}`);
      process.exit(1);
    }
    const destDir = path.join(tempDir, API_DOC_SUBPATH);
    await fs.promises.mkdir(destDir, { recursive: true });
    console.log(`Copying Blizzard_APIDocumentationGenerated (${flavor}) → ${destDir}`);
    for (const entry of await fs.promises.readdir(srcDir)) {
      if (entry.toLowerCase().endsWith(".lua")) {
        await fs.promises.copyFile(path.join(srcDir, entry), path.join(destDir, entry));
      }
    }
  }

  // Locate the actual extracted dir regardless of path case (listfile may be lowercase)
  const found = await findDirCaseInsensitive(tempDir, API_DOC_SUBPATH);
  if (!found) {
    console.error(`Extraction appeared to succeed but directory not found under: ${tempDir}`);
    process.exit(1);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Lua parsing
// ---------------------------------------------------------------------------

async function parseLuaFiles(srcDir: string): Promise<Map<string, DocModule[]>> {
  const factory = new LuaFactory(WASM_PATH);
  const lua = await factory.createEngine({ openStandardLibs: true });
  await lua.doString(PARSE_SANDBOX);

  const entries = (await fs.promises.readdir(srcDir))
    .filter((f) => f.toLowerCase().endsWith(".lua"))
    .sort();

  const results = new Map<string, DocModule[]>();

  for (const entry of entries) {
    const luaPath = path.join(srcDir, entry);
    const src = await fs.promises.readFile(luaPath, "utf-8");

    await lua.doString("_collected = {}");

    try {
      await lua.doString(src);
    } catch (err) {
      console.warn(`  [warn] ${entry}: ${(err as Error).message ?? String(err)}`);
      continue;
    }

    await lua.doString("_RESULT = _SER(_collected)");
    const json = lua.global.get("_RESULT") as string | undefined;
    if (!json) continue;

    let modules: DocModule[];
    try {
      const raw = JSON.parse(json) as unknown;
      modules = Array.isArray(raw)
        ? (raw as DocModule[])
        : Object.values(raw as Record<string, DocModule>);
    } catch (err) {
      console.warn(`  [warn] ${entry}: JSON parse failed: ${(err as Error).message}`);
      continue;
    }

    if (modules.length > 0) {
      results.set(entry, modules);
    }
  }

  lua.global.close();
  return results;
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

// Empty Lua tables serialize as {} not [] — normalize to arrays everywhere.
function toArr<T>(val: T[] | Record<string, T> | undefined | null): T[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return Object.values(val);
}

function buildStructRegistry(allModules: DocModule[]): Set<string> {
  const structs = new Set<string>();
  for (const mod of allModules) {
    for (const tbl of toArr(mod.Tables)) {
      if (tbl.Type === "Structure" && tbl.Name) {
        structs.add(tbl.Name);
      }
    }
  }
  return structs;
}

// Returns the Lua helper identifier for a stub function.
// Priority: table/struct > non-nilable scalar (number/bool/string) > nil.
function stubRef(fn: DocFunction, structs: Set<string>): string {
  for (const ret of toArr(fn.Returns)) {
    if (ret.IsArray) return "_tbl"; // legacy compat
    if (ret.Type === "table") return "_tbl"; // typed or untyped array
    if (!ret.Nilable && structs.has(ret.Type)) return "_tbl"; // single struct
  }
  const first = toArr(fn.Returns)[0];
  if (first && !first.Nilable) {
    switch (first.Type) {
      case "number":
        return "_num";
      case "bool":
      case "boolean":
        return "_bool";
      case "string":
      case "cstring":
        return "_str";
    }
  }
  return "_nil";
}

function computeSigHash(fns: DocFunction[], structs: Set<string>): string {
  const parts = (fns ?? []).map((fn) => `${fn.Name}:${stubRef(fn, structs)}`).sort();
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function stubFileName(mod: DocModule): string {
  const ns = mod.Namespace?.trim();
  if (ns) return `${ns}.ts`;
  const name = (mod.Name ?? "Unknown").replace(/[^a-zA-Z0-9_]/g, "_");
  return `_${name}.ts`;
}

function stubExportName(mod: DocModule): string {
  const ns = mod.Namespace?.trim();
  if (ns) return ns;
  const name = (mod.Name ?? "Unknown").replace(/[^a-zA-Z0-9_]/g, "_");
  return `_${name}`;
}

/**
 * Generate a stub .ts file that exports a Lua code string.
 *
 * Stubs are Lua functions rather than TypeScript functions because wasmoon
 * converts JS objects to userdata — pairs/ipairs on userdata crashes the Lua VM.
 * Lua stub functions use helpers (_nil/_tbl/_num/_bool/_str) defined in the
 * registerStubs prelude, selected by stubRef() based on the first non-nilable return.
 */
function generateStubContent(
  mod: DocModule,
  structs: Set<string>,
  sourceFile: string,
  genHash: string,
  sigHash: string,
): string {
  const exportName = stubExportName(mod);
  const ns = mod.Namespace?.trim();
  const fns = toArr(mod.Functions);
  const events = toArr(mod.Events)
    .map((e) => e.LiteralName ?? e.Name)
    .filter(Boolean);

  const luaLines: string[] = [];

  if (ns) {
    // C_* or other namespaced APIs — guard in case namespace wasn't pre-created
    luaLines.push(`if ${ns} == nil then ${ns} = {} end`);
    for (const fn of fns) {
      luaLines.push(`${ns}.${fn.Name} = ${stubRef(fn, structs)}`);
    }
  } else {
    // Global functions — set directly
    for (const fn of fns) {
      luaLines.push(`${fn.Name} = ${stubRef(fn, structs)}`);
    }
  }

  if (events.length > 0) {
    luaLines.push(`-- Events: ${events.join(", ")}`);
  }

  const luaBody = luaLines.join("\n");

  return [
    "// AUTO-GENERATED by dev/gen-api-stubs.ts — DO NOT EDIT",
    `// @gen-hash: sha256:${genHash}`,
    `// @sig-hash: sha256:${sigHash}`,
    `// Source: Blizzard_APIDocumentationGenerated/${sourceFile}`,
    // Lua string: template literal so newlines are preserved verbatim
    `export const ${exportName} = \``,
    luaBody,
    "`;",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// File writing (hash-checked)
// ---------------------------------------------------------------------------

function readExistingHashes(filePath: string): { genHash: string | null; sigHash: string | null } {
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n", 5);
    let genHash: string | null = null;
    let sigHash: string | null = null;
    for (const line of lines) {
      const gm = line.match(/^\/\/ @gen-hash: sha256:([a-f0-9]+)$/);
      if (gm) genHash = gm[1];
      const sm = line.match(/^\/\/ @sig-hash: sha256:([a-f0-9]+)$/);
      if (sm) sigHash = sm[1];
    }
    return { genHash, sigHash };
  } catch {
    return { genHash: null, sigHash: null };
  }
}

async function writeIfChanged(filePath: string, content: string): Promise<"written" | "skipped"> {
  try {
    if (fs.readFileSync(filePath, "utf-8") === content) return "skipped";
  } catch {
    // file doesn't exist
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf-8");
  return "written";
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

function generateManifest(flavorKey: string, manifestData: Record<string, string[]>): string {
  const camel = flavorKey.replace(/_([a-z])/g, (_, c: string) => (c as string).toUpperCase());
  const varName = `${camel}Manifest`;
  const typeName = `${camel.charAt(0).toUpperCase()}${camel.slice(1)}Namespace`;

  const entries = Object.entries(manifestData)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ns, fns]) => `  ${ns}: [${fns.map((f) => `"${f}"`).join(", ")}],`);

  return [
    "// AUTO-GENERATED by dev/gen-api-stubs.ts — DO NOT EDIT",
    `export const ${varName} = {`,
    ...entries,
    "} as const;",
    `export type ${typeName} = keyof typeof ${varName};`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Index generation
// ---------------------------------------------------------------------------

function generateIndex(stubsRoot: string): string {
  function listStubNames(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => f.slice(0, -3))
      .sort();
  }

  const retail = listStubNames(path.join(stubsRoot, "retail"));
  const classic = listStubNames(path.join(stubsRoot, "classic"));
  const classicEra = listStubNames(path.join(stubsRoot, "classic_era"));

  const hasManifest = (flavor: string) =>
    fs.existsSync(path.join(stubsRoot, `manifest.${flavor}.ts`));

  const lines: string[] = [
    "// AUTO-GENERATED by dev/gen-api-stubs.ts — DO NOT EDIT",
    'import type { LuaEngine } from "wasmoon";',
    "",
  ];

  for (const ns of retail) lines.push(`import { ${ns} as _r${ns} } from "./retail/${ns}.js";`);
  for (const ns of classic) lines.push(`import { ${ns} as _c${ns} } from "./classic/${ns}.js";`);
  for (const ns of classicEra)
    lines.push(`import { ${ns} as _e${ns} } from "./classic_era/${ns}.js";`);

  lines.push("");

  // Build combined Lua strings per flavor
  lines.push("// Prelude defines _nil/_tbl/_num/_bool/_str helpers used by all stubs");
  lines.push(
    'const _pre = "local _nil = function() end\\n' +
      "local _tbl = function() return {} end\\n" +
      "local _num = function() return 0 end\\n" +
      "local _bool = function() return false end\\n" +
      "local _str = function() return '' end\\n\";",
  );
  lines.push("");

  if (retail.length > 0) {
    const parts = retail.map((ns) => `_r${ns}`).join(", ");
    lines.push(`const _retailLua = _pre + [${parts}].join("\\n");`);
  } else {
    lines.push("const _retailLua = _pre;");
  }

  if (classic.length > 0) {
    const parts = classic.map((ns) => `_c${ns}`).join(", ");
    lines.push(`const _classicLua = _pre + [${parts}].join("\\n");`);
  }

  if (classicEra.length > 0) {
    const parts = classicEra.map((ns) => `_e${ns}`).join(", ");
    lines.push(`const _classicEraLua = _pre + [${parts}].join("\\n");`);
  }

  lines.push("");
  lines.push("export async function registerStubs(");
  lines.push("  lua: LuaEngine,");
  lines.push("  flavor: 'retail' | 'classic' | 'classic_era',");
  lines.push("): Promise<void> {");
  lines.push("  if (flavor === 'retail') {");
  lines.push("    await lua.doString(_retailLua);");
  lines.push("  } else if (flavor === 'classic') {");
  if (classic.length > 0) {
    lines.push("    // retail stubs first, then classic delta overrides on top");
    lines.push("    await lua.doString(_retailLua);");
    lines.push("    await lua.doString(_classicLua);");
  } else {
    lines.push("    // no classic delta yet — retail stubs cover all");
    lines.push("    await lua.doString(_retailLua);");
  }
  lines.push("  } else if (flavor === 'classic_era') {");
  if (classicEra.length > 0) {
    lines.push("    await lua.doString(_retailLua);");
    lines.push("    await lua.doString(_classicEraLua);");
  } else {
    lines.push("    // no classic_era delta yet — retail stubs cover all");
    lines.push("    await lua.doString(_retailLua);");
  }
  lines.push("  }");
  lines.push("}");
  lines.push("");

  // Re-export manifests if they exist
  if (hasManifest("retail")) lines.push('export { retailManifest } from "./manifest.retail.js";');
  if (hasManifest("classic"))
    lines.push('export { classicManifest } from "./manifest.classic.js";');
  if (hasManifest("classic_era"))
    lines.push('export { classicEraManifest } from "./manifest.classic_era.js";');

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log(`gen-api-stubs: flavor=${flavor}`);

  const srcDir = await extractApiDocs();
  console.log(`Parsing .lua files from: ${srcDir}`);

  const fileModules = await parseLuaFiles(srcDir);
  console.log(`Parsed ${fileModules.size} .lua files`);

  const allModules: DocModule[] = [];
  for (const mods of fileModules.values()) allModules.push(...mods);

  const structs = buildStructRegistry(allModules);
  console.log(`Struct registry: ${structs.size} structures`);

  const flavorSubdir = flavor === "retail" ? "retail" : flavor;
  const flavorDir = path.join(outDir, flavorSubdir);
  const manifestData: Record<string, string[]> = {};

  let written = 0;
  let skipped = 0;

  for (const [luaFile, modules] of fileModules) {
    const luaBytes = await fs.promises.readFile(path.join(srcDir, luaFile));
    const genHash = crypto.createHash("sha256").update(luaBytes).digest("hex");

    for (const mod of modules) {
      const fns = toArr(mod.Functions).filter((f) => f.Name);
      const fileName = stubFileName(mod);
      const exportName = stubExportName(mod);
      const sigHash = computeSigHash(fns, structs);

      if (fns.length > 0) {
        manifestData[exportName] = fns.map((f) => f.Name);
      }

      // For non-retail runs: skip if retail/ already has an identical sig-hash
      if (flavor !== "retail") {
        const retailFile = path.join(outDir, "retail", fileName);
        const { sigHash: retailSigHash } = readExistingHashes(retailFile);
        if (retailSigHash === sigHash) continue;
      }

      const destFile = path.join(flavorDir, fileName);

      // Skip write if source hash unchanged
      const { genHash: existingGenHash } = readExistingHashes(destFile);
      if (existingGenHash === genHash) {
        skipped++;
        continue;
      }

      const content = generateStubContent(mod, structs, luaFile, genHash, sigHash);
      const result = await writeIfChanged(destFile, content);
      if (result === "written") {
        written++;
        console.log(`  → ${path.relative(PROJECT_ROOT, destFile)}`);
      } else {
        skipped++;
      }
    }
  }

  console.log(`Stubs: ${written} written, ${skipped} skipped`);

  // Write manifest
  await fs.promises.mkdir(outDir, { recursive: true });
  const manifestFlavor = flavor === "retail" ? "retail" : flavor;
  const manifestFile = path.join(outDir, `manifest.${manifestFlavor}.ts`);
  await fs.promises.writeFile(manifestFile, generateManifest(flavor, manifestData), "utf-8");
  console.log(`Manifest: ${path.relative(PROJECT_ROOT, manifestFile)}`);

  // Regenerate index.ts
  const indexContent = generateIndex(outDir);
  await fs.promises.writeFile(path.join(outDir, "index.ts"), indexContent, "utf-8");
  console.log(`Index: ${path.relative(PROJECT_ROOT, path.join(outDir, "index.ts"))}`);

  console.log("\nDone.");
}

run().catch((err: unknown) => {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
