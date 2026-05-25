# Backlog — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

---

## CI-safe committed fixtures (deferred from M1)

**Problem:** The live-fixture tests in `test/parser/toc.test.ts` and `test/parser/xml.test.ts` read directly from `_live/Addons/` and skip in CI (`describeIfLive`). Parser correctness against real addon structure is not verified on every push.

**Revised plan:** Use `_reference/wow-cookbook` (our owned, WoW-verified addon examples) instead of generating IR snapshots from `_live/`. Two tiers:

1. **Always-run inline tests** — embed short cookbook XML verbatim as template literals in the test file. No filesystem dependency; CI-safe. Good for ExampleFrameBare, ExampleFrameModalDialog, ExampleControlMoveableFrame (all under ~40 lines). These are already added (see `test/parser/xml.test.ts`).
2. **`describeIfCookbook` tests** — read larger cookbook files from `_reference/wow-cookbook/docs/frames/Addons/` for more thorough integration coverage. Skip gracefully when the symlink is absent (e.g. a fresh clone without the sibling repo). Add as needed when a parser bug is found in a specific cookbook example.

This replaces the generate-fixtures script approach entirely. No derived JSON snapshots to maintain; the cookbook XML is the source of truth.

Note: `_live/` fixture tests remain as-is for testing against Blizzard-internal templates (DefaultPanelTemplate etc.) that the cookbook depends on but doesn't define.

**Effort:** Done — inline fixtures already added alongside the parser gap tests.

---

## `relativeKey` anchor targets unimplemented (deferred from M2)

**Problem:** WoW anchors support `relativeKey="$parent.SomeChild"` — a dotted path resolved from the current frame's parent. The M2 layout engine (`src/webview/layout.ts`) does not implement this; any anchor with a `relativeKey` silently falls back to the viewport rect, producing incorrect positioning for frames that use this pattern.

**Plan:** In `resolveTarget`, add a branch for `anchor.relativeKey`:

1. Parse the key path (split on `.`, expand `$parent` to the actual parent frame name).
2. Walk the frame registry using the expanded path segments.
3. Return the resolved target's rect, or fall back with a logged warning if unresolvable.

**Effort:** S — a few hours. Can be done as a standalone PR before M3 or alongside M3's anchor-target work.

---

## TGA texture decode (deferred from M3)

**Problem:** TGA (Targa) textures are used by many addon-bundled images. M3 logs a warning and shows a labeled placeholder for `.tga` files; it does not decode them.

**Plan:**

1. Pick a pure-JS TGA decoder (e.g. `tga-js` on npm, or a small custom reader — the format is simple: uncompressed or RLE-compressed, fixed header).
2. Decode TGA → RGBA buffer, then encode to PNG via `pngjs` (same pipeline as BLP).
3. **Critical:** respect the TGA image-origin descriptor byte (bit 5 of byte 17). If set, the image data is top-to-bottom; if clear, it is bottom-to-top. `dev/assets.sh` stores TGAs with the flip applied and the bit set correctly — the decoder must read it to avoid upside-down textures.
4. Cache in `.scryer-cache/` using the same SHA1 key scheme as BLP.
5. Add tests against a small known-good TGA fixture (bottom-to-top + top-to-bottom variants).

**Effort:** S — ~2–4 hours once a TGA library is selected.

---

## dev/extract.sh — WoW asset extraction for contributors (deferred from M3)

**Problem:** M3's asset pipeline is infrastructure without a usable path to get assets onto disk. There is no script to extract WoW Interface textures into `scryer.extractedAssetsDir`, making M3 untestable for contributors who haven't done this manually.

**Plan:**

Create `dev/extract.sh` (alongside `dev/assets.sh`) that wraps the WoW.export CLI to pull a minimal set of Interface textures into a local dir:

1. Read `WOW_DIR` from `dev/config.local.sh` (already established pattern).
2. Check for WoW.export CLI (`wowexport` or similar) and print install instructions if missing.
3. Extract a known-useful slice of Interface textures (e.g. `Interface/Buttons/`, `Interface/Common/`) into `$PROJECT_ROOT/.wow-assets/` (gitignored).
4. Print the path and remind the dev to set `scryer.extractedAssetsDir` in `.vscode/settings.json`.

WoW.export exports PNG directly, so no BLP decode is needed for contributor testing — this also exercises the PNG-direct-serve path (the fast path in `AssetService`).

Add `.wow-assets/` to `.gitignore`. Document usage in `dev/config.sh.example`.

**Notes:**

- WoW.export: cross-platform GUI + CLI, outputs PNG. Install: `https://github.com/Marlamin/WoWExport`
- Retail assets live in CASC archives inside the WoW install dir — WoW.export handles the CASC layer.
- Classic/Classic Era may have loose files; a simpler `rsync` or `cp` from `$WOW_DIR/Interface/` suffices for those flavors.

**Effort:** S — a few hours. Script + gitignore + config example docs.

---

## In-app asset setup guidance for end users (deferred from M3)

**Problem:** When a user opens a WoW XML file with Scryer and has no `scryer.extractedAssetsDir` configured, all textures show as colored placeholders with no explanation. There is nothing in the UI telling them how to get real textures.

**Plan:**

On first render (or when asset requests return nothing for every texture in the file), show a one-time notification:

```
Scryer: No extracted assets configured.
To see real WoW textures, set scryer.extractedAssetsDir to a folder of
extracted WoW assets (PNG/BLP). [Open Settings] [Learn More]
```

- "Open Settings" → `vscode.commands.executeCommand('workbench.action.openSettings', 'scryer.extractedAssetsDir')`.
- "Learn More" → link to a docs page or the README section on extraction.
- Show once per workspace (persist seen-flag in `context.workspaceState`), not on every open.
- Do not show if `scryer.extractedAssetsDir` is already set.

The output channel already logs per-path warnings; this is a higher-visibility one-time prompt, not a repeated nag.

**Effort:** S — ~1–2 hours. Notification logic in `panel.ts` + `workspaceState` flag.

---

## tsconfig solution-style refactor (IDE tooling debt)

**Problem:** `tsconfig.json` includes a `"references"` entry to `tsconfig.test.json` intending VS Code to use the test config for `test/` files. In practice the language server falls back to the root config, which lacks `types: ["jest","node"]`, so Jest/Node globals appear unresolved in the IDE. No CI impact — typecheck uses `tsconfig.build.json` which excludes test files.

**Fix:** Convert to a solution-style layout:

- Rename current `tsconfig.json` → `tsconfig.src.json` (add `"composite": true`, keep `rootDir: "src"`, no `references`).
- Replace `tsconfig.json` with a solution file: `{ "files": [], "references": [{"path":"./tsconfig.src.json"}, {"path":"./tsconfig.test.json"}] }`.
- Update `tsconfig.test.json` to reference `tsconfig.src.json` instead of `tsconfig.json`.
- Update `tsconfig.build.json`, `package.json` scripts, and any other references to the renamed file.

VS Code reliably picks the correct per-file config in a solution-style layout.

**Effort:** XS — under an hour, mostly renaming and updating references.
