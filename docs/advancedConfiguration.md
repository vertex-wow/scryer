# Scryer — Advanced Configuration

This document covers the visual and behavioral knobs that control the Scryer preview chrome — the parts that aren't WoW environment values but instead define how the preview panel itself looks and behaves.

These settings are primarily useful for:

- **Extension contributors** tweaking or debugging the preview UI
- **Advanced users** who want to adjust the visual style of the preview panel
- **Future theme authors** — this set of fields forms the natural boundary of a theming surface if official theme support is ever added

All fields live in `src/flavors/defaults.json` and are overridable via `scryer.flavorConfigPath` (see [configuration.md](./configuration.md#per-flavor-display-overrides)).

---

## Viewport background

The preview viewport uses a checkerboard pattern to indicate transparent areas, layered over a solid base color.

| Field                  | Default  | Description                              |
| ---------------------- | -------- | ---------------------------------------- |
| `viewportBg`           | `"#555"` | Solid base color behind the checkerboard |
| `viewportCheckerDark`  | `"#444"` | Dark checkerboard square color           |
| `viewportCheckerLight` | `"#666"` | Light checkerboard square color          |
| `viewportCheckerSize`  | `128`    | Checkerboard tile size in CSS pixels     |

---

## Pixel ruler

The pixel ruler overlay shows WoW logical-pixel coordinates. `rulerSize` is the strip thickness; all intervals are in WoW logical pixels.

| Field                 | Default             | Description                                                                |
| --------------------- | ------------------- | -------------------------------------------------------------------------- |
| `rulerSize`           | `20`                | Ruler strip thickness in CSS pixels                                        |
| `rulerBg`             | `"#1a1a1a"`         | Ruler strip background color                                               |
| `rulerBorder`         | `"#2a2a2a"`         | Ruler border line color (also used for status bar border and ruler corner) |
| `rulerTickMajorColor` | `"#666"`            | Major tick mark color                                                      |
| `rulerTickMinorColor` | `"#3a3a3a"`         | Minor tick mark color                                                      |
| `rulerLabelColor`     | `"#c8c8c8"`         | Numeric label text color                                                   |
| `rulerLabelInterval`  | `100`               | WoW-pixel interval between numeric labels                                  |
| `rulerTickMajor`      | `50`                | WoW-pixel spacing for major tick marks                                     |
| `rulerTickMinor`      | `10`                | WoW-pixel spacing for minor tick marks                                     |
| `rulerShadowColor`    | `"rgba(0,0,0,0.9)"` | Text shadow color behind ruler labels                                      |
| `rulerShadowBlur`     | `3`                 | Text shadow blur radius in pixels                                          |

---

## Status bar

The fixed bar at the top of the preview panel (contains the ruler toggle and status text).

| Field             | Default            | Description                     |
| ----------------- | ------------------ | ------------------------------- |
| `statusBarHeight` | `20`               | Status bar height in CSS pixels |
| `statusBarBg`     | `"#222"`           | Status bar background color     |
| `statusBarColor`  | `"#888"`           | Status bar text color           |
| `statusBarFont`   | `"11px monospace"` | Status bar CSS font shorthand   |

> `statusBarHeight` also affects how ruler canvases are positioned — the ruler strips sit immediately below the status bar.

---

## Placeholder tiles

Placeholder tiles appear for textures that haven't been extracted yet. Each tile gets a unique muted hue derived deterministically from the file path.

| Field                     | Default | Description                                        |
| ------------------------- | ------- | -------------------------------------------------- |
| `placeholderSaturation`   | `45`    | HSL saturation (0–100) for placeholder tile colors |
| `placeholderLightness`    | `30`    | HSL lightness (0–100) for placeholder tile colors  |
| `placeholderLabelOpacity` | `0.7`   | Opacity (0–1) of the file path label on each tile  |

---

## Layout solver

The anchor layout engine uses an iterative dependency-resolution pass. These parameters control its precision and termination.

| Field                 | Default | Description                                                                        |
| --------------------- | ------- | ---------------------------------------------------------------------------------- |
| `layoutEpsilon`       | `1e-9`  | Floating-point tolerance for comparing anchor point-fractions on an axis           |
| `layoutMaxIterations` | `64`    | Maximum iterations before the solver gives up and assigns fallback zero-size rects |

These are very unlikely to need adjustment unless you are working on the layout engine itself or stress-testing deeply nested anchor chains.
