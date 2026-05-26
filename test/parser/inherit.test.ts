import { parseXmlFile } from "../../src/parser/xml";
import { resolveInheritance } from "../../src/parser/inherit";
import type { FrameIR } from "../../src/parser/ir";

function singleDoc(xml: string) {
  const doc = parseXmlFile("test.xml", xml);
  return resolveInheritance([doc])[0];
}

const UI_NS = `xmlns="http://www.blizzard.com/wow/ui/"`;

// ---------------------------------------------------------------------------
// Single inheritance
// ---------------------------------------------------------------------------

describe("resolveInheritance — single inheritance", () => {
  const xml = `
<Ui ${UI_NS}>
  <Frame name="BaseTemplate" virtual="true">
    <Size x="100" y="50"/>
    <Scripts><OnLoad>base_load()</OnLoad></Scripts>
    <Layers>
      <Layer level="ARTWORK">
        <Texture parentKey="Bg" setAllPoints="true"/>
      </Layer>
    </Layers>
  </Frame>

  <Frame name="ConcreteFrame" inherits="BaseTemplate">
    <Anchors><Anchor point="CENTER"/></Anchors>
  </Frame>
</Ui>`;

  let frame: FrameIR;
  beforeAll(() => {
    const doc = singleDoc(xml);
    frame = doc.frames[0];
  });

  test("inherits size from template", () => {
    expect(frame.size).toEqual({ x: 100, y: 50 });
  });

  test("has template's layer", () => {
    expect(frame.layers).toHaveLength(1);
    expect(frame.layers[0].level).toBe("ARTWORK");
    expect(frame.layers[0].objects[0].parentKey).toBe("Bg");
  });

  test("inherits OnLoad script", () => {
    const onLoad = frame.scripts.find((s) => s.event === "OnLoad");
    expect(onLoad).toBeDefined();
    expect(onLoad!.inline).toContain("base_load");
  });

  test("keeps its own anchor", () => {
    expect(frame.anchors).toHaveLength(1);
    expect(frame.anchors[0].point).toBe("CENTER");
  });

  test("templateChain records base", () => {
    expect(frame.templateChain).toContain("BaseTemplate");
  });

  test("concrete name is preserved", () => {
    expect(frame.name).toBe("ConcreteFrame");
  });
});

// ---------------------------------------------------------------------------
// Scalar override
// ---------------------------------------------------------------------------

describe("resolveInheritance — concrete overrides template scalars", () => {
  const xml = `
<Ui ${UI_NS}>
  <Frame name="T" virtual="true">
    <Size x="200" y="100"/>
  </Frame>
  <Frame name="Concrete" inherits="T">
    <Size x="400" y="200"/>
  </Frame>
</Ui>`;

  test("concrete size overrides template size", () => {
    const doc = singleDoc(xml);
    expect(doc.frames[0].size).toEqual({ x: 400, y: 200 });
  });
});

// ---------------------------------------------------------------------------
// Script merging — append (default) and prepend
// ---------------------------------------------------------------------------

describe("resolveInheritance — script merging", () => {
  test("scripts append by default", () => {
    const xml = `
<Ui ${UI_NS}>
  <Frame name="T" virtual="true">
    <Scripts><OnLoad>base()</OnLoad></Scripts>
  </Frame>
  <Frame name="C" inherits="T">
    <Scripts><OnLoad>override()</OnLoad></Scripts>
  </Frame>
</Ui>`;
    const doc = singleDoc(xml);
    const scripts = doc.frames[0].scripts.filter((s) => s.event === "OnLoad");
    expect(scripts).toHaveLength(2);
    expect(scripts[0].inline).toContain("base");
    expect(scripts[1].inline).toContain("override");
  });

  test("inherit=none replaces base script", () => {
    const xml = `
<Ui ${UI_NS}>
  <Frame name="T" virtual="true">
    <Scripts><OnLoad>base()</OnLoad></Scripts>
  </Frame>
  <Frame name="C" inherits="T">
    <Scripts><OnLoad inherit="none">replacement()</OnLoad></Scripts>
  </Frame>
</Ui>`;
    const doc = singleDoc(xml);
    const scripts = doc.frames[0].scripts.filter((s) => s.event === "OnLoad");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].inline).toContain("replacement");
  });

  test("inherit=prepend runs override before base", () => {
    const xml = `
<Ui ${UI_NS}>
  <Frame name="T" virtual="true">
    <Scripts><OnLoad>base()</OnLoad></Scripts>
  </Frame>
  <Frame name="C" inherits="T">
    <Scripts><OnLoad inherit="prepend">early()</OnLoad></Scripts>
  </Frame>
</Ui>`;
    const doc = singleDoc(xml);
    const scripts = doc.frames[0].scripts.filter((s) => s.event === "OnLoad");
    expect(scripts).toHaveLength(2);
    expect(scripts[0].inline).toContain("early");
    expect(scripts[1].inline).toContain("base");
  });
});

// ---------------------------------------------------------------------------
// KeyValue merging — override by key
// ---------------------------------------------------------------------------

describe("resolveInheritance — KeyValue merging", () => {
  test("concrete KeyValue overrides same-key template value", () => {
    const xml = `
<Ui ${UI_NS}>
  <Frame name="T" virtual="true">
    <KeyValues>
      <KeyValue key="foo" value="from-template" type="string"/>
      <KeyValue key="bar" value="shared" type="string"/>
    </KeyValues>
  </Frame>
  <Frame name="C" inherits="T">
    <KeyValues>
      <KeyValue key="foo" value="from-concrete" type="string"/>
    </KeyValues>
  </Frame>
</Ui>`;
    const doc = singleDoc(xml);
    const kvs = doc.frames[0].keyValues;
    expect(kvs.find((k) => k.key === "foo")?.value).toBe("from-concrete");
    expect(kvs.find((k) => k.key === "bar")?.value).toBe("shared");
  });
});

// ---------------------------------------------------------------------------
// Multi-inheritance (comma-separated inherits)
// ---------------------------------------------------------------------------

describe("resolveInheritance — multi-inheritance", () => {
  const xml = `
<Ui ${UI_NS}>
  <Frame name="A" virtual="true">
    <Size x="100" y="50"/>
    <KeyValues>
      <KeyValue key="from" value="A" type="string"/>
    </KeyValues>
  </Frame>
  <Frame name="B" virtual="true">
    <Size x="200" y="60"/>
    <KeyValues>
      <KeyValue key="from" value="B" type="string"/>
      <KeyValue key="extra" value="B-only" type="string"/>
    </KeyValues>
  </Frame>
  <Frame name="C" inherits="A,B">
    <Anchors><Anchor point="CENTER"/></Anchors>
  </Frame>
</Ui>`;

  let frame: FrameIR;
  beforeAll(() => {
    const doc = singleDoc(xml);
    frame = doc.frames[0];
  });

  test("last template's scalar wins (B size)", () => {
    expect(frame.size).toEqual({ x: 200, y: 60 });
  });

  test("last template wins on key collision (from=B)", () => {
    expect(frame.keyValues.find((k) => k.key === "from")?.value).toBe("B");
  });

  test("unique key from B is present", () => {
    expect(frame.keyValues.find((k) => k.key === "extra")?.value).toBe("B-only");
  });

  test("concrete anchors are kept", () => {
    expect(frame.anchors[0].point).toBe("CENTER");
  });
});

// ---------------------------------------------------------------------------
// Unknown template — warning, no crash
// ---------------------------------------------------------------------------

describe("resolveInheritance — unknown template", () => {
  test("logs at console.log level when extraction is pending", () => {
    const xml = `<Ui ${UI_NS}><Frame name="C" inherits="NonExistentTemplate"/></Ui>`;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const warns = { count: 0 };
    resolveInheritance([parseXmlFile("test.xml", xml)], new Map(), warns, true);
    expect(warns.count).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("NonExistentTemplate"));
    logSpy.mockRestore();
  });

  test("logs at console.warn level after extraction has run", () => {
    const xml = `<Ui ${UI_NS}><Frame name="C" inherits="NonExistentTemplate"/></Ui>`;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const warns = { count: 0 };
    resolveInheritance([parseXmlFile("test.xml", xml)], new Map(), warns, false);
    expect(warns.count).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("NonExistentTemplate"));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Anonymous frames — no false cycle detection
// ---------------------------------------------------------------------------

describe("resolveInheritance — anonymous frames do not trigger cycle detection", () => {
  test("two anonymous frames inheriting the same template do not warn", () => {
    const xml = `
<Ui ${UI_NS}>
  <Frame name="T" virtual="true">
    <Size x="10" y="10"/>
    <Frames>
      <Frame/>
    </Frames>
  </Frame>
  <Frame name="Parent">
    <Frames>
      <Frame inherits="T"/>
      <Frame inherits="T"/>
    </Frames>
  </Frame>
</Ui>`;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    singleDoc(xml);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Circular"));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// $parent name expansion
// ---------------------------------------------------------------------------

describe("resolveInheritance — $parent expansion", () => {
  test("$parent in child name expands to parent frame name", () => {
    const xml = `
<Ui ${UI_NS}>
  <Frame name="MyFrame">
    <Frames>
      <Button name="$parentCloseButton"/>
    </Frames>
  </Frame>
</Ui>`;
    const doc = singleDoc(xml);
    const child = doc.frames[0].children[0];
    expect(child.name).toBe("MyFrameCloseButton");
  });

  test("$parent expands case-insensitively", () => {
    const xml = `
<Ui ${UI_NS}>
  <Frame name="Foo">
    <Frames>
      <Frame name="$PARENTBar"/>
    </Frames>
  </Frame>
</Ui>`;
    const doc = singleDoc(xml);
    expect(doc.frames[0].children[0].name).toBe("FooBar");
  });
});

// ---------------------------------------------------------------------------
// Cross-document template resolution
// ---------------------------------------------------------------------------

describe("resolveInheritance — cross-document", () => {
  test("concrete frame in doc2 inherits template from doc1", () => {
    const doc1 = parseXmlFile(
      "a.xml",
      `
<Ui ${UI_NS}>
  <Frame name="SharedTemplate" virtual="true">
    <Size x="80" y="40"/>
  </Frame>
</Ui>`,
    );

    const doc2 = parseXmlFile(
      "b.xml",
      `
<Ui ${UI_NS}>
  <Frame name="MyFrame" inherits="SharedTemplate"/>
</Ui>`,
    );

    const [, resolved2] = resolveInheritance([doc1, doc2]);
    expect(resolved2.frames[0].size).toEqual({ x: 80, y: 40 });
  });
});
