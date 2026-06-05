import { FrameRegistry } from "../../../src/lua/frame-registry";

describe("FrameRegistry", () => {
  function make(w = 1024, h = 768) {
    return new FrameRegistry(w, h);
  }

  test("UIParent and WorldFrame are pre-created", () => {
    const reg = make();
    const ui = reg.getFrame(reg.uiParentId);
    const wf = reg.getFrame(reg.worldFrameId);
    expect(ui?.name).toBe("UIParent");
    expect(ui?.width).toBe(1024);
    expect(ui?.height).toBe(768);
    expect(wf?.name).toBe("WorldFrame");
  });

  test("bootstrap does not mark dirty", () => {
    const reg = make();
    expect(reg.isDirty()).toBe(false);
  });

  test("createFrame adds child to parent", () => {
    const reg = make();
    const node = reg.createFrame("Frame", "TestFrame");
    expect(node.name).toBe("TestFrame");
    expect(node.parentId).toBe(reg.uiParentId);
    const uiParent = reg.getFrame(reg.uiParentId)!;
    expect(uiParent.childIds).toContain(node.id);
    expect(reg.isDirty()).toBe(true);
  });

  test("createFrame defaults parent to UIParent when null", () => {
    const reg = make();
    const node = reg.createFrame("Button", null, null);
    expect(node.parentId).toBe(reg.uiParentId);
  });

  test("createFrame with explicit parent", () => {
    const reg = make();
    const parent = reg.createFrame("Frame", "Parent");
    reg.clearDirty();
    const child = reg.createFrame("Frame", "Child", parent.id);
    expect(child.parentId).toBe(parent.id);
    expect(parent.childIds).toContain(child.id);
  });

  test("getFrameByName finds frame", () => {
    const reg = make();
    reg.createFrame("Frame", "MyFrame");
    expect(reg.getFrameByName("MyFrame")?.name).toBe("MyFrame");
    expect(reg.getFrameByName("UIParent")?.id).toBe(reg.uiParentId);
  });

  test("createTexture adds to owner's textures", () => {
    const reg = make();
    const frame = reg.createFrame("Frame", "F");
    const tex = reg.createTexture(frame.id, "Tex1", "ARTWORK", 0);
    expect(tex).toBeDefined();
    expect(tex?.id).toBeGreaterThan(frame.id);
    expect(frame.textures).toHaveLength(1);
    expect(reg.getTexture(tex!.id)).toBe(tex);
  });

  test("createFontString adds to owner's fontStrings", () => {
    const reg = make();
    const frame = reg.createFrame("Frame", "F");
    const fs = reg.createFontString(frame.id, "FS1", "OVERLAY");
    expect(fs).toBeDefined();
    expect(frame.fontStrings).toHaveLength(1);
    expect(reg.getFontString(fs!.id)).toBe(fs);
  });

  test("reparent moves frame between parents", () => {
    const reg = make();
    const a = reg.createFrame("Frame", "A");
    const b = reg.createFrame("Frame", "B");
    reg.reparent(b.id, a.id);
    expect(b.parentId).toBe(a.id);
    expect(a.childIds).toContain(b.id);
    const uiParent = reg.getFrame(reg.uiParentId)!;
    expect(uiParent.childIds).not.toContain(b.id);
  });

  test("dirty flag clears correctly", () => {
    const reg = make();
    reg.createFrame("Frame");
    expect(reg.isDirty()).toBe(true);
    reg.clearDirty();
    expect(reg.isDirty()).toBe(false);
  });

  test("serialize returns UIParent children as roots", () => {
    const reg = make();
    reg.createFrame("Frame", "Root1");
    reg.createFrame("Frame", "Root2");
    const irs = reg.serialize();
    // WorldFrame + Root1 + Root2 = 3 children of UIParent
    expect(irs).toHaveLength(3);
    const names = irs.map((ir) => ir.name);
    expect(names).toContain("Root1");
    expect(names).toContain("Root2");
    expect(names).toContain("WorldFrame");
  });

  test("serialize nests children recursively", () => {
    const reg = make();
    const parent = reg.createFrame("Frame", "Parent");
    reg.createFrame("Frame", "Child", parent.id);
    const irs = reg.serialize();
    const parentIR = irs.find((ir) => ir.name === "Parent");
    expect(parentIR).toBeDefined();
    expect(parentIR!.children).toHaveLength(1);
    expect(parentIR!.children[0].name).toBe("Child");
  });

  test("serialize includes texture in layer", () => {
    const reg = make();
    const frame = reg.createFrame("Frame", "F");
    const tex = reg.createTexture(frame.id, undefined, "ARTWORK", 0);
    tex!.file = "Interface/Test.blp";

    const irs = reg.serialize();
    const fir = irs.find((ir) => ir.name === "F")!;
    const artworkLayer = fir.layers.find((l) => l.level === "ARTWORK");
    expect(artworkLayer).toBeDefined();
    expect(artworkLayer!.objects[0]).toMatchObject({ kind: "Texture", file: "Interface/Test.blp" });
  });

  test("serialize omits hidden textures", () => {
    const reg = make();
    const frame = reg.createFrame("Frame", "F");
    const tex = reg.createTexture(frame.id, undefined, "ARTWORK", 0);
    tex!.file = "Interface/Test.blp";
    tex!.shown = false;

    const irs = reg.serialize();
    const fir = irs.find((ir) => ir.name === "F")!;
    expect(fir.layers).toHaveLength(0);
  });

  test("resolveRelTo returns name for ID", () => {
    const reg = make();
    const frame = reg.createFrame("Frame", "Named");
    expect(reg.resolveRelTo(frame.id)).toBe("Named");
  });

  test("resolveRelTo returns string as-is", () => {
    const reg = make();
    expect(reg.resolveRelTo("SomeFrame")).toBe("SomeFrame");
  });

  test("resolveRelTo returns undefined for unnamed frame ID", () => {
    const reg = make();
    const frame = reg.createFrame("Frame");
    expect(reg.resolveRelTo(frame.id)).toBeUndefined();
  });
});
