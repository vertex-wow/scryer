# Scryer — Configuration Reference

All settings live under the `scryer.*` namespace and can be set in User Settings, Workspace Settings (`.vscode/settings.json`), or a folder-level settings file.

---

## Installation Path

### `scryer.installDir`

Path to your WoW root directory — the folder containing `_retail_/`, `_classic_/`, and `.build.info`.

```jsonc
"scryer.installDir": "/path/to/World of Warcraft"
```

Used for:

- Detecting the installed game version (automatic cache invalidation when the game updates)
- Locating loose-file textures for Classic Era (fallback when CASC extraction is not available)
- Deriving the available flavors from `.build.info`

The active flavor subdirectory (`_retail_/`, `_classic_/`, etc.) is derived automatically from `scryer.flavor`.

---

## Flavor

### `scryer.flavor`

**Default:** `retail`

Which WoW flavor to use for asset extraction and display defaults.

| Value         | Flavor            |
| ------------- | ----------------- |
| `retail`      | Retail (Mainline) |
| `classic`     | Classic (MoP)     |
| `classic_era` | Classic Era       |

Change flavors at any time with the **Scryer: Select Flavor** command.

---

## Cache

### `scryer.cacheLocation`

**Default:** `global`

Where Scryer stores its unified cache (extracted source assets and derived PNG conversions).

| Value       | Behavior                                                             |
| ----------- | -------------------------------------------------------------------- |
| `global`    | VS Code global storage — shared across all workspaces (recommended)  |
| `workspace` | `<workspaceFolder>/.scryer-cache` — per-project; add to `.gitignore` |
| `custom`    | The path given by `scryer.cacheDir`                                  |

### `scryer.cacheDir`

**Default:** _(empty)_

Cache root path when `scryer.cacheLocation` is `"custom"`. Ignored otherwise. Scryer creates `source/` and `derived/` subdirectories inside this path.

---

## Asset Extraction Tools

### `scryer.cascToolPath`

**Default:** _(auto-detected from PATH)_

Path to the CASC extraction tool binary (e.g. `rustydemon-cli`). Passed to the extraction script via `--casc-tool`. Leave empty to auto-detect from `PATH`.

### `scryer.blp2pngPath`

**Default:** _(empty)_

Optional path to a `blp2png` CLI binary used as a fallback for BLP variants not supported by the built-in pure-JS decoder. Leave empty unless you encounter unsupported textures.

---

## Startup Preloading

### `scryer.startupContent`

**Default:** `none`

What Blizzard template and asset content Scryer loads when the extension activates.

| Value                           | Description                                | Size    | Time |
| ------------------------------- | ------------------------------------------ | ------- | ---- |
| `none`                          | Nothing preloaded                          | —       | —    |
| `shared-templates`              | `Blizzard_SharedXML` templates only        | ~2.1 MB | —    |
| `all-templates`                 | All Blizzard addon templates               | ~41 MB  | —    |
| `all-templates-shared-textures` | All templates + SharedXML textures         | ~2 MB   | <1s  |
| `all-templates-textures`        | All templates + full Blizzard texture tree | ~452 MB | ~40s |

Tiers are cumulative — selecting a higher tier includes all content from the lower tiers.

### `scryer.userAddonPreload`

**Default:** `on-demand`

How eagerly Scryer pre-warms texture assets for the addon currently being previewed.

| Value          | Description                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| `on-demand`    | Decode textures only when the webview requests them                         |
| `saved-file`   | Pre-warm textures referenced in the currently saved file                    |
| `current-file` | Same as `saved-file` but reads the unsaved buffer; updates live as you type |
| `workspace`    | Pre-warm textures for all WoW XML files in the workspace                    |

---

## Logging

Scryer writes diagnostic output to the **Scryer** Output channel (`View > Output`, then select "Scryer" from the dropdown). Use VS Code's built-in log level selector in the Output panel to control verbosity — the default is Warning.

---

## Version Targeting

### `scryer.defaultTarget`

**Default:** `mainline`

Default WoW version target used when no workspace-level target is configured.

| Value         | Version                   |
| ------------- | ------------------------- |
| `mainline`    | Retail                    |
| `mists`       | Mists of Pandaria Classic |
| `bcc`         | Burning Crusade Classic   |
| `classic_era` | Classic Era               |

---

## Per-Flavor Display Overrides

### `scryer.flavorConfigPath`

**Default:** _(empty, use built-in defaults)_

Path to a JSON file that overrides per-flavor display and rendering defaults. Merged on top of the built-in config — later layers win per key. The merge order is:

```
built-in default → built-in per-flavor → user default → user per-flavor
```

The file shape mirrors `src/flavors/defaults.json`. Include only the keys you want to override — omitted keys fall through to the built-in value. Flavor-specific blocks override the `"default"` block for that flavor only:

```jsonc
{
  "default": {
    "screenWidth": 2560,
    "screenHeight": 1440,
    "frameScale": 0.75,
  },
  "retail": {
    "defaultFont": "Fonts/MyCustomFont.ttf",
    "fontLetterSpacing": "0em",
  },
}
```

### WoW environment fields

These fields control how Scryer models the WoW environment. Change them to match your monitor setup or to simulate a different in-game configuration.

| Field              | Default                               | Description                                                         |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------- |
| `screenWidth`      | `1920`                                | Physical monitor width in pixels — determines UIParent aspect ratio |
| `screenHeight`     | `1080`                                | Physical monitor height in pixels                                   |
| `uiParentHeight`   | `768`                                 | WoW UIParent logical height (fixed by the engine; rarely changed)   |
| `defaultFont`      | `Fonts/FRIZQT__.TTF`                  | WoW-relative path to the default font file                          |
| `defaultFontSize`  | `12`                                  | Default font size when none is specified                            |
| `defaultFontFlags` | _(empty)_                             | WoW font rendering flags (e.g. `OUTLINE`, `THICKOUTLINE`)           |
| `defaultTextColor` | `{ r: 1.0, g: 0.82, b: 0.0, a: 1.0 }` | Default FontString color — WoW gold                                 |
| `frameScale`       | `1.0`                                 | Global scale applied to the preview viewport (CSS transform)        |

### Rendering calibration fields

These fields tune how closely the browser preview approximates WoW's actual text rendering. The built-in values are calibrated for the default FRIZQT\_\_.TTF font at standard DPI. If you change `defaultFont`, you may need to adjust these.

| Field               | Default         | Description                                                                                           |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `fontLetterSpacing` | `"0.033em"`     | CSS `letter-spacing` to compensate for WoW DirectWrite wider advance widths vs the browser's renderer |
| `autoFontSizeRatio` | `0.75`          | Fallback font size when no explicit size is set: `height × ratio`                                     |
| `fontSmoothing`     | `"antialiased"` | CSS `-webkit-font-smoothing` value. `antialiased` matches WoW's DirectWrite grayscale AA              |

> For preview chrome appearance (ruler colors, viewport background, status bar, placeholder tiles, layout solver parameters), see [advancedConfiguration.md](./advancedConfiguration.md).
