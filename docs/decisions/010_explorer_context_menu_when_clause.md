# ADR 010 — Explorer context menu: show on all folders rather than filtering to addon folders

**Status:** Decided (2026-05-30)

## Context

The "Open WoW Live View" context menu entry for explorer folders (`scryer.openLiveFolder`) should ideally appear only on valid WoW addon folders — directories that contain a `.toc` file whose name matches the folder name (e.g. `MyAddon/MyAddon.toc`).

VS Code's `when` clause system supports an `in` operator that can check whether a value is a member of a context array. The initial implementation used this to maintain a `scryer.tocFolderPaths` context variable: on activation, and whenever any `.toc` file changed, the extension scanned the workspace with `findFiles("**/*.toc")`, collected the paths of qualifying addon folders, and called `setContext("scryer.tocFolderPaths", paths)`. The menu item used `"when": "resourcePath in scryer.tocFolderPaths"`.

This worked correctly on first use but exhibited a consistent bug: after opening a live view from a folder, right-clicking that same folder again caused the menu item to disappear. Right-clicking any other folder and then returning to the original folder made it reappear.

## Root cause

VS Code caches `when`-clause evaluation results per resource. After the live view webview panel opens, it takes focus away from the explorer. The explorer's `resourcePath` context key becomes stale from VS Code's perspective. When the same folder is right-clicked again, VS Code does not detect a context change (the folder path is unchanged from when the command was last evaluated) and may reuse the cached `in`-expression result from a stale context where `resourcePath` was no longer the folder's path. Clicking a different folder forces `resourcePath` to a new value, resetting the cache and causing correct re-evaluation on the next click back to the original folder.

This is a VS Code limitation: the `in` operator with dynamic context arrays is not reliably re-evaluated for the same resource in consecutive right-click sequences where an editor panel change occurs between them.

## Options considered

**Option A — Context-aware filtering (initial implementation)**
Maintain `scryer.tocFolderPaths` via workspace scanning. Menu item uses `resourcePath in scryer.tocFolderPaths`. Precise filtering but unreliable due to VS Code caching behavior described above.

**Option B — Show on all folders**
Change the `when` clause to `explorerResourceIsFolder`. VS Code sets this key reliably on every explorer right-click, independent of editor focus or prior command history. Remove the workspace scanning and `setContext` call entirely. Non-addon folders get a clear error message from the command handler (`no matching TOC file found`).

## Decision

**Option B.** Show the menu item on all explorer folders.

## Rationale

- `explorerResourceIsFolder` is always evaluated fresh by VS Code for the right-clicked item; it is not affected by the caching behavior that breaks `in`-expression checks.
- The `scryer.openLiveFolder` command already validates the folder and shows an actionable error when no matching `.toc` is found. The UX cost of the item appearing on non-addon folders is low.
- The workspace-scan machinery (`findFiles`, `createFileSystemWatcher`, `setContext`) adds ongoing complexity and startup work for a filtering benefit that proved unreliable. Removing it simplifies the extension.
- This extension targets WoW addon developers whose workspaces are typically organized around addon folders. Showing the item on non-addon folders is a minor annoyance in practice.

## Consequences

- "Open WoW Live View" appears on every folder in the explorer, not just qualifying addon folders.
- Non-addon folders respond with an error rather than silently doing nothing.
- If VS Code fixes the `in`-operator caching issue in a future release, Option A could be reconsidered with the context-aware approach restored.
