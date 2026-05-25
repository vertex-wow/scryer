import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clearResolutionMemo, normalizePath, resolveTexturePath } from "../../src/assets/resolver";

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("Interface\\Buttons\\UI-Quickslot")).toBe(
      "interface/buttons/ui-quickslot",
    );
  });

  it("lowercases the path", () => {
    expect(normalizePath("Interface/AddOns/MyAddon/Textures/Icon.blp")).toBe(
      "interface/addons/myaddon/textures/icon.blp",
    );
  });

  it("does not strip the interface prefix", () => {
    expect(normalizePath("Interface\\Foo")).toBe("interface/foo");
  });

  it("handles already-normalized paths", () => {
    expect(normalizePath("interface/foo/bar.blp")).toBe("interface/foo/bar.blp");
  });
});

describe("resolveTexturePath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scryer-test-"));
    clearResolutionMemo();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearResolutionMemo();
  });

  function touch(relPath: string): string {
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
    return abs;
  }

  it("returns null when nothing found", () => {
    const result = resolveTexturePath("Interface\\Buttons\\Missing", [tmpDir]);
    expect(result).toBeNull();
  });

  it("finds a BLP file with the interface/ prefix intact", () => {
    const abs = touch("interface/buttons/ui-quickslot.blp");
    const result = resolveTexturePath("Interface\\Buttons\\UI-Quickslot", [tmpDir]);
    expect(result).not.toBeNull();
    expect(result!.absPath).toBe(abs);
    expect(result!.kind).toBe("blp");
  });

  it("finds a PNG file when interface/ prefix is stripped by the extractor", () => {
    const abs = touch("buttons/ui-quickslot.png");
    const result = resolveTexturePath("Interface\\Buttons\\UI-Quickslot", [tmpDir]);
    expect(result).not.toBeNull();
    expect(result!.absPath).toBe(abs);
    expect(result!.kind).toBe("png");
  });

  it("finds a TGA file", () => {
    touch("interface/addons/myaddon/art/icon.tga");
    const result = resolveTexturePath("Interface\\AddOns\\MyAddon\\Art\\Icon.tga", [tmpDir]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tga");
  });

  it("prefers .blp over .tga when both present", () => {
    touch("interface/buttons/icon.blp");
    touch("interface/buttons/icon.tga");
    const result = resolveTexturePath("Interface\\Buttons\\Icon", [tmpDir]);
    expect(result!.kind).toBe("blp");
  });

  it("rejects paths with .. traversal", () => {
    const result = resolveTexturePath("../../../etc/passwd", [tmpDir]);
    expect(result).toBeNull();
  });

  it("searches addonDir for addon-local textures", () => {
    const addonDir = path.join(tmpDir, "addons", "myaddon");
    fs.mkdirSync(addonDir, { recursive: true });
    const abs = touch(path.join("addons", "myaddon", "textures", "icon.png").replace(/\\/g, "/"));
    const result = resolveTexturePath("textures\\icon.png", [], addonDir);
    expect(result).not.toBeNull();
    expect(result!.absPath).toBe(abs);
  });

  it("memoizes and returns same result on second call", () => {
    touch("interface/buttons/ui-quickslot.blp");
    const first = resolveTexturePath("Interface\\Buttons\\UI-Quickslot", [tmpDir]);
    const second = resolveTexturePath("Interface\\Buttons\\UI-Quickslot", [tmpDir]);
    expect(first).toBe(second); // same object reference from memo
  });

  it("returns null (memoized) for missing file on repeat call", () => {
    const first = resolveTexturePath("Interface\\Missing\\File", [tmpDir]);
    const second = resolveTexturePath("Interface\\Missing\\File", [tmpDir]);
    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
