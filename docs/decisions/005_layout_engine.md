# ADR 005 — Layout Engine Design

**Status:** Accepted  
**Date:** 2026-05-24

## Context

M2 requires computing CSS positions (left, top, width, height) for every WoW frame from the IR's anchor + size data. WoW's anchor system is more complex than CSS positioning:

- WoW uses (0,0) bottom-left / y-up; CSS uses (0,0) top-left / y-down.
- Any named anchor point on a frame can be "glued" to any named point on any other frame in the document tree (not just its parent).
- Anchor targets can reference frames that appear later in the tree (forward references).
- Two anchors can together constrain both position and size (the span between anchor attachment points defines the frame's extents).
- `setAllPoints` is a shorthand for TOPLEFT+BOTTOMRIGHT anchors to a target.

Three non-obvious decisions were made in the implementation.

---

## Decision 1: All layout in absolute viewport coordinates

### Options considered

**A. Parent-relative layout** — compute each frame's CSS rect relative to its DOM parent, matching how `position:absolute` works in CSS.

**B. Absolute-first layout** — compute all frame rects in absolute viewport coordinates, then convert to parent-relative when writing CSS.

### Decision: B (absolute-first)

### Rationale

WoW anchors reference _any named frame_, regardless of DOM parent/child relationship. If layout math runs in parent-relative coordinates, resolving an anchor to a non-parent target requires knowing the target's parent-relative position _and_ the ancestor chain to find a common reference frame. This is error-prone and hard to unit test.

Absolute coordinates make every anchor target trivially comparable — all positions are in the same coordinate space. Converting to parent-relative for CSS is a simple subtraction at write time.

### Consequences

- `layoutAll` returns a `Map<FrameIR, Rect>` with absolute viewport rects.
- Renderer converts to CSS: `cssLeft = frameRect.left − parentRect.left`.
- Unit tests for the layout engine are straightforward (everything in viewport pixels).

---

## Decision 2: Iterative layout (max 64 passes) over topological sort

### Options considered

**A. Topological sort** — build a dependency graph from anchor references, sort it, and compute each frame's rect exactly once in dependency order.

**B. Iterative convergence** — loop over all unresolved frames repeatedly, computing any frame whose anchor targets are now resolved. Stop when no progress is made or the pass limit is hit.

### Decision: B (iterative)

### Rationale

Topological sort requires building the full dependency graph first, including detecting and reporting cycles. It is the "correct" algorithm but adds ~100 lines of graph code. For M2 the added complexity is not justified: most addon files have shallow, linear anchor chains (frame A anchors to UIParent, frame B anchors to frame A). The iterative approach handles these in 2–3 passes with zero extra infrastructure.

The maximum iteration count (64) was chosen to be well above any realistic anchor chain depth while still terminating quickly on pathological inputs. Unresolved frames after the pass limit receive a zero-size fallback rect — visible as a bug but not a crash.

### Consequences

- Cycles are silently broken by the pass limit (frames in a cycle get fallback rects).
- Performance is O(frames × 64) in the worst case. Fine for addon UIs; revisit if used against massive generated UIs.
- Topological sort can replace this later if cycle reporting becomes important.

---

## Decision 3: Pure-math layout, no DOM measurements

### Options considered

**A. DOM-measurement layout** — after building the DOM tree, call `getBoundingClientRect()` or `offsetWidth/Height` to get actual rendered sizes (useful for font metrics, intrinsic text height, etc.), then do a second layout pass.

**B. Pure-math layout** — compute all rects from IR data only, using the explicit `size` fields from the XML and approximating font size as `height * 0.75`.

### Decision: B (pure math) for M2

### Rationale

DOM measurement requires the webview to be attached and rendered before layout can complete, creating a round-trip: build → measure → relayout. This complicates the message flow and makes unit testing impossible without a headless browser.

For M2 (no real assets, no Lua), pixel-perfect text sizing is not required. The `* 0.75` approximation is acceptable. Pure-math layout keeps `layout.ts` completely testable with Jest and fully independent of the browser environment.

### Consequences

- FontString heights are approximate. Text may clip or overflow for very long strings.
- To add DOM-measurement refinement later: run layout once (pure math), render, measure font elements, then re-run layout with corrected sizes. The iterative layout engine already supports this pattern — call `layoutAll` again with an updated size map.
