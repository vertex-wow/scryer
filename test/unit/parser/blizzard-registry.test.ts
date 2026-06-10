import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  discoverBlizzardPaths,
  blizzardAddonLuaFiles,
  loadBlizzardRegistry,
  resolveCI,
} from "../../../src/parser/blizzard-registry";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scryer-registry-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): string {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

function addonsDir(): string {
  return path.join(tmpDir, "Interface", "AddOns");
}

// ---------------------------------------------------------------------------
// discoverBlizzardPaths
// ---------------------------------------------------------------------------

describe("discoverBlizzardPaths", () => {
  it("returns TOC path when no TOC file exists for an addon", () => {
    // Addon directory exists but has no TOC file.
    fs.mkdirSync(path.join(addonsDir(), "Blizzard_SharedXMLBase"), { recursive: true });

    const missing = discoverBlizzardPaths(tmpDir, addonsDir(), ["Blizzard_SharedXMLBase"]);
    expect(missing.length).toBeGreaterThan(0);
    // The missing entry should reference a .toc file.
    expect(missing.some((p) => /\.toc$/i.test(p))).toBe(true);
  });

  it("returns empty when the TOC exists and all XML includes are present", () => {
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/Blizzard_SharedXMLBase.toc",
      "## Interface: 110100\n",
    );
    const missing = discoverBlizzardPaths(tmpDir, addonsDir(), ["Blizzard_SharedXMLBase"]);
    expect(missing).toHaveLength(0);
  });

  it("reports XML files listed in the TOC that are absent on disk", () => {
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/Blizzard_SharedXMLBase.toc",
      "## Interface: 110100\nmissing.xml\n",
    );
    const missing = discoverBlizzardPaths(tmpDir, addonsDir(), ["Blizzard_SharedXMLBase"]);
    expect(missing.some((p) => /missing\.xml$/i.test(p))).toBe(true);
  });

  it("follows XML <Include> chains and reports transitively missing files", () => {
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/Blizzard_SharedXMLBase.toc",
      "## Interface: 110100\nroot.xml\n",
    );
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/root.xml",
      '<Ui xmlns="http://www.blizzard.com/wow/ui/"><Include file="child.xml"/></Ui>',
    );
    // child.xml is absent — should appear in missing list.
    const missing = discoverBlizzardPaths(tmpDir, addonsDir(), ["Blizzard_SharedXMLBase"]);
    expect(missing.some((p) => /child\.xml$/i.test(p))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// blizzardAddonLuaFiles — returns empty when TOC is absent (CDN-only scenario)
// ---------------------------------------------------------------------------

describe("blizzardAddonLuaFiles", () => {
  it("returns empty array when no TOC exists (CDN-only stub scenario)", () => {
    fs.mkdirSync(path.join(addonsDir(), "Blizzard_SharedXMLBase"), { recursive: true });
    const files = blizzardAddonLuaFiles(addonsDir(), "Blizzard_SharedXMLBase");
    expect(files).toHaveLength(0);
  });

  it("returns Lua files listed in TOC that exist on disk", () => {
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/Blizzard_SharedXMLBase.toc",
      "## Interface: 110100\nfoo.lua\nbar.lua\n",
    );
    writeFile("Interface/AddOns/Blizzard_SharedXMLBase/foo.lua", "-- foo");
    writeFile("Interface/AddOns/Blizzard_SharedXMLBase/bar.lua", "-- bar");
    const files = blizzardAddonLuaFiles(addonsDir(), "Blizzard_SharedXMLBase");
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".lua"))).toBe(true);
  });

  it("calls onMissing for each Lua file listed in TOC but absent on disk", () => {
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/Blizzard_SharedXMLBase.toc",
      "## Interface: 110100\nexists.lua\nmissing.lua\n",
    );
    writeFile("Interface/AddOns/Blizzard_SharedXMLBase/exists.lua", "-- exists");
    const missing: string[] = [];
    const files = blizzardAddonLuaFiles(addonsDir(), "Blizzard_SharedXMLBase", (rel) =>
      missing.push(rel),
    );
    expect(files).toHaveLength(1);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/missing\.lua/i);
  });
});

// ---------------------------------------------------------------------------
// loadBlizzardRegistry — returns empty map when no TOC (CDN-only scenario)
// ---------------------------------------------------------------------------

describe("loadBlizzardRegistry", () => {
  it("returns empty registry when addon directory has no TOC", () => {
    fs.mkdirSync(path.join(addonsDir(), "Blizzard_SharedXMLBase"), { recursive: true });
    const registryDir = path.join(tmpDir, "registry");
    const { frames, textures } = loadBlizzardRegistry(addonsDir(), registryDir, [
      "Blizzard_SharedXMLBase",
    ]);
    expect(frames.size).toBe(0);
    expect(textures.size).toBe(0);
  });

  it("loads virtual frame templates from XML files referenced by the TOC", () => {
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/Blizzard_SharedXMLBase.toc",
      "## Interface: 110100\ntemplates.xml\n",
    );
    writeFile(
      "Interface/AddOns/Blizzard_SharedXMLBase/templates.xml",
      `<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="MyTemplate" virtual="true"><Size x="10" y="10"/></Frame>
</Ui>`,
    );
    const registryDir = path.join(tmpDir, "registry");
    const { frames } = loadBlizzardRegistry(addonsDir(), registryDir, ["Blizzard_SharedXMLBase"]);
    expect(frames.has("MyTemplate")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveCI — case-insensitive path resolution
// ---------------------------------------------------------------------------

describe("resolveCI", () => {
  it("resolves an exact-case path", () => {
    writeFile("Interface/AddOns/Foo/bar.lua", "");
    const result = resolveCI(tmpDir, "Interface/AddOns/Foo/bar.lua");
    expect(fs.existsSync(result)).toBe(true);
  });

  it("resolves a mixed-case path to its on-disk equivalent", () => {
    writeFile("interface/addons/foo/bar.lua", "");
    const result = resolveCI(tmpDir, "Interface/AddOns/Foo/bar.lua");
    expect(fs.existsSync(result)).toBe(true);
  });

  it("returns best-effort path for missing components", () => {
    const result = resolveCI(tmpDir, "does/not/exist.lua");
    // Should not throw; returns a path even if it doesn't exist.
    expect(typeof result).toBe("string");
  });
});
