# Atlas Scale Factors

## Background

WoW ships two tiers of atlas textures: standard ("1×") and high-DPI ("2×", suffix `-2x` in
Blizzard's atlas manifest). The `-2x` sheets have twice the physical pixel density; their
atlas region coordinates and dimensions must be halved to obtain logical WoW UI unit values.

Our atlas manifest (`scryer-vscode-cache/<flavor>/derived/atlas-manifest.json`) is generated
by extracting from the game CASC. Most atlas families appear only in their `-2x` variant in
this manifest (no corresponding 1× entry). The fallback in both
`src/assets/atlas-manifest.ts` and `src/lua/api/retail/C_Texture.ts` detects that situation
and divides all dimensions by 2 to recover the logical size.

## The DiamondMetal Exception

The DiamondMetal atlas family (`uiframediamondmetal*.blp`) is labeled `-2x` in the manifest
but its physical pixel density is **4× logical**, not 2×. Using the standard ÷2 factor
produces logical sizes that are twice too large; the correct divisor is **4**.

### Evidence

`DialogHeaderTemplate` (in
`_live/wow-ui-source/addons/blizzard_sharedxml/shared/dialog/dialogtemplates.xml`) hard-codes
the size of its DiamondMetal header corners in XML:

```xml
<Texture parentKey="LeftBG" atlas="UI-Frame-DiamondMetal-Header-CornerLeft">
    <Size x="32" y="39"/>
```

The atlas manifest entry for that piece is:

```
ui-frame-diamondmetal-header-cornerleft-2x: 128×156 px
```

`128 ÷ 4 = 32` and `156 ÷ 4 = 39` — an exact match to the explicit XML size.
`128 ÷ 2 = 64` and `156 ÷ 2 = 78` — off by 2×, which is what we got before the fix.

The same factor applies to all DiamondMetal sheets:

| Manifest key (excerpt)                     | Raw px  | ÷2 (wrong) | ÷4 (correct) |
| ------------------------------------------ | ------- | ---------- | ------------ |
| ui-frame-diamondmetal-cornertopleft-2x     | 128×128 | 64×64      | **32×32**    |
| ui-frame-diamondmetal-cornertopright-2x    | 128×128 | 64×64      | **32×32**    |
| \_ui-frame-diamondmetal-edgetop-2x         | 128×128 | 64×64      | **32×32**    |
| !ui-frame-diamondmetal-edgeleft-2x         | 128×128 | 64×64      | **32×32**    |
| ui-frame-diamondmetal-header-cornerleft-2x | 128×156 | 64×78      | **32×39**    |

### Visual confirmation

In the in-game reference screenshot (`example_frame_modal_dialog.png`, 240×160 WoW-unit frame),
pixel measurements give an apparent corner region of ~30–35 screenshot pixels at scale
≈ 1.2 px/WoW-unit → ~25–29 logical WoW units. The ÷4 result (32 units) is consistent;
the ÷2 result (64 units) is not.

## Is This a Blizzard Hack?

Unknown. Blizzard's source does not include a constant or comment explaining why this atlas
family is at a different physical scale. The `DialogHeaderTemplate` simply overrides the size
via `<Size x="32" y="39"/>` in XML, bypassing `useAtlasSize` entirely. For the NineSlice
dialog border (`DialogBorderTemplate`), Blizzard's runtime uses the `C_Texture.GetAtlasInfo`
return value to drive `SetAtlas(name, true)`, which would also yield the wrong 64×64 size
if the standard ÷2 convention were used.

Possibilities:

1. Blizzard's internal CASC export pipeline stores this atlas family at a non-standard scale,
   and WoW's engine has an undocumented per-atlas scale override.
2. The manifest entry is mislabeled as `-2x` when it is actually a `-4x` or ultra-HiDPI export.
3. WoW's engine reads a per-atlas scale metadata field from the BLP file itself that we do
   not extract.

We have not found evidence for any of these. Until a proper mechanism is discovered, Scryer
applies ÷4 to any atlas entry whose BLP file path contains `uiframediamondmetal`.

## Implementation

Both code paths that resolve atlas dimensions apply this rule:

- **`src/assets/atlas-manifest.ts`** — `resolveAtlasInTexture()`, -2x fallback branch
- **`src/lua/api/retail/C_Texture.ts`** — `__scryer_atlas_getinfo`, -2x fallback branch

The detection is file-path-based:

```ts
const isDiamondMetal = entry.file.toLowerCase().includes("uiframediamondmetal");
scaleDivisor = isDiamondMetal ? 4 : 2;
```

Files matched:

- `interface/framegeneral/uiframediamondmetal2x.blp` (body corners + top/bottom edges)
- `interface/framegeneral/uiframediamondmetalvertical2x.blp` (left/right edges)
- `interface/framegeneral/uiframediamondmetalheader2x.blp` (header corners + center tile)

## Other Atlas Families

All other `-2x` atlas entries we have encountered so far correctly use ÷2. For example,
`UI-Frame-Metal-CornerTopLeft` resolves from the 150×150 `-2x` entry to 75×75 logical units,
which is consistent with the `ButtonFrameTemplateNoPortrait` rendering (verified by the
`ExampleFrameTitleFrameAddon` test suite).

If a future atlas family is discovered to have a similar mismatch, add the detection
condition alongside the DiamondMetal check rather than trying to generalise prematurely.
