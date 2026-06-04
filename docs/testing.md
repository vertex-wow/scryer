# Test harness and methodology

## The primary debugging loop

When a rendering problem appears in the extension — wrong size, wrong position, missing layer, wrong color — the fastest path to a fix is:

1. Create a minimal XML file that reproduces the problem.
2. Drop it in `test/xml/` unchanged.
3. Add assertions against what you _expect_ to see (geometry, CSS, messages).
4. Run `pnpm test:xml` — watch it fail.
5. Fix the bug until the test goes green.
6. The test is now a permanent regression guard.

This is the key property of the xml layer: **the fixture is the reproduction case**. You don't need to translate the failure into a synthetic description — the actual XML that fails in the extension goes in unchanged. The assertion is a direct statement of what correct output looks like. When you've fixed the bug, the test tells you so without ambiguity.

---

## Layers at a glance

| Layer                | Runner         | Command              | Directory         | Purpose                                                     |
| -------------------- | -------------- | -------------------- | ----------------- | ----------------------------------------------------------- |
| Unit                 | Jest           | `pnpm test`          | `test/unit/`      | Component precision: parser IR, layout math, Lua execution  |
| Unit (CASC)          | Jest           | `pnpm test:casc`     | `test/unit-casc/` | BLP decode, CASC extraction (needs dev config)              |
| **XML preview**      | **Playwright** | **`pnpm test:xml`**  | **`test/xml/`**   | **XML file → parse → render → DOM/CSS assertions (no Lua)** |
| XML preview (CASC)   | Playwright     | `pnpm test:xml-casc` | `test/xml-casc/`  | Same, with CASC-extracted assets (needs dev config)         |
| **TOC live view**    | **Playwright** | **`pnpm test:toc`**  | **`test/toc/`**   | **TOC file → Lua execution → render → DOM/CSS assertions**  |
| TOC live view (CASC) | Playwright     | `pnpm test:toc-casc` | `test/toc-casc/`  | Same, with Blizzard Lua preloaded (needs dev config)        |
| Webview protocol     | Playwright     | `pnpm test:webview`  | `test/webview/`   | Webview message protocol and z-index formulas               |
| Visual regression    | Playwright     | `pnpm test:webview`  | `test/webview/`   | Screenshot regression for geometry                          |

CASC layers require `scryer.cacheDir` in `dev/settings.local.json` (copy from `dev/settings.json.example`). The extracted assets are read from `<cacheDir>/<flavor>/source`.

---

## Unit tests — `test/unit/`

Test individual modules in Node without a browser or extension host. Covers: XML parser (IR structure), layout engine (anchor/size math), Lua sandbox, WoW API stubs, asset resolver, TOC parser.

When a test fails, unit tests tell you _where_ — parser, layout, or renderer — without browser overhead.

**vscode mock:** Jest rewrites `import 'vscode'` to `test/unit/__mocks__/vscode.ts`. When extension code uses a new VS Code API, add a stub there.

**Lua transform:** `.lua` files imported in tests load as plain text via `test/unit/transforms/lua-text.mjs`.

---

## XML preview tests — `test/xml/`

Real XML fixture → `parseXmlFile` → `resolveInheritance` → webview harness → DOM/CSS assertions. No Lua execution. Exercises the static parse/resolve/render chain.

### What goes here

- Any real-world rendering failure that has been reduced to a minimal XML
- Assertions about rendered geometry (size, position, anchor behavior)
- Assertions about rendered CSS (color, fill, text alignment, font color)
- Assertions about webview messages (requestAsset path extracted from the XML)
- Regression guards for every fixed rendering bug

### What does NOT go here

- Renderer mechanics that have no XML origin (e.g. testing the assetResolved message handler in isolation — that belongs in render.spec.ts)
- Exhaustive coverage of renderer edge cases that don't arise from real XML

### XML fixtures

Each spec has a matching XML fixture **in the same directory** (`test/xml/`). The fixture is the scenario; the spec is the assertion. Fixtures must be valid WoW XML — the same file you'd load in the extension.

| Fixture                     | What it tests                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `direct_texture_vertex.xml` | Frame geometry + texture file path extracted and surfaced as requestAsset                         |
| `simple_frame.xml`          | Solid-color texture (color, setAllPoints fill), FontString (text, size, position, justify, color) |

### Anatomy of an XML preview test

```typescript
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { VIEWPORT, renderFrames, queryRendered } from "../webview/helpers";

function parseFixture(): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, "my_fixture.xml");
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  return resolved.frames as unknown as Record<string, unknown>[];
}
```

After `renderFrames(page, frames)`:

- `queryRendered(page)` — returns all **named** elements (`data-name != ""`): `{ name, kind, width, height, left, top, text? }`. Positions are relative to the nearest positioned ancestor (frame-relative for layer objects, viewport-relative for top-level frames).
- `page.evaluate(...)` — for unnamed elements (no `name` attr in XML), query by `[data-kind="FontString"]`, `[data-layer="BACKGROUND"] [data-kind="Texture"]`, etc.
- `_vscodeMessages` — accumulated host-bound messages from the webview:

```typescript
const messages = await page.evaluate(
  () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
);
```

**CSS color note:** Chromium normalises `rgba(r,g,b,1)` → `rgb(r, g, b)` on readback. Assert the normalised form.

---

## TOC live view tests — `test/toc/`

TOC fixture → `runTocAddon` (full Lua execution, OnLoad, events) → webview harness → DOM/CSS assertions. Exercises the Live View path end-to-end.

### What goes here

- Any fixture that requires Lua execution to produce visible output (OnLoad, event handlers, CreateTexture, CreateFontString called from Lua)
- Assertions about frames/textures created dynamically at runtime
- Regression guards for the Live View rendering path

### What does NOT go here

- Frames defined purely in XML with no Lua — those belong in `test/xml/`
- TOC parser or Lua API unit concerns — those belong in `test/unit/`

### TOC fixtures

Each spec has a matching TOC fixture directory **in `test/fixtures/`** (shared, reusable) or co-located in `test/toc/`. The TOC + XML + Lua files are the scenario; the spec is the assertion.

**`.lua` module hook:** `playwright.toc.config.ts` registers a `Module._extensions[".lua"]` handler so Node can resolve the `import ... from "*.lua"` statements inside `src/lua/sandbox.ts` and `src/lua/createframe.ts`. This mirrors the Jest `lua-text.mjs` transform. New TOC Playwright configs that import from the Lua pipeline must include the same hook.

| Fixture                                     | What it tests                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/CreateTextureAddon/`              | OnLoad → CreateTexture → SetAtlas / SetSize / SetPoint → registry (unit-level integration)                                                          |
| `fixtures/MixinAddon/`                      | Lua file → Mixin() + parentKey FontString → SetText / SetTextColor → rendered DOM                                                                   |
| `fixtures/NineSliceUtilAddon/`              | OnLoad → NineSliceUtil.ApplyLayout → 9 atlas textures created (used by toc + toc-casc)                                                              |
| `fixtures/BlizzInheritMixinAddon/`          | XML `inherits="NineSlicePanelTemplate"` → NineSlicePanelMixin OnLoad → 9 NineSlice pieces (toc + toc-casc)                                          |
| `fixtures/ExampleFrameTitleFrameAddon/`     | XML `inherits="DefaultPanelTemplate"` + Lua `SetTitle()` — guard path (template unresolved, SetTitle error swallowed)                               |
| `fixtures/ExampleFrameTitleFrameMockAddon/` | Same frame + mock `DefaultPanelTemplate` XML stub — template resolves, SetTitle wires up TitleText FontString, title text in DOM (no CASC required) |

---

## TOC live view (CASC) tests — `test/toc-casc/`

Same pipeline as `test/toc/`, but Blizzard Lua files (`Blizzard_SharedXMLBase`, `Blizzard_Colors`, `Blizzard_SharedXML`) **and** Blizzard XML templates (via `loadBlizzardRegistry`) are preloaded before running the user's addon. This matches the production path in `live-panel.ts` exactly: both Lua globals and XML template inheritance are available. Tests that require template-mixin wiring (e.g. `DefaultPanelTemplate`, `NineSlicePanelTemplate`) belong here.

Requires `scryer.cacheDir` in `dev/settings.local.json` with `Interface/AddOns/Blizzard_SharedXML/` present under `<cacheDir>/<flavor>/source`. Tests skip automatically when absent.

| Fixture                                 | What it tests                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/NineSliceUtilAddon/`          | NineSliceUtil.ApplyLayout → 9 piece textures created + Tooltip-NineSlice-\* requestAsset messages                                 |
| `fixtures/BlizzInheritMixinAddon/`      | NineSlicePanelTemplate inheritance → NineSlicePanelMixin OnLoad → 9 pieces + requestAsset (distinct from direct ApplyLayout call) |
| `fixtures/ExampleFrameTitleFrameAddon/` | DefaultPanelTemplate → ButtonFrameTemplate mixin wiring → SetTitle("…") sets title FontString text                                |

---

## Webview protocol tests — `test/webview/render.spec.ts`

Tests the webview renderer for behaviors that have **no XML equivalent** — things that are about the message protocol or rendering formula, not about a specific XML attribute.

**Belongs here:**

- Ready message emitted on load
- `reload` message replaces previous render
- `requestAsset` emitted when a texture has a file path (positive case)
- `assetResolved` message applies a decoded image to the texture element
- frameStrata → z-index formula (BACKGROUND/MEDIUM/HIGH/DIALOG)
- Layer level → z-index formula (BACKGROUND/ARTWORK/OVERLAY)
- FontString text content appears in DOM

**Does NOT belong here:**

- CSS output for specific XML attributes (color, setAllPoints, justifyH/V, FontString size/position/color) — those assertions belong in the xml test for the fixture that defines them
- Negative requestAsset cases for specific fixture content — covered by the fixture's xml test

Uses `makeFrame`/`makeTexture` helpers from `helpers.ts` to construct renderer input directly, bypassing the parser.

---

## Visual regression — `test/webview/visual.spec.ts`

Screenshot regression via `page.locator("#viewport").toHaveScreenshot(...)`. **Only solid-color textures — no file textures, no FontStrings.** FontStrings and file-resolved textures produce platform-dependent rendering that makes snapshots non-deterministic. Update with `pnpm test:webview:update`.

---

## Shared fixtures — `test/fixtures/`

| Path                           | Contents                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `fixtures/assets/`             | BLP/PNG/TGA images (`vertex-icon.*`) — BLP decode and asset pipeline tests                    |
| `fixtures/libs/`               | Lua libraries (`CallbackHandler-1.0.lua`) — Lua sandbox integration tests                     |
| `fixtures/SimpleAddon/`        | Minimal addon (`SimpleAddon.toc/.lua/.xml`) — TOC and Lua execution tests                     |
| `fixtures/CreateTextureAddon/` | TOC+XML with OnLoad → CreateTexture/SetAtlas/SetSize/SetPoint — used by toc-runner unit tests |

---

## Manual fixtures — `test/manual/`

XML and Lua fixtures for **hand-checking the extension visually**. Not run by any automated runner. When a file here gets automated coverage, move it to `test/xml/` or `test/toc/` (depending on whether it uses Lua execution) in the same change that adds the spec.

---

## Decision guide

| Scenario                                      | Layer                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| Rendering bug in XML Preview (no Lua)         | Minimal XML → `test/xml/` fixture + assertions           |
| Rendering bug in Live View (Lua execution)    | TOC+XML fixture → `test/toc/` spec + assertions          |
| New parser rule, layout formula, Lua stub     | Unit test                                                |
| New webview message protocol behavior         | `render.spec.ts`                                         |
| Visual geometry regression (solid color only) | `visual.spec.ts`                                         |
| CSS output for a specific XML attribute       | `test/xml/` test for the fixture that uses it            |
| CSS output for a Lua-created frame/texture    | `test/toc/` test for the fixture that uses it            |
| BLP decode, CASC extraction                   | `test/unit-casc/` or `test/xml-casc/` (needs dev config) |
