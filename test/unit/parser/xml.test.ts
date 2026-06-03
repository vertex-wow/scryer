import * as fs from "fs";
import * as path from "path";
import { parseXmlFile } from "../../../src/parser/xml";
import type { FrameIR, TextureIR } from "../../../src/parser/ir";

const LIVE = path.join(__dirname, "../../../_live/Addons");
const describeIfLive = fs.existsSync(LIVE) ? describe : describe.skip;

function readFixture(rel: string): string {
  return fs.readFileSync(path.join(LIVE, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Button.xml — small, single virtual template
// ---------------------------------------------------------------------------

describeIfLive("parseXmlFile — AddonFactory/Templates/Button.xml", () => {
  let doc: ReturnType<typeof parseXmlFile>;

  beforeAll(() => {
    const content = readFixture("AddonFactory/Templates/Button.xml");
    doc = parseXmlFile("AddonFactory/Templates/Button.xml", content);
  });

  test("source is set", () => {
    expect(doc.source).toBe("AddonFactory/Templates/Button.xml");
  });

  test("registers one Script directive", () => {
    expect(doc.scriptFiles).toEqual(["Button.lua"]);
  });

  test("no concrete frames at top level", () => {
    expect(doc.frames).toHaveLength(0);
  });

  test("registers one template", () => {
    expect(doc.templates.size).toBe(1);
    expect(doc.templates.has("AddonFactory_ButtonTemplate")).toBe(true);
  });

  describe("AddonFactory_ButtonTemplate", () => {
    let tmpl: FrameIR;

    beforeAll(() => {
      tmpl = doc.templates.get("AddonFactory_ButtonTemplate")!;
    });

    test("is virtual Button", () => {
      expect(tmpl.virtual).toBe(true);
      expect(tmpl.kind).toBe("Button");
    });

    test("size 37×37", () => {
      expect(tmpl.size).toEqual({ x: 37, y: 37 });
    });

    test("has BORDER layer with one Texture (parentKey=Icon)", () => {
      expect(tmpl.layers).toHaveLength(1);
      expect(tmpl.layers[0].level).toBe("BORDER");
      expect(tmpl.layers[0].objects).toHaveLength(1);
      const icon = tmpl.layers[0].objects[0] as TextureIR;
      expect(icon.kind).toBe("Texture");
      expect(icon.parentKey).toBe("Icon");
      expect(icon.setAllPoints).toBe(true);
    });

    test("PushedTexture has file path (backslashes normalised)", () => {
      expect(tmpl.pushedTexture?.file).toBe("Interface/Buttons/UI-Quickslot-Depress");
    });

    test("HighlightTexture has alphaMode ADD", () => {
      expect(tmpl.highlightTexture?.alphaMode).toBe("ADD");
      expect(tmpl.highlightTexture?.file).toBe("Interface/Buttons/ButtonHilight-Square");
    });

    test("has one anonymous child Frame with OnLoad script", () => {
      expect(tmpl.children).toHaveLength(1);
      const child = tmpl.children[0];
      expect(child.kind).toBe("Frame");
      expect(child.name).toBeUndefined();
      expect(child.scripts).toHaveLength(1);
      expect(child.scripts[0].event).toBe("OnLoad");
      expect(child.scripts[0].inline).toBeDefined();
      expect(child.scripts[0].inline).toContain("LibMVC");
    });
  });
});

// ---------------------------------------------------------------------------
// ExampleControlButton.xml — comprehensive: virtuals, concrete, anchors, layers
// ---------------------------------------------------------------------------

describeIfLive("parseXmlFile — ExampleControlButton__Vertex/ExampleControlButton.xml", () => {
  let doc: ReturnType<typeof parseXmlFile>;

  beforeAll(() => {
    const content = readFixture("ExampleControlButton__Vertex/ExampleControlButton.xml");
    doc = parseXmlFile("ExampleControlButton__Vertex/ExampleControlButton.xml", content);
  });

  test("no script files (none at top level)", () => {
    expect(doc.scriptFiles).toHaveLength(0);
  });

  test("has 4 virtual templates", () => {
    expect(doc.templates.size).toBe(4);
    const expected = [
      "ExampleBigRedTemplate",
      "ExampleThreeSliceTemplate",
      "MainMenuFrameButtonFork2026Template",
      "ExampleControlButtonTabTemplate",
    ];
    for (const name of expected) {
      expect(doc.templates.has(name)).toBe(true);
    }
  });

  test("has 1 concrete top-level frame", () => {
    expect(doc.frames).toHaveLength(1);
    expect(doc.frames[0].name).toBe("ExampleControlButton");
  });

  describe("ExampleControlButton (concrete frame)", () => {
    let frame: FrameIR;

    beforeAll(() => {
      frame = doc.frames[0];
    });

    test("kind is Frame", () => expect(frame.kind).toBe("Frame"));
    test("not virtual", () => expect(frame.virtual).toBe(false));
    test("size 960×560", () => expect(frame.size).toEqual({ x: 960, y: 560 }));
    test("frameStrata MEDIUM", () => expect(frame.frameStrata).toBe("MEDIUM"));
    test("hidden, toplevel, movable, resizable, enableMouse", () => {
      expect(frame.hidden).toBe(true);
      expect(frame.toplevel).toBe(true);
      expect(frame.movable).toBe(true);
      expect(frame.resizable).toBe(true);
      expect(frame.enableMouse).toBe(true);
    });
    test("inherits DefaultPanelTemplate", () =>
      expect(frame.inherits).toContain("DefaultPanelTemplate"));
    test("mixin ExampleControlButtonFrameMixin", () =>
      expect(frame.mixin).toContain("ExampleControlButtonFrameMixin"));
    test("anchored at CENTER", () => {
      expect(frame.anchors).toHaveLength(1);
      expect(frame.anchors[0].point).toBe("CENTER");
    });
    test("has OnLoad, OnShow, OnDragStart, OnDragStop scripts", () => {
      const events = frame.scripts.map((s) => s.event);
      expect(events).toContain("OnLoad");
      expect(events).toContain("OnShow");
      expect(events).toContain("OnDragStart");
      expect(events).toContain("OnDragStop");
    });
    test("OnLoad is method-based", () => {
      const onLoad = frame.scripts.find((s) => s.event === "OnLoad")!;
      expect(onLoad.method).toBe("OnLoad");
    });
    test("OnDragStart is inline", () => {
      const drag = frame.scripts.find((s) => s.event === "OnDragStart")!;
      expect(drag.inline).toContain("StartMoving");
    });

    test("has child frames (tabs, panels, close button)", () => {
      expect(frame.children.length).toBeGreaterThan(4);
    });

    test("DialogTab child has $parentDialogTab name and KeyValue", () => {
      const tab = frame.children.find((c) => c.name === "$parentDialogTab");
      expect(tab).toBeDefined();
      expect(tab!.parentKey).toBe("DialogTab");
      expect(tab!.text).toBe("Dialog");
      expect(tab!.keyValues.find((kv) => kv.key === "frameName")?.value).toBe("DialogPanel");
    });

    test("ControlsTab has relativeKey anchor", () => {
      const tab = frame.children.find((c) => c.name === "$parentControlsTab");
      expect(tab).toBeDefined();
      expect(tab!.anchors[0].relativeKey).toBe("$parent.DialogTab");
      expect(tab!.anchors[0].point).toBe("LEFT");
      expect(tab!.anchors[0].relativePoint).toBe("RIGHT");
    });
  });

  describe("ExampleThreeSliceTemplate (virtual)", () => {
    let tmpl: FrameIR;

    beforeAll(() => {
      tmpl = doc.templates.get("ExampleThreeSliceTemplate")!;
    });

    test("is virtual Button inheriting ThreeSliceButtonTemplate", () => {
      expect(tmpl.virtual).toBe(true);
      expect(tmpl.kind).toBe("Button");
      expect(tmpl.inherits).toContain("ThreeSliceButtonTemplate");
    });

    test("size 100×20", () => expect(tmpl.size).toEqual({ x: 100, y: 20 }));

    test("has atlasName KeyValue", () => {
      const kv = tmpl.keyValues.find((k) => k.key === "atlasName");
      expect(kv).toBeDefined();
      expect(kv!.value).toBe("128-RedButton");
      expect(kv!.type).toBe("string");
    });

    test("has NormalFont / HighlightFont / DisabledFont", () => {
      expect(tmpl.normalFont).toBe("GameFontNormalSmall");
      expect(tmpl.highlightFont).toBe("GameFontHighlightSmall");
      expect(tmpl.disabledFont).toBe("GameFontDisableSmall");
    });
  });

  describe("ExampleControlButtonTabTemplate (virtual)", () => {
    let tmpl: FrameIR;

    beforeAll(() => {
      tmpl = doc.templates.get("ExampleControlButtonTabTemplate")!;
    });

    test("mixin ExampleControlButtonTabMixin", () =>
      expect(tmpl.mixin).toContain("ExampleControlButtonTabMixin"));

    test("has OnShow and OnClick method scripts", () => {
      const onShow = tmpl.scripts.find((s) => s.event === "OnShow")!;
      const onClick = tmpl.scripts.find((s) => s.event === "OnClick")!;
      expect(onShow.method).toBe("OnShow");
      expect(onClick.method).toBe("OnClick");
    });
  });
});

// ---------------------------------------------------------------------------
// Inline XML strings
// ---------------------------------------------------------------------------

describe("parseXmlFile — inline XML", () => {
  test("parses Include directives", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Include file="Shared\\Frames.xml"/>
  <Include file="Core\\Main.xml"/>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    expect(doc.includes).toEqual(["Shared/Frames.xml", "Core/Main.xml"]);
  });

  test("SetAllPoints on Anchor-less texture", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="TestFrame">
    <Layers>
      <Layer level="ARTWORK">
        <Texture parentKey="Bg" setAllPoints="true"/>
      </Layer>
    </Layers>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    expect(doc.frames[0].layers[0].objects[0].setAllPoints).toBe(true);
  });

  test("Color sub-element on Texture", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="TestFrame">
    <Layers>
      <Layer level="ARTWORK">
        <Texture parentKey="Fill">
          <Color r="0.5" g="0.2" b="1" a="0.8"/>
        </Texture>
      </Layer>
    </Layers>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    const tex = doc.frames[0].layers[0].objects[0] as TextureIR;
    expect(tex.color).toEqual({ r: 0.5, g: 0.2, b: 1, a: 0.8 });
  });

  test("multiple Anchors on a child frame", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="TestFrame">
    <Frames>
      <Frame parentKey="Panel">
        <Anchors>
          <Anchor point="TOPLEFT" x="14" y="-36"/>
          <Anchor point="BOTTOMRIGHT" x="-14" y="-10"/>
        </Anchors>
      </Frame>
    </Frames>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    const panel = doc.frames[0].children[0];
    expect(panel.anchors).toHaveLength(2);
    expect(panel.anchors[0]).toEqual({ point: "TOPLEFT", x: 14, y: -36 });
    expect(panel.anchors[1]).toEqual({ point: "BOTTOMRIGHT", x: -14, y: -10 });
  });

  test("throws on missing Ui root", () => {
    expect(() => parseXmlFile("bad.xml", "<Root/>")).toThrow(/<Ui>/);
  });

  // ── Attribute coverage ────────────────────────────────────────────────────

  test("atlas attribute on Texture", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="F">
    <Layers>
      <Layer level="BORDER">
        <Texture atlas="RedButton-Expand"/>
      </Layer>
    </Layers>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    const tex = doc.frames[0].layers[0].objects[0] as TextureIR;
    expect(tex.atlas).toBe("RedButton-Expand");
    expect(tex.file).toBeUndefined();
  });

  test("useAtlasSize on Texture", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="F">
    <Layers>
      <Layer level="ARTWORK">
        <Texture atlas="chatframe-button-up" useAtlasSize="true"/>
      </Layer>
    </Layers>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    const tex = doc.frames[0].layers[0].objects[0] as TextureIR;
    expect(tex.useAtlasSize).toBe(true);
    expect(tex.atlas).toBe("chatframe-button-up");
  });

  test("setAllPoints on child Frame element", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="Outer">
    <Frames>
      <Frame inherits="DialogBorderTemplate" setAllPoints="true"/>
    </Frames>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    const child = doc.frames[0].children[0];
    expect(child.setAllPoints).toBe(true);
    expect(child.inherits).toContain("DialogBorderTemplate");
  });

  test("useParentLevel on child Frame element", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="Outer">
    <Frames>
      <Frame inherits="DialogBorderTemplate" useParentLevel="true" setAllPoints="true"/>
    </Frames>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    const child = doc.frames[0].children[0];
    expect(child.useParentLevel).toBe(true);
  });

  test("toplevel attribute on concrete frame", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="Dialog" toplevel="true" frameStrata="DIALOG"/>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    expect(doc.frames[0].toplevel).toBe(true);
    expect(doc.frames[0].frameStrata).toBe("DIALOG");
  });

  test("empty script body does not crash and produces a script entry", () => {
    const xml = `
<Ui xmlns="http://www.blizzard.com/wow/ui/">
  <Frame name="F">
    <Scripts>
      <OnEnter></OnEnter>
      <OnLeave></OnLeave>
    </Scripts>
  </Frame>
</Ui>`;
    const doc = parseXmlFile("test.xml", xml);
    const events = doc.frames[0].scripts.map((s) => s.event);
    expect(events).toContain("OnEnter");
    expect(events).toContain("OnLeave");
    const onEnter = doc.frames[0].scripts.find((s) => s.event === "OnEnter")!;
    expect(onEnter.inline).toBeUndefined();
    expect(onEnter.method).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cookbook integration tests — inline XML from verified WoW addons we own.
// These test real-world patterns end-to-end without any filesystem dependency.
// ---------------------------------------------------------------------------

// XML content sourced from _reference/wow-cookbook (symlink → ../wow-cookbook).
// Simplified to remove the XML schema declaration for brevity.

const NS = `xmlns="http://www.blizzard.com/wow/ui/"`;

describe("parseXmlFile — ExampleFrameBare (cookbook)", () => {
  // Bare frame: two layers, anonymous texture with Color, named FontString
  const xml = `
<Ui ${NS}>
  <Frame name="ExampleFrameBare" parent="UIParent"
         enableMouse="true" frameStrata="MEDIUM" hidden="true">
    <Size x="240" y="160"/>
    <Anchors>
      <Anchor point="CENTER"/>
    </Anchors>
    <Layers>
      <Layer level="BACKGROUND">
        <Texture setAllPoints="true">
          <Color r="0" g="0" b="0" a="1"/>
        </Texture>
      </Layer>
      <Layer level="ARTWORK">
        <FontString name="$parentTitle" inherits="GameFontNormal"
                    text="Example Bare Frame">
          <Anchors>
            <Anchor point="TOP" relativePoint="TOP" y="-16"/>
          </Anchors>
        </FontString>
      </Layer>
    </Layers>
  </Frame>
</Ui>`;

  let doc: ReturnType<typeof parseXmlFile>;
  beforeAll(() => {
    doc = parseXmlFile("ExampleFrameBare.xml", xml);
  });

  test("one concrete frame, no templates", () => {
    expect(doc.frames).toHaveLength(1);
    expect(doc.templates.size).toBe(0);
  });

  test("frame attributes", () => {
    const f = doc.frames[0];
    expect(f.name).toBe("ExampleFrameBare");
    expect(f.parent).toBe("UIParent");
    expect(f.enableMouse).toBe(true);
    expect(f.frameStrata).toBe("MEDIUM");
    expect(f.hidden).toBe(true);
    expect(f.size).toEqual({ x: 240, y: 160 });
    expect(f.anchors[0].point).toBe("CENTER");
  });

  test("BACKGROUND layer: anonymous texture with solid black color", () => {
    const bg = doc.frames[0].layers.find((l) => l.level === "BACKGROUND")!;
    expect(bg).toBeDefined();
    const tex = bg.objects[0] as TextureIR;
    expect(tex.kind).toBe("Texture");
    expect(tex.setAllPoints).toBe(true);
    expect(tex.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(tex.name).toBeUndefined();
  });

  test("ARTWORK layer: named FontString with anchor offset", () => {
    const art = doc.frames[0].layers.find((l) => l.level === "ARTWORK")!;
    expect(art).toBeDefined();
    const fs = art.objects[0];
    expect(fs.kind).toBe("FontString");
    expect(fs.name).toBe("$parentTitle");
    expect(fs.anchors[0]).toMatchObject({ point: "TOP", relativePoint: "TOP", y: -16 });
  });
});

describe("parseXmlFile — ExampleFrameModalDialog (cookbook)", () => {
  // Modal dialog: toplevel, DIALOG strata, anonymous child Frame with
  // useParentLevel + setAllPoints (the border chrome pattern).
  const xml = `
<Ui ${NS}>
  <Frame name="ExampleFrameModalDialog" parent="UIParent"
         toplevel="true" enableMouse="true"
         frameStrata="DIALOG" hidden="true">
    <Size x="240" y="160"/>
    <Anchors>
      <Anchor point="CENTER"/>
    </Anchors>
    <Frames>
      <Frame inherits="DialogBorderTemplate" useParentLevel="true" setAllPoints="true"/>
    </Frames>
    <Layers>
      <Layer level="ARTWORK">
        <FontString name="$parentTitle" inherits="GameFontNormal"
                    text="Example Modal Dialog">
          <Anchors>
            <Anchor point="TOP" relativePoint="TOP" y="-24"/>
          </Anchors>
        </FontString>
      </Layer>
    </Layers>
  </Frame>
</Ui>`;

  let doc: ReturnType<typeof parseXmlFile>;
  beforeAll(() => {
    doc = parseXmlFile("ExampleFrameModalDialog.xml", xml);
  });

  test("toplevel and DIALOG strata", () => {
    const f = doc.frames[0];
    expect(f.toplevel).toBe(true);
    expect(f.frameStrata).toBe("DIALOG");
  });

  test("anonymous border-chrome child Frame: useParentLevel + setAllPoints", () => {
    const child = doc.frames[0].children[0];
    expect(child.inherits).toContain("DialogBorderTemplate");
    expect(child.useParentLevel).toBe(true);
    expect(child.setAllPoints).toBe(true);
    expect(child.name).toBeUndefined();
    expect(child.virtual).toBe(false);
  });
});

describe("parseXmlFile — ExampleControlMoveableFrame (cookbook)", () => {
  // Inline scripts combined with template inheritance and movable attribute.
  const xml = `
<Ui ${NS}>
  <Frame name="ExampleControlMoveableFrame" parent="UIParent"
         toplevel="true" enableMouse="true" movable="true"
         frameStrata="MEDIUM" hidden="true"
         inherits="DefaultPanelTemplate">
    <Size x="380" y="260"/>
    <Anchors>
      <Anchor point="CENTER"/>
    </Anchors>
    <Scripts>
      <OnDragStart>self:StartMoving()</OnDragStart>
      <OnDragStop>self:StopMovingOrSizing()</OnDragStop>
    </Scripts>
  </Frame>
</Ui>`;

  let doc: ReturnType<typeof parseXmlFile>;
  beforeAll(() => {
    doc = parseXmlFile("ExampleControlMoveableFrame.xml", xml);
  });

  test("frame is concrete, movable, inherits DefaultPanelTemplate", () => {
    const f = doc.frames[0];
    expect(f.virtual).toBe(false);
    expect(f.movable).toBe(true);
    expect(f.inherits).toContain("DefaultPanelTemplate");
  });

  test("inline drag scripts", () => {
    const f = doc.frames[0];
    const start = f.scripts.find((s) => s.event === "OnDragStart")!;
    const stop = f.scripts.find((s) => s.event === "OnDragStop")!;
    expect(start.inline).toContain("StartMoving");
    expect(stop.inline).toContain("StopMovingOrSizing");
  });
});

// describeIfCookbook — reads files from the _reference/wow-cookbook symlink.
// Skipped when the sibling repo is absent (e.g. fresh clone in CI without it).
const COOKBOOK = path.join(__dirname, "../../../_reference/wow-cookbook/docs/frames/Addons");
const describeIfCookbook = fs.existsSync(COOKBOOK) ? describe : describe.skip;

describeIfCookbook("parseXmlFile — ExampleControlBottomTabs (cookbook file)", () => {
  let doc: ReturnType<typeof parseXmlFile>;

  beforeAll(() => {
    const content = fs.readFileSync(
      path.join(COOKBOOK, "ExampleControlBottomTabs__Vertex/ExampleControlBottomTabs.xml"),
      "utf8",
    );
    doc = parseXmlFile("ExampleControlBottomTabs.xml", content);
  });

  test("one virtual template, one concrete frame", () => {
    expect(doc.templates.size).toBe(1);
    expect(doc.templates.has("ExampleControlBottomTabsTabTemplate")).toBe(true);
    expect(doc.frames).toHaveLength(1);
    expect(doc.frames[0].name).toBe("ExampleControlBottomTabs");
  });

  test("virtual tab template: mixin + method scripts", () => {
    const tmpl = doc.templates.get("ExampleControlBottomTabsTabTemplate")!;
    expect(tmpl.mixin).toContain("ExampleControlBottomTabsMixin");
    const events = tmpl.scripts.map((s) => s.event);
    expect(events).toContain("OnShow");
    expect(events).toContain("OnClick");
    expect(tmpl.scripts.find((s) => s.event === "OnShow")!.method).toBe("OnShow");
  });

  test("concrete frame: tabs use relativeKey chaining", () => {
    const f = doc.frames[0];
    const betaTab = f.children.find((c) => c.parentKey === "BetaTab");
    expect(betaTab).toBeDefined();
    expect(betaTab!.anchors[0].relativeKey).toBe("$parent.AlphaTab");
    expect(betaTab!.anchors[0].point).toBe("LEFT");
    expect(betaTab!.anchors[0].relativePoint).toBe("RIGHT");
  });

  test("panels have TOPLEFT+BOTTOMRIGHT fill anchors and are hidden", () => {
    const f = doc.frames[0];
    const alphaPanel = f.children.find((c) => c.parentKey === "AlphaPanel");
    expect(alphaPanel).toBeDefined();
    expect(alphaPanel!.hidden).toBe(true);
    const points = alphaPanel!.anchors.map((a) => a.point);
    expect(points).toContain("TOPLEFT");
    expect(points).toContain("BOTTOMRIGHT");
  });
});
