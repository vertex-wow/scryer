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

## tsconfig solution-style refactor (IDE tooling debt)

**Problem:** `tsconfig.json` includes a `"references"` entry to `tsconfig.test.json` intending VS Code to use the test config for `test/` files. In practice the language server falls back to the root config, which lacks `types: ["jest","node"]`, so Jest/Node globals appear unresolved in the IDE. No CI impact — typecheck uses `tsconfig.build.json` which excludes test files.

**Fix:** Convert to a solution-style layout:

- Rename current `tsconfig.json` → `tsconfig.src.json` (add `"composite": true`, keep `rootDir: "src"`, no `references`).
- Replace `tsconfig.json` with a solution file: `{ "files": [], "references": [{"path":"./tsconfig.src.json"}, {"path":"./tsconfig.test.json"}] }`.
- Update `tsconfig.test.json` to reference `tsconfig.src.json` instead of `tsconfig.json`.
- Update `tsconfig.build.json`, `package.json` scripts, and any other references to the renamed file.

VS Code reliably picks the correct per-file config in a solution-style layout.

**Effort:** XS — under an hour, mostly renaming and updating references.
