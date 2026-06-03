# Test harness and methodology

## The primary debugging loop

When a rendering problem appears in the extension — wrong size, wrong position, missing layer, wrong color — the fastest path to a fix is:

1. Create a minimal XML file that reproduces the problem.
2. Drop it in `test/e2e/` unchanged.
3. Add assertions against what you _expect_ to see (geometry, CSS, messages).
4. Run `pnpm test:e2e` — watch it fail.
5. Fix the bug until the test goes green.
6. The test is now a permanent regression guard.

This is the key property of the e2e layer: **the fixture is the reproduction case**. You don't need to translate the failure into a synthetic description — the actual XML that fails in the extension goes in unchanged. The assertion is a direct statement of what correct output looks like. When you've fixed the bug, the test tells you so without ambiguity.

---

## Layers at a glance

| Layer               | Runner         | Command              | Directory         | Purpose                                                    |
| ------------------- | -------------- | -------------------- | ----------------- | ---------------------------------------------------------- |
| Unit                | Jest           | `pnpm test`          | `test/unit/`      | Component precision: parser IR, layout math, Lua execution |
| Unit (CASC)         | Jest           | `pnpm test:casc`     | `test/unit-casc/` | BLP decode, CASC extraction (needs dev config)             |
| **E2E pipeline**    | **Playwright** | **`pnpm test:e2e`**  | **`test/e2e/`**   | **Real XML/TOC → full pipeline → DOM/CSS assertions**      |
| E2E pipeline (CASC) | Playwright     | `pnpm test:e2e-casc` | `test/e2e-casc/`  | Same, with CASC-extracted assets (needs dev config)        |
| Webview protocol    | Playwright     | `pnpm test:webview`  | `test/webview/`   | Webview message protocol and z-index formulas              |
| Visual regression   | Playwright     | `pnpm test:webview`  | `test/webview/`   | Screenshot regression for geometry                         |

CASC layers require a game install path in `dev/config.local.json` (copy from `dev/config.json.example`).

---

## Unit tests — `test/unit/`

Test individual modules in Node without a browser or extension host. Covers: XML parser (IR structure), layout engine (anchor/size math), Lua sandbox, WoW API stubs, asset resolver, TOC parser.

When an e2e test fails, unit tests tell you _where_ — parser, layout, or renderer — without browser overhead.

**vscode mock:** Jest rewrites `import 'vscode'` to `test/unit/__mocks__/vscode.ts`. When extension code uses a new VS Code API, add a stub there.

**Lua transform:** `.lua` files imported in tests load as plain text via `test/unit/transforms/lua-text.mjs`.

---

## E2E pipeline tests — `test/e2e/` ★ primary layer

Real XML fixture → `parseXmlFile` → `resolveInheritance` → webview harness → DOM/CSS assertions. Exercises the complete parse/resolve/render chain.

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

Each spec has a matching XML fixture **in the same directory** (`test/e2e/`). The fixture is the scenario; the spec is the assertion. Fixtures must be valid WoW XML — the same file you'd load in the extension.

| Fixture                     | What it tests                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `direct_texture_vertex.xml` | Frame geometry + texture file path extracted and surfaced as requestAsset                         |
| `simple_frame.xml`          | Solid-color texture (color, setAllPoints fill), FontString (text, size, position, justify, color) |

### Anatomy of an e2e test

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

- CSS output for specific XML attributes (color, setAllPoints, justifyH/V, FontString size/position/color) — those assertions belong in the e2e test for the fixture that defines them
- Negative requestAsset cases for specific fixture content — covered by the fixture's e2e test

Uses `makeFrame`/`makeTexture` helpers from `helpers.ts` to construct renderer input directly, bypassing the parser.

---

## Visual regression — `test/webview/visual.spec.ts`

Screenshot regression via `page.locator("#viewport").toHaveScreenshot(...)`. **Only solid-color textures — no file textures, no FontStrings.** FontStrings and file-resolved textures produce platform-dependent rendering that makes snapshots non-deterministic. Update with `pnpm test:webview:update`.

---

## Shared fixtures — `test/fixtures/`

| Path                    | Contents                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| `fixtures/assets/`      | BLP/PNG/TGA images (`vertex-icon.*`) — BLP decode and asset pipeline tests |
| `fixtures/libs/`        | Lua libraries (`CallbackHandler-1.0.lua`) — Lua sandbox integration tests  |
| `fixtures/SimpleAddon/` | Minimal addon (`SimpleAddon.toc/.lua/.xml`) — TOC and Lua execution tests  |

---

## Manual fixtures — `test/manual/`

XML and Lua fixtures for **hand-checking the extension visually**. Not run by any automated runner. When a file here gets automated coverage, move it to `test/e2e/` in the same change that adds the spec.

---

## Decision guide

| Scenario                                      | Layer                                                 |
| --------------------------------------------- | ----------------------------------------------------- |
| Real-world rendering bug appears              | Create minimal XML → `test/e2e/` fixture + assertions |
| New parser rule, layout formula, Lua stub     | Unit test                                             |
| New webview message protocol behavior         | `render.spec.ts`                                      |
| Visual geometry regression (solid color only) | `visual.spec.ts`                                      |
| CSS output for a specific XML attribute       | E2E test for the fixture that uses it                 |
| BLP decode, CASC extraction                   | Unit-CASC or E2E-CASC (needs dev config)              |
