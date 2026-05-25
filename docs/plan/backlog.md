# Backlog — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

---

## CI-safe committed fixtures (deferred from M1)

**Problem:** The live-fixture tests in `test/parser/toc.test.ts` and `test/parser/xml.test.ts` read directly from `_live/Addons/` and skip in CI (`describeIfLive`). Parser correctness against real addon structure is not verified on every push.

**Plan:** Add `scripts/generate-fixtures.ts`, runnable via `pnpm generate:fixtures`, that:

1. Reads source XML/TOC files from `_live/Addons/` (never committed — Blizzard IP).
2. Runs them through the parser.
3. Writes the resulting IR as JSON to `test/fixtures/` (committed — our derived data, not Blizzard source).

The live-fixture tests then load from `test/fixtures/` instead of `_live/`, removing the CI skip entirely.

Constraints:

- Only structured IR (parsed output) goes into `test/fixtures/` — no raw XML/TOC, no textures, no atlas data.
- Re-run `pnpm generate:fixtures` locally whenever the live addon versions change; commit the updated snapshots.
- Include a header in each fixture file noting the source addon version/date so drift is detectable.

**Effort:** S — a few hours.

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
