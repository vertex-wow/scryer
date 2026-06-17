import { resolveAddonGraph } from "../../../src/lua/addon-graph";
import { parseToc } from "../../../src/parser/toc";

// Helper: build a minimal TOC string with given required deps
function tocContent(requiredDeps: string[] = [], files: string[] = []): string {
  const lines = ["## Interface: 120000"];
  if (requiredDeps.length) lines.push(`## RequiredDeps: ${requiredDeps.join(", ")}`);
  lines.push(...files);
  return lines.join("\n") + "\n";
}

// In-memory FS for tests: map of absolute path → file content
function makeFakeFs(files: Record<string, string>) {
  const existsSync = (p: string) => Object.prototype.hasOwnProperty.call(files, p);
  const readFile = async (p: string) => {
    if (!existsSync(p)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  };
  return { existsSync, readFile };
}

const SEARCH = "/addons";

describe("resolveAddonGraph", () => {
  test("returns empty graph when main addon has no deps", async () => {
    const mainToc = parseToc(tocContent());
    const { existsSync, readFile } = makeFakeFs({});
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.loadOrder).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.cycles).toEqual([]);
  });

  test("resolves a single required dep", async () => {
    const mainToc = parseToc(tocContent(["LibStub"]));
    const { existsSync, readFile } = makeFakeFs({
      "/addons/LibStub/LibStub.toc": tocContent([], ["LibStub.lua"]),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.loadOrder.map((n) => n.name)).toEqual(["LibStub"]);
    expect(result.missing).toEqual([]);
  });

  test("prefers flavor-specific TOC over plain TOC", async () => {
    const mainToc = parseToc(tocContent(["LibStub"]));
    const { existsSync, readFile } = makeFakeFs({
      "/addons/LibStub/LibStub_Mainline.toc": tocContent([], ["LibStub.lua"]),
      "/addons/LibStub/LibStub.toc": tocContent([], ["Wrong.lua"]),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.loadOrder[0].tocPath).toBe("/addons/LibStub/LibStub_Mainline.toc");
  });

  test("records missing dep without crashing", async () => {
    const mainToc = parseToc(tocContent(["LibStub"]));
    const { existsSync, readFile } = makeFakeFs({});
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.missing).toEqual(["LibStub"]);
    expect(result.loadOrder).toEqual([]);
  });

  test("topologically sorts transitive deps (deepest first)", async () => {
    // MyAddon → Ace3 → LibStub
    const mainToc = parseToc(tocContent(["Ace3"]));
    const { existsSync, readFile } = makeFakeFs({
      "/addons/Ace3/Ace3.toc": tocContent(["LibStub"]),
      "/addons/LibStub/LibStub.toc": tocContent(),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.loadOrder.map((n) => n.name)).toEqual(["LibStub", "Ace3"]);
  });

  test("shared dep loaded only once (diamond)", async () => {
    // MyAddon → [A, B], A → LibStub, B → LibStub
    const mainToc = parseToc(tocContent(["A", "B"]));
    const { existsSync, readFile } = makeFakeFs({
      "/addons/A/A.toc": tocContent(["LibStub"]),
      "/addons/B/B.toc": tocContent(["LibStub"]),
      "/addons/LibStub/LibStub.toc": tocContent(),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    const names = result.loadOrder.map((n) => n.name);
    expect(names.filter((n) => n === "LibStub")).toHaveLength(1);
    expect(names.indexOf("LibStub")).toBeLessThan(names.indexOf("A"));
    expect(names.indexOf("LibStub")).toBeLessThan(names.indexOf("B"));
  });

  test("detects and breaks a direct cycle", async () => {
    // A → B → A (cycle)
    const mainToc = parseToc(tocContent(["A"]));
    const { existsSync, readFile } = makeFakeFs({
      "/addons/A/A.toc": tocContent(["B"]),
      "/addons/B/B.toc": tocContent(["A"]),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.cycles.length).toBeGreaterThan(0);
    // Still loads what it can without hanging
    const names = result.loadOrder.map((n) => n.name);
    expect(names).toContain("B");
    expect(names).toContain("A");
  });

  test("main addon name excluded from its own dep resolution", async () => {
    // If a dep somehow lists the main addon as its dep, it should be skipped.
    const mainToc = parseToc(tocContent(["LibStub"]));
    const { existsSync, readFile } = makeFakeFs({
      "/addons/LibStub/LibStub.toc": tocContent(["MyAddon"]),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    // MyAddon should NOT appear in loadOrder
    expect(result.loadOrder.map((n) => n.name)).not.toContain("MyAddon");
    expect(result.loadOrder.map((n) => n.name)).toContain("LibStub");
    expect(result.cycles).toHaveLength(0);
  });

  test("searches second path when dep not in first", async () => {
    const mainToc = parseToc(tocContent(["LibStub"]));
    const { existsSync, readFile } = makeFakeFs({
      "/live/LibStub/LibStub.toc": tocContent(),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH, "/live"],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.loadOrder.map((n) => n.name)).toEqual(["LibStub"]);
    expect(result.missing).toEqual([]);
  });

  test("addonDir is set to parent of tocPath", async () => {
    const mainToc = parseToc(tocContent(["LibStub"]));
    const { existsSync, readFile } = makeFakeFs({
      "/addons/LibStub/LibStub.toc": tocContent(),
    });
    const result = await resolveAddonGraph({
      mainToc,
      mainAddonName: "MyAddon",
      searchPaths: [SEARCH],
      tocFamily: "Mainline",
      readFile,
      existsSync,
    });
    expect(result.loadOrder[0].addonDir).toBe("/addons/LibStub");
  });
});
