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

Change flavors at any time with the **Scryer: Select Flavor** command or the flavor dropdown in the preview toolbar.

---

## Locale

### `scryer.locale`

**Default:** `enUS`

The WoW locale returned by `GetLocale()` in addon Lua code. Affects any addon logic that branches on region — localized strings, layout adjustments, feature flags.

| Value  | Language                |
| ------ | ----------------------- |
| `enUS` | English (US)            |
| `enGB` | English (GB)            |
| `deDE` | German                  |
| `frFR` | French                  |
| `esES` | Spanish (Spain)         |
| `esMX` | Spanish (Latin America) |
| `ptBR` | Portuguese (Brazil)     |
| `ptPT` | Portuguese (Portugal)   |
| `ruRU` | Russian                 |
| `koKR` | Korean                  |
| `zhTW` | Traditional Chinese     |
| `zhCN` | Simplified Chinese      |
| `itIT` | Italian                 |

Changeable from the preview toolbar without closing the panel. Only affects the live TOC panel (where Lua runs); the static XML panel does not execute Lua.

---

## Screen Resolution

### `scryer.screenResolution`

**Default:** `1920x1080`

Physical monitor resolution for the preview. Overrides `screenWidth` and `screenHeight` from the flavor config and recalculates `uiParentWidth` via the WoW aspect-ratio formula (`round(768 × width / height)`).

| Aspect | Presets                                           |
| ------ | ------------------------------------------------- |
| 16:9   | `1280x720`, `1920x1080`, `2560x1440`, `3840x2160` |
| 16:10  | `1440x900`, `1920x1200`, `2560x1600`              |
| 21:9   | `1720x720`, `2580x1080`, `3440x1440`              |
| 4:3    | `800x600`, `1024x768`                             |

Changeable from the preview toolbar. For a non-preset resolution or per-flavor override, set `screenWidth`/`screenHeight` in `scryer.flavorConfigPath` instead — that takes precedence.

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

### `scryer.imageConvertPath`

**Default:** _(auto-detected from PATH)_

Path to `gm` (GraphicsMagick) or `convert` (ImageMagick) used for PNG→TGA conversion when pre-warming workspace SVGs. Scryer auto-detects `gm` then `convert` from `PATH` when this is empty. Set explicitly if the tool is not on `PATH` or you want to pin a specific binary.

### `scryer.tactKeysUrls`

**Default:** `["https://raw.githubusercontent.com/wowdev/TACTKeys/master/WoW.txt"]`

URLs to fetch the community TACT encryption key list from, tried in order. The first successful response is used and cached locally. Scryer re-downloads when the WoW build changes or the cache is older than 7 days.

Set a custom URL if you maintain a private mirror, or add a fallback:

```jsonc
"scryer.tactKeysUrls": [
  "https://your-internal-mirror.example.com/WoW.txt",
  "https://raw.githubusercontent.com/wowdev/TACTKeys/master/WoW.txt"
]
```

### `scryer.atlasCsvUrls`

**Default:** `["https://wago.tools/db2/{table}/csv"]`

URL templates for downloading atlas table CSV exports. `{table}` is replaced with the table name (e.g. `UiTextureAtlas`). URLs are tried in order; if all fail, Scryer shows an error notification.

The DB2 read path (reading atlas data directly from CASC without a network request) is preferred when `scryer.installDir` is configured. These URLs are only used as a fallback.

```jsonc
"scryer.atlasCsvUrls": [
  "https://wago.tools/db2/{table}/csv",
  "https://your-mirror.example.com/db2/{table}/csv"
]
```

---

## Startup Preloading

### `scryer.startupContent`

**Default:** `all-templates-shared-textures`

What Blizzard template and asset content Scryer loads when the extension activates.

| Value                           | Description                                                         | Size    | Time |
| ------------------------------- | ------------------------------------------------------------------- | ------- | ---- |
| `none`                          | Nothing preloaded                                                   | —       | —    |
| `shared-templates`              | `Blizzard_SharedXML` templates only                                 | ~2.1 MB | —    |
| `all-templates`                 | All Blizzard addon templates                                        | ~41 MB  | —    |
| `all-templates-shared-textures` | All templates + decodes shared BLPs to PNG cache (all three addons) | ~2.4 MB | ~15s |
| `all-templates-textures`        | All templates + full Blizzard texture tree                          | ~452 MB | ~40s |

Tiers are cumulative — selecting a higher tier includes all content from the lower tiers.

### `scryer.userAddonPreload`

**Default:** `current-file`

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

| Field              | Default                               | Description                                                                                                                                                          |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screenWidth`      | `1920`                                | Physical monitor width in pixels — determines UIParent aspect ratio                                                                                                  |
| `screenHeight`     | `1080`                                | Physical monitor height in pixels                                                                                                                                    |
| `uiParentHeight`   | `768`                                 | WoW UIParent logical height (fixed by the engine; rarely changed)                                                                                                    |
| `defaultFont`      | `Fonts/FRIZQT__.TTF`                  | WoW-relative path to the default font file                                                                                                                           |
| `defaultFontSize`  | `12`                                  | Default font size when none is specified                                                                                                                             |
| `defaultFontFlags` | _(empty)_                             | WoW font rendering flags (e.g. `OUTLINE`, `THICKOUTLINE`)                                                                                                            |
| `defaultTextColor` | `{ r: 1.0, g: 0.82, b: 0.0, a: 1.0 }` | Default FontString color — WoW gold                                                                                                                                  |
| `frameScale`       | `1.0`                                 | Global scale applied to the preview viewport (CSS transform)                                                                                                         |
| `sandboxTimeout`   | `5000`                                | Per-call Lua execution timeout (ms). Kills any single `doString` call that exceeds this limit — prevents infinite loops from hanging VS Code. Set to `0` to disable. |

### Rendering calibration fields

These fields tune how closely the browser preview approximates WoW's actual text rendering. The built-in values are calibrated for the default FRIZQT\_\_.TTF font at standard DPI. If you change `defaultFont`, you may need to adjust these.

| Field               | Default         | Description                                                                                           |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `fontLetterSpacing` | `"0.033em"`     | CSS `letter-spacing` to compensate for WoW DirectWrite wider advance widths vs the browser's renderer |
| `autoFontSizeRatio` | `0.75`          | Fallback font size when no explicit size is set: `height × ratio`                                     |
| `fontSmoothing`     | `"antialiased"` | CSS `-webkit-font-smoothing` value. `antialiased` matches WoW's DirectWrite grayscale AA              |

> For preview chrome appearance (ruler colors, viewport background, status bar, placeholder tiles, layout solver parameters), see [advancedConfiguration.md](./advancedConfiguration.md).
