# Milestone 8 — TOC Execution Pipeline

## Goal

Wire together the `scryer.openLive` command with the full TOC load sequence: parse the `.toc`, bootstrap the sandbox, execute files in order, and fire `ADDON_LOADED` + `PLAYER_LOGIN`. After this milestone, opening a real simple addon from `_live/` renders its frames.

## Command: `scryer.openLive`

```jsonc
// package.json contributions
"commands": [
  { "command": "scryer.openLive", "title": "Open Scryer Live View", "category": "Scryer", "icon": "$(run)" }
],
"menus": {
  "editor/title/context": [
    { "command": "scryer.openLive", "when": "resourceExtname == .toc", "group": "1_open" }
  ],
  "explorer/context": [
    { "command": "scryer.openLive", "when": "resourceExtname == .toc", "group": "navigation" }
  ]
}
```

**Note on `.toc` language registration:** `resourceExtname == .toc` is sufficient for M8. A proper `toc` language contribution (syntax highlighting, `resourceLangId == toc`) is a future enhancement.

## Load Sequence

1. Parse the `.toc` file (M4 `TocFile`).
2. Bootstrap sandbox: M5 compat shim + M6 stubs.
3. Pre-populate `SavedVariables` globals as empty tables (no persistence; hot-reload re-injection deferred to M11).
4. For each file in `TocFile.files` in order:
   - `.lua` → execute in sandbox with current `_G`.
   - `.xml` → M1 parse; register virtual templates; instantiate concrete frames.
5. After all files loaded, fire `ADDON_LOADED` event for the addon name.
6. Fire `PLAYER_LOGIN` to trigger post-init code.

## XML Files in the TOC

When a `.xml` file is encountered, invoke the existing M1 parser and inheritance resolver. Frames defined in XML are instantiated into the frame object model (M7) the same way `CreateFrame` creates them from Lua. The resulting frame objects are accessible from Lua by name via `_G`.

The M1 Blizzard template registry (loaded during M3) is available for template resolution.

## Error Handling

- Parse errors in `.lua` files → log to output channel with file path + line number; continue loading remaining files (mirrors WoW's behavior).
- Parse errors in `.xml` files → same.
- Lua runtime errors → log with traceback; continue if recoverable.
- Missing files listed in `.toc` → warn; skip.

## ScryerLivePanel Lifecycle

- One `ScryerLivePanel` per `.toc` file. Re-opening the same `.toc` reuses or recreates the panel.
- Panel title: addon title from `## Title:` (strip color codes).
- Panel closed → dispose the Lua sandbox and free the frame registry.

## Testing

Integration test using a simple hand-crafted addon (or a known-simple addon from `_live/`):

- Open a `.toc` with one `.lua` file and one `.xml` file.
- After load, verify frames created in XML and Lua both appear in the webview.
- Verify `ADDON_LOADED` was dispatched (check a handler registered before it fires).
- Verify `SavedVariables` tables exist as empty tables in `_G`.

## Dependencies

**M4** (TOC parser); **M7** (frame object model + ScryerLivePanel).

## Rough Effort

**S** — wiring; the hard parts (parser, sandbox, frame model) are already done.
