import {
  POINT_FRACTION,
  pointOnRect,
  resolveAnchorPoint,
  layoutByOneAnchor,
  layoutByTwoAnchors,
  layoutAll,
} from "../../src/webview/layout";
import type { Rect } from "../../src/webview/layout";
import type { Anchor, FrameIR } from "../../src/parser/ir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VP = { left: 0, top: 0, width: 1280, height: 720 };

function makeFrame(overrides: Partial<FrameIR> = {}): FrameIR {
  return {
    kind: "Frame",
    inherits: [],
    mixin: [],
    virtual: false,
    anchors: [],
    keyValues: [],
    layers: [],
    children: [],
    scripts: [],
    templateChain: [],
    sourceFile: "test",
    ...overrides,
  };
}

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return { point: "TOPLEFT", ...overrides };
}

// ---------------------------------------------------------------------------
// POINT_FRACTION — CSS fractions sanity check
// ---------------------------------------------------------------------------

describe("POINT_FRACTION", () => {
  test("TOPLEFT is (0,0)", () => expect(POINT_FRACTION.TOPLEFT).toEqual({ x: 0, y: 0 }));
  test("BOTTOMRIGHT is (1,1)", () => expect(POINT_FRACTION.BOTTOMRIGHT).toEqual({ x: 1, y: 1 }));
  test("CENTER is (0.5,0.5)", () => expect(POINT_FRACTION.CENTER).toEqual({ x: 0.5, y: 0.5 }));
  test("TOP is (0.5,0)", () => expect(POINT_FRACTION.TOP).toEqual({ x: 0.5, y: 0 }));
  test("BOTTOM is (0.5,1)", () => expect(POINT_FRACTION.BOTTOM).toEqual({ x: 0.5, y: 1 }));
  test("LEFT is (0,0.5)", () => expect(POINT_FRACTION.LEFT).toEqual({ x: 0, y: 0.5 }));
  test("RIGHT is (1,0.5)", () => expect(POINT_FRACTION.RIGHT).toEqual({ x: 1, y: 0.5 }));
  test("TOPLEFT and BOTTOMLEFT share x=0", () => {
    expect(POINT_FRACTION.TOPLEFT.x).toBe(0);
    expect(POINT_FRACTION.BOTTOMLEFT.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pointOnRect
// ---------------------------------------------------------------------------

describe("pointOnRect", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };

  test("TOPLEFT = top-left corner", () =>
    expect(pointOnRect("TOPLEFT", rect)).toEqual({ x: 100, y: 50 }));

  test("BOTTOMRIGHT = bottom-right corner", () =>
    expect(pointOnRect("BOTTOMRIGHT", rect)).toEqual({ x: 300, y: 150 }));

  test("CENTER = geometric center", () =>
    expect(pointOnRect("CENTER", rect)).toEqual({ x: 200, y: 100 }));

  test("TOP = top-center", () => expect(pointOnRect("TOP", rect)).toEqual({ x: 200, y: 50 }));

  test("BOTTOM = bottom-center", () =>
    expect(pointOnRect("BOTTOM", rect)).toEqual({ x: 200, y: 150 }));
});

// ---------------------------------------------------------------------------
// resolveAnchorPoint — WoW y-inversion
// ---------------------------------------------------------------------------

describe("resolveAnchorPoint", () => {
  test("TOPLEFT to TOPLEFT with no offset", () => {
    const a = makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT" });
    expect(resolveAnchorPoint(a, VP)).toEqual({ x: 0, y: 0 });
  });

  test("BOTTOMRIGHT to BOTTOMRIGHT with no offset lands at viewport bottom-right", () => {
    const a = makeAnchor({ point: "BOTTOMRIGHT", relativePoint: "BOTTOMRIGHT" });
    expect(resolveAnchorPoint(a, VP)).toEqual({ x: 1280, y: 720 });
  });

  test("positive xOffset shifts right", () => {
    const a = makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", x: 10 });
    expect(resolveAnchorPoint(a, VP)).toEqual({ x: 10, y: 0 });
  });

  test("positive yOffset shifts UP in WoW → DECREASES CSS y (moves toward top)", () => {
    const a = makeAnchor({ point: "CENTER", relativePoint: "CENTER", y: 50 });
    const result = resolveAnchorPoint(a, VP);
    expect(result.x).toBe(640);
    expect(result.y).toBe(360 - 50); // y decreases in CSS (moves up)
  });

  test("negative yOffset shifts DOWN in WoW → INCREASES CSS y", () => {
    const a = makeAnchor({ point: "CENTER", relativePoint: "CENTER", y: -50 });
    const result = resolveAnchorPoint(a, VP);
    expect(result.y).toBe(360 + 50);
  });

  test("relativePoint defaults to anchor.point when omitted", () => {
    const withRP = makeAnchor({ point: "CENTER", relativePoint: "CENTER" });
    const withoutRP = makeAnchor({ point: "CENTER" });
    expect(resolveAnchorPoint(withRP, VP)).toEqual(resolveAnchorPoint(withoutRP, VP));
  });
});

// ---------------------------------------------------------------------------
// layoutByOneAnchor
// ---------------------------------------------------------------------------

describe("layoutByOneAnchor", () => {
  test("TOPLEFT to viewport TOPLEFT → top-left corner", () => {
    const a = makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT" });
    const r = layoutByOneAnchor(a, VP, 200, 100);
    expect(r).toEqual({ left: 0, top: 0, width: 200, height: 100 });
  });

  test("CENTER to viewport CENTER → centered frame", () => {
    const a = makeAnchor({ point: "CENTER", relativePoint: "CENTER" });
    const r = layoutByOneAnchor(a, VP, 200, 100);
    expect(r).toEqual({ left: 540, top: 310, width: 200, height: 100 }); // 640-100, 360-50
  });

  test("BOTTOMRIGHT to viewport BOTTOMRIGHT → bottom-right flush", () => {
    const a = makeAnchor({ point: "BOTTOMRIGHT", relativePoint: "BOTTOMRIGHT" });
    const r = layoutByOneAnchor(a, VP, 200, 100);
    expect(r).toEqual({ left: 1080, top: 620, width: 200, height: 100 });
  });

  test("xOffset moves frame right", () => {
    const a = makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", x: 20 });
    const r = layoutByOneAnchor(a, VP, 100, 50);
    expect(r.left).toBe(20);
  });

  test("positive yOffset moves frame up (smaller CSS top)", () => {
    // Anchor frame's BOTTOMLEFT to viewport's BOTTOMLEFT with y=50 → frame rides 50px above bottom
    const a = makeAnchor({ point: "BOTTOMLEFT", relativePoint: "BOTTOMLEFT", y: 50 });
    const r = layoutByOneAnchor(a, VP, 200, 100);
    // anchorY = 720 - 50 = 670; selfFraction[BOTTOMLEFT].y = 1 → top = 670 - 1*100 = 570
    expect(r.top).toBe(570);
    expect(r.left).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// layoutByTwoAnchors — size derived from span
// ---------------------------------------------------------------------------

describe("layoutByTwoAnchors", () => {
  test("TOPLEFT+BOTTOMRIGHT to viewport → fills viewport", () => {
    const a1 = makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT" });
    const a2 = makeAnchor({ point: "BOTTOMRIGHT", relativePoint: "BOTTOMRIGHT" });
    const r = layoutByTwoAnchors(a1, VP, a2, VP);
    expect(r).toEqual({ left: 0, top: 0, width: 1280, height: 720 });
  });

  test("TOPLEFT+BOTTOMRIGHT with insets → inset rect", () => {
    const a1 = makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", x: 10, y: -10 });
    const a2 = makeAnchor({ point: "BOTTOMRIGHT", relativePoint: "BOTTOMRIGHT", x: -10, y: 10 });
    const r = layoutByTwoAnchors(a1, VP, a2, VP);
    // a1 anchor: (10, 0+10) = (10, 10); a2 anchor: (1270, 710)
    // width = (1270-10)/(1-0) = 1260; height = (710-10)/(1-0) = 700
    // left = 10-0*1260=10; top=10-0*700=10
    expect(r).toEqual({ left: 10, top: 10, width: 1260, height: 700 });
  });

  test("explicit size overrides span when anchors have same fraction", () => {
    // Two LEFT anchors with same x fraction (0) → x-span is 0; use explicit width
    const a1 = makeAnchor({ point: "LEFT", relativePoint: "LEFT" });
    const a2 = makeAnchor({ point: "LEFT", relativePoint: "LEFT" });
    const r = layoutByTwoAnchors(a1, VP, a2, VP, 200, 100);
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
  });

  test("anchor span overrides explicit size (WoW nine-slice stretch behaviour)", () => {
    // Middle texture between two 12px corner textures inside a 160px parent.
    // <Size x="56" y="6"/> is present but should be ignored for width — anchors win.
    const leftCorner: Rect = { left: 0, top: 0, width: 12, height: 6 };
    const rightCorner: Rect = { left: 148, top: 0, width: 12, height: 6 };
    const a1 = makeAnchor({ point: "TOPLEFT", relativePoint: "TOPRIGHT" });
    const a2 = makeAnchor({ point: "BOTTOMRIGHT", relativePoint: "BOTTOMLEFT" });
    const r = layoutByTwoAnchors(a1, leftCorner, a2, rightCorner, 56, 6);
    expect(r.left).toBe(12);
    expect(r.top).toBe(0);
    expect(r.width).toBe(136); // anchor-derived, not the explicit 56
    expect(r.height).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// layoutAll — integration: frame registry and multi-frame resolution
// ---------------------------------------------------------------------------

describe("layoutAll", () => {
  const vp = { w: 1280, h: 720 };

  test("frame filling viewport via setAllPoints", () => {
    const frame = makeFrame({ setAllPoints: true, name: "Root" });
    const map = layoutAll([frame], vp);
    expect(map.get(frame)).toEqual({ left: 0, top: 0, width: 1280, height: 720 });
  });

  test("single anchor to UIParent TOPLEFT + explicit size", () => {
    const frame = makeFrame({
      name: "F",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT" })],
      size: { x: 300, y: 200 },
    });
    const map = layoutAll([frame], vp);
    expect(map.get(frame)).toEqual({ left: 0, top: 0, width: 300, height: 200 });
  });

  test("named anchor target resolves after sibling is laid out", () => {
    // B anchors to A's BOTTOMRIGHT. A must be resolved first.
    const a = makeFrame({
      name: "A",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT" })],
      size: { x: 100, y: 50 },
    });
    const b = makeFrame({
      name: "B",
      anchors: [
        makeAnchor({
          point: "TOPLEFT",
          relativePoint: "BOTTOMRIGHT",
          relativeTo: "A",
        }),
      ],
      size: { x: 80, y: 40 },
    });
    const map = layoutAll([a, b], vp);
    const aRect = map.get(a)!;
    const bRect = map.get(b)!;
    expect(aRect).toEqual({ left: 0, top: 0, width: 100, height: 50 });
    // B's TOPLEFT is at A's BOTTOMRIGHT = (100, 50)
    expect(bRect).toEqual({ left: 100, top: 50, width: 80, height: 40 });
  });

  test("child frame with no relativeTo anchors to parent, not viewport", () => {
    const parent = makeFrame({
      name: "Parent",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", x: 200, y: -100 })],
      size: { x: 400, y: 300 },
    });
    const child = makeFrame({
      name: "Child",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT" })],
      size: { x: 50, y: 50 },
    });
    parent.children = [child];

    const map = layoutAll([parent], vp);
    // parent: left=200, top=100, w=400, h=300
    // child has no relativeTo → anchors to parent TOPLEFT (WoW default), not viewport
    const childRect = map.get(child)!;
    expect(childRect).toEqual({ left: 200, top: 100, width: 50, height: 50 });
  });

  test("child frame with explicit relativeTo=UIParent anchors to viewport", () => {
    const parent = makeFrame({
      name: "Parent",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", x: 200, y: -100 })],
      size: { x: 400, y: 300 },
    });
    const child = makeFrame({
      name: "Child",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", relativeTo: "UIParent" })],
      size: { x: 50, y: 50 },
    });
    parent.children = [child];

    const map = layoutAll([parent], vp);
    // child explicitly anchors to UIParent → positions against viewport
    const childRect = map.get(child)!;
    expect(childRect).toEqual({ left: 0, top: 0, width: 50, height: 50 });
  });

  test("child setAllPoints with no anchors fills parent", () => {
    const parent = makeFrame({
      name: "Parent",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", x: 100, y: -50 })],
      size: { x: 300, y: 200 },
    });
    const child = makeFrame({ name: "Child", setAllPoints: true });
    parent.children = [child];

    const map = layoutAll([parent], vp);
    expect(map.get(child)).toEqual({ left: 100, top: 50, width: 300, height: 200 });
  });

  // relativeKey: "$parent.Key" expands to parent's name + Key, matching sibling's $parentKey name
  test("relativeKey resolves sibling via $parent.Key", () => {
    // Mirrors:
    //   <Frame name="Panel"> ... size 400x300, at (100, 50)
    //     <Button name="$parentButtonA" parentKey="ButtonA"> ... size 80x30, at parent TOPLEFT
    //     <Button name="$parentButtonB" parentKey="ButtonB">
    //       <Anchor point="LEFT" relativeKey="$parent.ButtonA" relativePoint="RIGHT" x="5"/>
    //       size 60x30
    // After $parent expansion: Panel, PanelButtonA, PanelButtonB
    const panel = makeFrame({
      name: "Panel",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT", x: 100, y: -50 })],
      size: { x: 400, y: 300 },
    });
    const buttonA = makeFrame({
      name: "PanelButtonA",
      anchors: [makeAnchor({ point: "TOPLEFT", relativePoint: "TOPLEFT" })],
      size: { x: 80, y: 30 },
    });
    const buttonB = makeFrame({
      name: "PanelButtonB",
      anchors: [
        makeAnchor({ point: "LEFT", relativePoint: "RIGHT", relativeKey: "$parent.ButtonA", x: 5 }),
      ],
      size: { x: 60, y: 30 },
    });
    panel.children = [buttonA, buttonB];

    const map = layoutAll([panel], vp);
    // panel: left=100, top=50, w=400, h=300
    // buttonA: TOPLEFT→panel TOPLEFT → left=100, top=50, w=80, h=30
    // buttonB: LEFT→RIGHT of buttonA + x=5 → anchorX=100+80+5=185, anchorY=50+15=65
    //          selfFraction[LEFT]=(0,0.5) → left=185-0=185, top=65-0.5*30=50
    const aRect = map.get(buttonA)!;
    const bRect = map.get(buttonB)!;
    expect(aRect).toEqual({ left: 100, top: 50, width: 80, height: 30 });
    expect(bRect).toEqual({ left: 185, top: 50, width: 60, height: 30 });
  });

  test("relativeKey falls back to viewport for unresolvable key", () => {
    const parent = makeFrame({
      name: "Parent",
      anchors: [makeAnchor({ point: "TOPLEFT" })],
      size: { x: 200, y: 100 },
    });
    const child = makeFrame({
      name: "Child",
      anchors: [makeAnchor({ point: "TOPLEFT", relativeKey: "$parent.DoesNotExist" })],
      size: { x: 50, y: 50 },
    });
    parent.children = [child];

    const map = layoutAll([parent], vp);
    // unresolvable → falls back to viewport TOPLEFT
    expect(map.get(child)).toEqual({ left: 0, top: 0, width: 50, height: 50 });
  });

  test('relativeTo="$parent" anchors to parent rect', () => {
    const parent = makeFrame({
      name: "Parent",
      anchors: [makeAnchor({ point: "TOPLEFT", x: 200, y: -100 })],
      size: { x: 300, y: 200 },
    });
    const child = makeFrame({
      name: "Child",
      anchors: [makeAnchor({ point: "TOPLEFT", relativeTo: "$parent" })],
      size: { x: 50, y: 50 },
    });
    parent.children = [child];

    const map = layoutAll([parent], vp);
    // $parent → parent rect → child TOPLEFT at parent TOPLEFT (200, 100)
    expect(map.get(child)).toEqual({ left: 200, top: 100, width: 50, height: 50 });
  });
});
