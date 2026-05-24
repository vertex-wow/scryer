# Milestone 6 — Hot Reload (Stretch)

## Goal

Live-reload the preview on file save with minimal re-work and a clear reloading indicator — the headline DX win over real WoW, where reloading requires `/reload` and a full UI restart.

## Approach

1. Watch workspace `.xml`, `.lua`, and `.toc` files for changes.
2. Use the dependency graph (from M1: TOC order + XML `Include`/`Script`) to find only the affected files.
3. Re-parse changed files and their dependents; re-run Lua for Lua changes.
4. Diff the render tree; apply minimal DOM updates in the webview.
5. Show a transient "Reloading..." overlay.

## File Watching

```ts
// Coarse: in-editor saves
vscode.workspace.onDidSaveTextDocument(doc => {
  if (isRelevantFile(doc.uri)) triggerReload(doc.uri);
});

// Fine: external changes (git checkout, file manager, etc.)
const watcher = vscode.workspace.createFileSystemWatcher("**/*.{xml,lua,toc}");
watcher.onDidChange(uri => triggerReload(uri));
watcher.onDidCreate(uri => triggerReload(uri));   // new file added
watcher.onDidDelete(uri => triggerFullReload());   // file removed → safe to full reload
```

**Debounce** bursts (100–150 ms) to coalesce multi-file saves (e.g. a formatter touching several files at once).

## Minimal Re-parse via Dependency Graph

The M1 parser builds a dependency graph: `file → Set<files it includes>` and the inverse `file → Set<files that include it>`.

**Affected-file computation:**
1. Start with the changed file.
2. Collect all files that transitively depend on it (upward in the graph).
3. Re-parse only those files in TOC load order.
4. `.toc` changes → recompute load order → full reload (safe default).

**XML-only change (no Lua):** re-parse XML, re-resolve templates for that subtree, diff and repaint (no Lua re-execution).

**Lua change:** must re-execute Lua (see state reset below) + re-render.

## Lua State Reset (Decision / Tradeoff)

| Strategy | Correctness | Speed | Risk |
|----------|------------|-------|------|
| **Full sandbox reset** *(recommended default)* | High — deterministic; no stale state | Slower (re-runs TOC from scratch) | None |
| Partial reset (Lua only, keep frame IR) | Medium — can miss leaked state | Faster | Stale closures, double-registered events |
| Incremental Lua patch | Low — very hard to do correctly | Fastest | High risk of divergence from real WoW behavior |

**Decision: full sandbox reset on any Lua change.** This mirrors what real WoW's `/reload` does. For XML-only changes, skip Lua re-execution (the frame IR update is sufficient).

**Teardown checklist before reset:**
- Cancel all pending `C_Timer` callbacks (clear the virtual timer queue).
- Unregister all event handlers.
- Dispose all frame objects (clear the frame registry).
- Reset the virtual clock to 0.

## Renderer Diff

To avoid a full repaint (flash) on XML-only changes:

1. Assign stable `id` to each frame IR node (based on `name` or `parentKey` path; fallback to source-file + line).
2. After re-parse, diff old vs new resolved tree using IDs as keys.
3. Apply incremental updates:
   - Position/size changed → update CSS on the existing div.
   - Texture/atlas changed → update `background-image` / `src`.
   - Text changed → update inner text.
   - Frame added → insert new div.
   - Frame removed → remove div.
4. Fall back to full repaint if IDs are unstable or the diff is ambiguous.

## User-Visible Indicators

- **"Reloading..." overlay** in the webview (semi-transparent, top-right corner) during the reload cycle.
- **Status-bar spinner** while reload is in progress.
- **Error toast** with file path + line number (from IR `sourceFile`/`sourceLine`) if parsing or Lua execution fails.
- **Success flash** (brief green status) on clean reload.

## Key Technical Decisions

- **Full Lua reset by default** (correctness over speed). An XML-only fast path skips re-execution.
- **ID-stable tree diff** to minimize repaint and avoid flicker.
- **Debounce at 100–150 ms** — fast enough to feel instant; slow enough to batch formatter saves.

## Foreseen Hurdles

- **Leaked timers and event registrations** across reloads when doing partial resets — mitigated by the full-reset default.
- **Mapping save → correct minimal affected set** — transitive dependency traversal must not miss any file; test with deeply nested Include chains.
- **ID stability when names change** — if an addon changes frame names between versions, diffs will be noisy; fall back to full repaint gracefully.
- **VSCode FileSystemWatcher on WSL/remote** — path normalization (backslash vs forward slash) and watcher latency on networked filesystems may need special handling.

## Dependencies

**M2** (renderer + DOM), **M4** (Lua runtime to reset and re-run), uses **M1** dependency graph.

## Rough Effort

**M** — 1–2 weeks.
