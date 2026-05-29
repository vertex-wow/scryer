# Milestone 4 — TOC Parser

## Goal

Parse WoW addon `.toc` files into a typed `TocFile` IR that defines the file load order for both XML parsing (M1) and Lua execution (M5–M9). This is a standalone utility with no Lua dependency — the foundation everything else in the Lua runtime series builds on.

## Implementation

**Location:** `src/parser/toc.ts` — alongside the existing `src/parser/xml.ts` (M1).

## TOC Format

```
## Interface: 120000, 50501, 11507
## Title: MyAddon |cFF69CCF0by Author|r
## Version: 1.0.0
## SavedVariables: MyAddonDB
## SavedVariablesPerCharacter: MyAddonCharDB

Libs\LibStub\LibStub.lua
Core\Init.lua
MyAddon.xml
```

## Parse Rules

- Lines starting with `##` are metadata directives (`key: value`).
- `## Interface:` is comma-separated multi-version; map each to flavor target (M10).
- `## SavedVariables` / `## SavedVariablesPerCharacter` declare global tables (stub as empty tables in sandbox; no persistence in M8).
- Non-comment, non-empty lines are file paths (backslash → forward slash); order is load order.
- File extensions: `.lua` → execute in sandbox; `.xml` → M1 parse + frame instantiation.
- Empty lines and `# comments` (single `#`) are ignored.
- Directives are case-insensitive; arbitrary whitespace around `:` is allowed.

## Output Interface

```ts
interface TocFile {
  interfaceVersions: number[];
  title: string;
  version?: string;
  savedVariables: string[];
  savedVariablesPerChar: string[];
  files: { path: string; type: "lua" | "xml" }[];
  rawMeta: Record<string, string>;
  sourceFile: string;
}
```

## Activation-Time Detection

Before fully parsing, use a lightweight check to confirm a file is a WoW TOC: any line `startsWith("##")` AND (lowercased) `includes("interface")` AND `includes(":")`. This mirrors the pattern from `ketho.wow-api/src/extension.ts:hasTocFile()`. Do **not** fully parse every TOC during activation — only on preview open.

## Testing

Pure function: full unit test coverage with inline fixtures. Cover:

- Single and multi-version `## Interface:` lines
- `SavedVariables` and `SavedVariablesPerCharacter` parsing
- Backslash path normalization
- Mixed `.lua` / `.xml` file lists
- Case-insensitive directive keys
- Comment lines (`#`) and empty lines ignored
- `rawMeta` captures unknown directives

## Dependencies

**M1** (shared parser infrastructure context; `TocFile` is used by M8 to drive XML parsing via the existing M1 parser).

## Rough Effort

**XS** — a 60–80 line parser with straightforward line-by-line logic.
