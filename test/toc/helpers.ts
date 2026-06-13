import * as fs from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
import { createSandbox } from "../../src/lua/sandbox";
import { registerWowApi, VirtualClock } from "../../src/lua/wow-api";
import { registerFrameModel } from "../../src/lua/createframe";
import { FrameRegistry } from "../../src/lua/frame-registry";
import { parseToc } from "../../src/parser/toc";
import { runTocAddon } from "../../src/lua/toc-runner";
import type { FrameIR } from "../../src/parser/ir";
import { renderFrames } from "../webview/helpers";

export { queryRendered, VIEWPORT } from "../webview/helpers";

const WASM_PATH = path.join(__dirname, "../../node_modules/wasmoon/dist/glue.wasm");

/**
 * Run a TOC addon fixture through the full Lua pipeline and return FrameIR[]
 * ready to pass to renderFrames().
 *
 * tocDir must contain exactly one .toc file.
 */
export async function runTocFixture(
  tocDir: string,
  opts?: { errors?: string[] },
): Promise<FrameIR[]> {
  const tocFile = fs.readdirSync(tocDir).find((f) => f.endsWith(".toc"));
  if (!tocFile) throw new Error(`No .toc file found in ${tocDir}`);

  const registry = new FrameRegistry(1024, 768);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(lua, registry);

  const tocContent = fs.readFileSync(path.join(tocDir, tocFile), "utf-8");
  const toc = parseToc(tocContent, path.join(tocDir, tocFile));

  try {
    await runTocAddon({
      toc,
      addonDir: tocDir,
      sandbox: lua,
      blizzardTemplates: undefined,
      readFile: async (p) => fs.readFileSync(p, "utf-8"),
      output: {
        info: () => {},
        warn: () => {},
        error: (msg: string) => {
          if (opts?.errors) opts.errors.push(msg);
          else console.error(msg);
        },
      },
    });
    clock.advance(0.001);
  } finally {
    lua.global.close();
  }

  return registry.serialize();
}

/**
 * Run a TOC addon fixture and render the result into the webview harness page.
 * Combines runTocFixture + renderFrames into a single call for most TOC specs.
 */
export async function renderTocFixture(page: Page, tocDir: string): Promise<void> {
  const frames = await runTocFixture(tocDir);
  await renderFrames(page, frames as unknown as Record<string, unknown>[]);
}
