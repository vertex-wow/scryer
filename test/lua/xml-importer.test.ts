import * as path from "path";
import { createSandbox } from "../../src/lua/sandbox";
import { registerWowApi, VirtualClock } from "../../src/lua/wow-api";
import { registerFrameModel } from "../../src/lua/createframe";
import { FrameRegistry } from "../../src/lua/frame-registry";
import { importXmlFile, type ImportContext } from "../../src/lua/xml-importer";
import type { LuaEngine } from "wasmoon";

const WASM_PATH = path.join(__dirname, "../../node_modules/wasmoon/dist/glue.wasm");

async function setup(): Promise<{ lua: LuaEngine; registry: FrameRegistry }> {
  const registry = new FrameRegistry(1024, 768);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(lua, registry);
  return { lua, registry };
}

function makeCtx(): ImportContext {
  return {
    addonTemplates: new Map(),
    blizzardTemplates: undefined,
    output: { warn: () => {}, error: () => {} },
  };
}

async function importXml(
  lua: LuaEngine,
  xml: string,
  ctx: ImportContext = makeCtx(),
): Promise<void> {
  await importXmlFile(xml, "test.xml", lua, ctx);
}

describe("parentKey / parentArray wiring", () => {
  test("texture parentKey wires child onto parent table", async () => {
    const { lua } = await setup();
    try {
      await importXml(
        lua,
        `<Ui xmlns="http://www.blizzard.com/wow/ui/">
          <Frame name="TestFrame">
            <Layers>
              <Layer level="ARTWORK">
                <Texture parentKey="Icon"/>
              </Layer>
            </Layers>
          </Frame>
        </Ui>`,
      );
      const iconType = await lua.doString("return type(TestFrame.Icon)");
      expect(iconType).toBe("table");
    } finally {
      lua.global.close();
    }
  });

  test("fontstring parentKey wires child onto parent table", async () => {
    const { lua } = await setup();
    try {
      await importXml(
        lua,
        `<Ui xmlns="http://www.blizzard.com/wow/ui/">
          <Frame name="TestFrame">
            <Layers>
              <Layer level="OVERLAY">
                <FontString parentKey="Label"/>
              </Layer>
            </Layers>
          </Frame>
        </Ui>`,
      );
      const labelType = await lua.doString("return type(TestFrame.Label)");
      expect(labelType).toBe("table");
    } finally {
      lua.global.close();
    }
  });

  test("child frame parentKey wires child onto parent table", async () => {
    const { lua } = await setup();
    try {
      await importXml(
        lua,
        `<Ui xmlns="http://www.blizzard.com/wow/ui/">
          <Frame name="TestFrame">
            <Frames>
              <Frame parentKey="InnerFrame"/>
            </Frames>
          </Frame>
        </Ui>`,
      );
      const innerType = await lua.doString("return type(TestFrame.InnerFrame)");
      expect(innerType).toBe("table");
    } finally {
      lua.global.close();
    }
  });

  test("texture parentArray appends child into parent table array", async () => {
    const { lua } = await setup();
    try {
      await importXml(
        lua,
        `<Ui xmlns="http://www.blizzard.com/wow/ui/">
          <Frame name="TestFrame">
            <Layers>
              <Layer level="ARTWORK">
                <Texture parentArray="Icons"/>
                <Texture parentArray="Icons"/>
              </Layer>
            </Layers>
          </Frame>
        </Ui>`,
      );
      const count = await lua.doString("return #TestFrame.Icons");
      expect(count).toBe(2);
    } finally {
      lua.global.close();
    }
  });

  test("child frame parentArray appends child into parent table array", async () => {
    const { lua } = await setup();
    try {
      await importXml(
        lua,
        `<Ui xmlns="http://www.blizzard.com/wow/ui/">
          <Frame name="TestFrame">
            <Frames>
              <Frame parentArray="Slots"/>
              <Frame parentArray="Slots"/>
              <Frame parentArray="Slots"/>
            </Frames>
          </Frame>
        </Ui>`,
      );
      const count = await lua.doString("return #TestFrame.Slots");
      expect(count).toBe(3);
    } finally {
      lua.global.close();
    }
  });

  test("parentKey child is the same object as accessed via child iteration", async () => {
    const { lua } = await setup();
    try {
      await importXml(
        lua,
        `<Ui xmlns="http://www.blizzard.com/wow/ui/">
          <Frame name="TestFrame">
            <Layers>
              <Layer level="ARTWORK">
                <Texture name="TestFrame_Icon" parentKey="Icon"/>
              </Layer>
            </Layers>
          </Frame>
        </Ui>`,
      );
      const same = await lua.doString("return TestFrame.Icon == TestFrame_Icon");
      expect(same).toBe(true);
    } finally {
      lua.global.close();
    }
  });

  test("parentKey accessible in parent OnLoad", async () => {
    const { lua } = await setup();
    try {
      await importXml(
        lua,
        `<Ui xmlns="http://www.blizzard.com/wow/ui/">
          <Frame name="TestFrame">
            <Layers>
              <Layer level="ARTWORK">
                <Texture parentKey="Icon"/>
              </Layer>
            </Layers>
            <Scripts>
              <OnLoad>
                if self.Icon then TestFrameIconInLoad = true end
              </OnLoad>
            </Scripts>
          </Frame>
        </Ui>`,
      );
      const inLoad = await lua.doString("return TestFrameIconInLoad");
      expect(inLoad).toBe(true);
    } finally {
      lua.global.close();
    }
  });
});
