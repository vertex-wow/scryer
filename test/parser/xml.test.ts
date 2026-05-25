import * as fs from "fs";
import * as path from "path";
import { parseXmlFile } from "../../src/parser/xml";
import type { FrameIR, TextureIR } from "../../src/parser/ir";

const LIVE = path.join(__dirname, "../../_live/Addons");

function readFixture(rel: string): string {
  return fs.readFileSync(path.join(LIVE, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Button.xml — small, single virtual template
// ---------------------------------------------------------------------------

describe("parseXmlFile — AddonFactory/Templates/Button.xml", () => {
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

describe("parseXmlFile — ExampleControlButton__Vertex/ExampleControlButton.xml", () => {
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
});
