# Scryer — World of Warcraft Addon Preview

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Install-blue?logo=visualstudiocode)](MARKETPLACE_LINK_PLACEHOLDER)

> Preview WoW addon UI frames directly in your editor — no game client required.

---

## Overview

Scryer is a VS Code extension that renders World of Warcraft addon XML frame definitions in a live webview panel beside your editor. Open any addon `.xml` file, click the preview button, and see your frames laid out with correct WoW anchor positioning, template inheritance, and textures — without launching the game.

**Current capabilities:**

- Parse and resolve WoW XML frame definitions including template inheritance
- Lay out frames using WoW's anchor/offset system (all `$parent` relative anchors supported)
- Render textures decoded from BLP files extracted from your WoW installation
- Load Blizzard's shared and FrameXML template corpus for accurate `DefaultPanel`, `UIPanelButton`, and similar templates
- Support Retail, Classic, and Classic Era flavors with per-flavor display defaults

> **Note:** Lua execution and hot-reload are not yet implemented — Scryer currently previews the XML layout only. See [docs/plan/000_overview.md](docs/plan/000_overview.md) for the full roadmap.

---

## Installation

**[Install from the VS Code Marketplace →](MARKETPLACE_LINK_PLACEHOLDER)**

Or search for **"Scryer"** in the VS Code Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).

### Recommended companion extension

Install [**ketho.wow-api**](https://marketplace.visualstudio.com/items?itemName=ketho.wow-api) alongside Scryer. It provides Lua language server completions for the WoW API — Scryer handles runtime preview, ketho handles editor-time completions. The two are complementary.

---

## Quick Start

1. Open any WoW addon `.xml` file.
2. Click the **Open WoW Preview** button ($(open-preview)) in the editor title bar, or run **Scryer: Open WoW Preview** from the Command Palette (`Ctrl+Shift+P`).
3. A preview panel opens beside your editor showing the rendered frames.

For textures to appear, you need to point Scryer at your WoW installation. See [Asset Setup](#asset-setup) below.

---

## Commands

| Command                      | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| **Scryer: Open WoW Preview** | Open the preview panel for the active XML file          |
| **Scryer: Select Flavor**    | Switch between Retail, Classic, and Classic Era flavors |

The **Open WoW Preview** button also appears in the Explorer and editor title context menus when an XML file is selected.

---

## Asset Setup

Textures are loaded from your WoW installation. Scryer does not ship game assets.

Set `scryer.installDir` to your WoW root folder — the directory that contains `_retail_/`, `_classic_/`, and `.build.info`. Example:

```jsonc
// .vscode/settings.json
{
  "scryer.installDir": "/path/to/World of Warcraft",
}
```

Scryer uses an external CASC extraction tool to pull BLP textures from the game archives on demand. The tool is auto-detected from `PATH`; set `scryer.cascToolPath` if yours is in a non-standard location.

Extracted textures are cached as PNGs so subsequent previews load instantly. The cache location defaults to VS Code's global storage (shared across workspaces). See [Configuration](#configuration) to change this.

---

## Configuration

The key defaults out of the box:

| Setting                   | Default     | Description                                                       |
| ------------------------- | ----------- | ----------------------------------------------------------------- |
| `scryer.flavor`           | `retail`    | WoW flavor for asset extraction                                   |
| `scryer.cacheLocation`    | `global`    | Cache stored in VS Code global storage (shared across workspaces) |
| `scryer.startupContent`   | `none`      | Nothing preloaded at startup                                      |
| `scryer.userAddonPreload` | `on-demand` | Textures resolved when the webview requests them                  |

For the complete settings reference — cache options, per-flavor display overrides, CASC tool paths, preload tiers, and more — see **[docs/configuration.md](docs/configuration.md)**.

---

## Flavor Display Defaults

Each flavor uses a built-in set of display defaults — they work out of the box for a standard 1080p setup:

| Property    | Default                |
| ----------- | ---------------------- |
| Screen      | 1920 × 1080            |
| UIParent    | 1365 × 768             |
| Font        | `Fonts/FRIZQT__.TTF`   |
| Font size   | 12                     |
| Text color  | WoW gold (255, 209, 0) |
| Frame scale | 1.0                    |

Override any of these per-flavor by pointing `scryer.flavorConfigPath` at a JSON file. See [docs/configuration.md#per-flavor-display-overrides](docs/configuration.md#per-flavor-display-overrides) for the fields and format.

For advanced customization — viewport background, ruler colors, status bar, placeholder appearance, and layout solver parameters — see [docs/advancedConfiguration.md](docs/advancedConfiguration.md).

---

## Supported WoW Versions

| Flavor            | Setting value |
| ----------------- | ------------- |
| Retail (Mainline) | `retail`      |
| Classic (MoP)     | `classic`     |
| Classic Era       | `classic_era` |

Switch flavors at any time with **Scryer: Select Flavor** or by changing `scryer.flavor` in settings.

---

## License

[AGPL-3.0](./LICENSE) — Maintained by the [Vertex WoW Community](https://github.com/vertex-wow) and [Vertex Industries](https://github.com/vertex-industries).
