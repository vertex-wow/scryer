import { resolveAtlasNames } from "../../../src/assets/atlas-manifest";
import type { AtlasManifest } from "../../../src/assets/atlas-manifest";
import type { FrameIR, TextureIR } from "../../../src/parser/ir";

// ---------------------------------------------------------------------------
// Minimal constructors
// ---------------------------------------------------------------------------

function makeTex(atlas: string, overrides: Partial<TextureIR> = {}): TextureIR {
  return {
    kind: "Texture",
    inherits: [],
    mixin: [],
    virtual: false,
    anchors: [],
    keyValues: [],
    sourceFile: "test",
    atlas,
    ...overrides,
  } as TextureIR;
}

function makeFrame(objects: TextureIR[], children: FrameIR[] = []): FrameIR {
  return {
    kind: "Frame",
    inherits: [],
    mixin: [],
    virtual: false,
    anchors: [],
    keyValues: [],
    sourceFile: "test",
    layers: [{ level: "BACKGROUND" as const, subLevel: 0, objects }],
    children,
    scripts: [],
    templateChain: [],
  } as unknown as FrameIR;
}

const BASE = {
  file: "Interface/Buttons/Atlas.blp",
  x: 4,
  y: 8,
  width: 32,
  height: 16,
  sheetW: 256,
  sheetH: 128,
  tilesH: false,
  tilesV: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveAtlasNames — lookup strategies", () => {
  it("exact match sets resolvedAtlas with all fields", () => {
    const manifest: AtlasManifest = { "my-atlas": BASE };
    const tex = makeTex("my-atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas).toEqual({
      file: BASE.file,
      x: 4,
      y: 8,
      width: 32,
      height: 16,
      sheetW: 256,
      sheetH: 128,
      tilesH: false,
      tilesV: false,
    });
  });

  it("case-insensitive fallback finds lowercase-keyed entry", () => {
    const manifest: AtlasManifest = { "my-atlas": BASE };
    const tex = makeTex("My-Atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas?.width).toBe(32);
  });

  it("strips leading underscores to find entry", () => {
    const manifest: AtlasManifest = { "my-atlas": BASE };
    const tex = makeTex("_my-atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas).toBeDefined();
  });

  it("strips multiple leading non-alpha chars", () => {
    const manifest: AtlasManifest = { "my-atlas": BASE };
    const tex = makeTex("__my-atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas).toBeDefined();
  });

  it("strips leading chars and does case-insensitive match", () => {
    const manifest: AtlasManifest = { "my-atlas": BASE };
    const tex = makeTex("_My-Atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas).toBeDefined();
  });
});

describe("resolveAtlasNames — 2x scale divisor", () => {
  const entry2x = {
    file: "Interface/Buttons/Atlas.blp",
    x: 8,
    y: 16,
    width: 64,
    height: 32,
    sheetW: 512,
    sheetH: 256,
    tilesH: false,
    tilesV: false,
  };

  it("halves all pixel dimensions when -2x suffix entry is used", () => {
    const manifest: AtlasManifest = { "my-atlas-2x": entry2x };
    const tex = makeTex("my-atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas).toEqual({
      file: entry2x.file,
      x: 4,
      y: 8,
      width: 32,
      height: 16,
      sheetW: 256,
      sheetH: 128,
      tilesH: false,
      tilesV: false,
    });
  });

  it("prefers exact match over 2x variant", () => {
    const manifest: AtlasManifest = {
      "my-atlas": BASE,
      "my-atlas-2x": entry2x,
    };
    const tex = makeTex("my-atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    // Exact match → no halving; width stays 32 (BASE), not 32 from halving 64
    expect(tex.resolvedAtlas?.x).toBe(4); // BASE.x, not entry2x.x/2
    expect(tex.resolvedAtlas?.sheetW).toBe(256); // BASE.sheetW, not entry2x.sheetW/2
  });
});

describe("resolveAtlasNames — unknown names", () => {
  it("leaves resolvedAtlas undefined when name not in manifest", () => {
    const manifest: AtlasManifest = { "other-atlas": BASE };
    const tex = makeTex("unknown-atlas");
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas).toBeUndefined();
  });

  it("is a no-op when atlas field is absent", () => {
    const manifest: AtlasManifest = { "my-atlas": BASE };
    const tex = makeTex("") as TextureIR;
    delete (tex as unknown as Record<string, unknown>).atlas;
    resolveAtlasNames([makeFrame([tex])], manifest);
    expect(tex.resolvedAtlas).toBeUndefined();
  });
});

describe("resolveAtlasNames — traversal", () => {
  it("resolves textures in nested child frames", () => {
    const manifest: AtlasManifest = { "child-atlas": BASE };
    const tex = makeTex("child-atlas");
    const child = makeFrame([tex]);
    const parent = makeFrame([], [child]);
    resolveAtlasNames([parent], manifest);
    expect(tex.resolvedAtlas).toBeDefined();
  });

  it("resolves textures in multiple layers of the same frame", () => {
    const manifest: AtlasManifest = { "my-atlas": BASE };
    const tex1 = makeTex("my-atlas");
    const tex2 = makeTex("my-atlas");
    const f: FrameIR = {
      ...makeFrame([]),
      layers: [
        { level: "BACKGROUND" as const, subLevel: 0, objects: [tex1] },
        { level: "ARTWORK" as const, subLevel: 0, objects: [tex2] },
      ],
    };
    resolveAtlasNames([f], manifest);
    expect(tex1.resolvedAtlas).toBeDefined();
    expect(tex2.resolvedAtlas).toBeDefined();
  });

  it("resolves button state textures (normalTexture etc.)", () => {
    const manifest: AtlasManifest = { "btn-atlas": BASE };
    const normalTex = makeTex("btn-atlas");
    const f: FrameIR = { ...makeFrame([]), normalTexture: normalTex };
    resolveAtlasNames([f], manifest);
    expect(normalTex.resolvedAtlas).toBeDefined();
  });
});
