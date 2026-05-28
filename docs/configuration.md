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

### `scryer.extractScriptPath`

**Default:** _(auto-detected)_

Path to the extraction shell script. Defaults to `dev/extract.sh` in the workspace root. Leave empty for auto-detection.

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

### `scryer.logLevel`

**Default:** `warning`

Controls how much diagnostic output Scryer writes to the **Scryer** Output channel (`View > Output`, then select "Scryer" from the dropdown).

| Value     | Output                                                           |
| --------- | ---------------------------------------------------------------- |
| `off`     | No output                                                        |
| `trace`   | All messages including trace-level diagnostics                   |
| `debug`   | Verbose diagnostics, corpus stats, template chains               |
| `info`    | Info and above                                                   |
| `warning` | Unknown templates, missing assets, resolution failures (default) |
| `error`   | Errors only                                                      |

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

Path to a JSON file that overrides per-flavor display defaults. Merged on top of the built-in config — later layers win per key. The merge order is:

```
built-in default → built-in per-flavor → user default → user per-flavor
```

The file must match the shape of the built-in `src/flavors/defaults.json`:

```jsonc
{
  "default": {
    "uiParentWidth": 1920,
    "uiParentHeight": 1080,
    "defaultFont": "Fonts/FRIZQT__.TTF",
    "defaultFontSize": 12,
    "defaultFontFlags": "",
    "defaultTextColor": { "r": 1.0, "g": 0.82, "b": 0.0, "a": 1.0 },
    "frameScale": 1.0,
  },
  "retail": {},
  "classic": {},
  "classic_era": {},
}
```

Only include the keys you want to override — omitted keys fall through to the built-in value. Flavor-specific blocks (e.g. `"retail": { "uiParentWidth": 2560 }`) override the `"default"` block for that flavor only.

**Built-in defaults for all flavors:**

| Property           | Default                                          |
| ------------------ | ------------------------------------------------ |
| `uiParentWidth`    | `1024`                                           |
| `uiParentHeight`   | `768`                                            |
| `defaultFont`      | `Fonts/FRIZQT__.TTF`                             |
| `defaultFontSize`  | `12`                                             |
| `defaultFontFlags` | _(empty)_                                        |
| `defaultTextColor` | WoW gold — `{ r: 1.0, g: 0.82, b: 0.0, a: 1.0 }` |
| `frameScale`       | `1.0`                                            |
