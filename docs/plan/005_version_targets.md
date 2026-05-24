# Milestone 5 — Multi-Version Target Runtimes

## Goal

Support multiple WoW game flavors as selectable per-project targets that swap which API stubs are present, validate TOC interface versions, and route to the correct WoW install/asset directory.

## WoW Flavor Model

**Source of truth: `_reference/vscode-wow-api/src/data/flavor.ts`** (MIT licensed, 7218 entries).

ketho.wow-api uses a bitflag system where each API function is mapped to the flavors it exists in:

```ts
// flavor bits:
mainline = 0x1; // Retail / The War Within (current)
mists = 0x2; // Mists of Pandaria Classic (current Classic-progression client)
bcc = 0x4; // Burning Crusade Classic
classic_era = 0x8; // Classic Era (perpetual)
```

An API function is available for a target flavor if: `(flavor.data[apiName] & targetBit) !== 0`

**Important:** The Classic-progression flavor (`mists` today, previously `bcc`, previously Cataclysm) **rotates with Blizzard's seasonal schedule**. The `flavor.ts` file reflects the currently-live clients. Keeping it current is an ongoing maintenance item — when a new Classic expansion launches, the mists/bcc bits shift or a new bit is added.

**Previous plan used `"cata"` as a flavor name — this is now obsolete.** Cataclysm Classic is no longer a live client. Do not hard-code "cata" as a target.

## Approach

1. Define a per-workspace target config at `.scryer/target.json`.
2. Map target flavor bit → which API stubs are present (via `flavor.ts` mask) + asset dir.
3. Validate the loaded `.toc` `## Interface:` list against the active target; warn on mismatch.
4. Expose selection via VSCode settings + a status-bar picker command.

## Config Format

`.scryer/target.json` (workspace-local):

```json
{
  "name": "The War Within",
  "flavor": "mainline",
  "interfaceVersion": 120000,
  "wowInstallDir": "/path/to/World of Warcraft/_retail_",
  "extractedAssetsDir": "/path/to/extracted/retail"
}
```

| Field                | Type                                                              | Description                                                    |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `name`               | string                                                            | Display name for the status bar                                |
| `flavor`             | `"mainline"` \| `"mists"` \| `"bcc"` \| `"classic_era"` \| custom | Selects the flavor bitflag for API availability                |
| `interfaceVersion`   | number                                                            | Primary interface version for TOC validation and asset routing |
| `wowInstallDir`      | string                                                            | Optional override for global `scryer.installDir`               |
| `extractedAssetsDir` | string                                                            | Optional override for global `scryer.extractedAssetsDir`       |

## API Availability Model

**Do NOT hand-author global allowlists per profile.** Use `flavor.ts` as the availability oracle:

```ts
import { data as flavorData } from "_reference/vscode-wow-api/src/data/flavor";
const FLAVOR_BITS = { mainline: 0x1, mists: 0x2, bcc: 0x4, classic_era: 0x8 };

function isAvailable(apiName: string, flavor: keyof typeof FLAVOR_BITS): boolean {
  const entry = flavorData[apiName];
  if (entry === undefined) return false;
  return (entry & FLAVOR_BITS[flavor]) !== 0;
}
```

At sandbox init, for a given target flavor, iterate `globalapi.ts` (261 C\_\* namespaces + top-level globals) and install only the functions available for that flavor. Everything else is absent or returns a "not available in this version" warning stub.

**Note:** `flavor.ts` is a _presence_ table only — not behavioral differences. Some APIs exist in all flavors but behave differently (e.g., `GetContainerItemInfo` vs `C_Container.GetContainerItemInfo` semantics). Keep the "wide shallow stub returns nil" fallback for anything not in the table.

**Deprecated functions:** Functions in `deprecated.ts` (deprecated since 10.0.0) have their `mainline` bit cleared in `flavor.ts` but Classic bits set. They are still stubbed for Classic targets — the flavor model handles this automatically. No separate deprecated list needed.

## Flavor → Interface Version Mapping

| Flavor        | Representative interface versions | Notes                                           |
| ------------- | --------------------------------- | ----------------------------------------------- |
| `mainline`    | 110000+                           | Increments with each patch                      |
| `mists`       | ~50500–50599                      | MoP Classic (current progression) — will change |
| `bcc`         | ~20504                            | Burning Crusade Classic                         |
| `classic_era` | 11500–11599                       | Perpetual 1.x Classic                           |

TOC validation: if the active target's `interfaceVersion` is not in the TOC's `## Interface:` list → warn + offer to switch target.

## VSCode Settings Integration

```jsonc
// Global (user settings)
"scryer.installDir": "",
"scryer.defaultFlavor": "mainline",

// Workspace-level override lives in .scryer/target.json
```

**Status-bar item:** shows `⚔ mainline 120000`. Click → quick-pick to switch flavor. Switching triggers re-run/hot-reload.

## Custom / User-Defined Targets

```
.scryer/
  target.json           ← active target
  targets/
    ptr-120500.json     ← PTR / beta builds
```

Custom targets reference a known flavor bit + interface version. Unknown flavor IDs default to the closest known flavor.

## Key Technical Decisions

- **Bitflag availability from `flavor.ts`** — not hand-authored global lists. Keeps API presence in sync with ketho's maintained data source.
- **Single IR across flavors** — only stub set + asset dir differs. No re-parsing on target switch.
- **Workspace `.scryer/target.json` overrides global settings** — teams can commit a shared target.

## Foreseen Hurdles

- **Rotating Classic-progression flavor** — pin a versioned copy of `flavor.ts` to avoid surprise changes when the Classic season advances. Track which ketho release was used.
- **Behavioral differences not in `flavor.ts`** — presence ≠ identical behavior. Out of scope for M5; document when discovered.
- **Atlas/asset availability differs by flavor** — per-flavor `extractedAssetsDir` in target config handles this.
- **Interface version granularity** — `interfaceVersion` is for asset routing and TOC validation; `flavor` is the API availability axis. Keep them separate fields.

## Dependencies

**M4** (sandbox consumes flavor profile); **M3** (per-flavor asset dir).

## Rough Effort

**S–M** — the bitflag model eliminates manifest-authoring work. Main cost is status-bar picker, settings wiring, and TOC validation.
