// orphan guard: if the generated stub is removed, this import breaks at compile time
import "../../api-stubs/retail/C_Texture.js";
import type { LuaEngine } from "wasmoon";

interface AtlasEntry {
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sheetW: number;
  sheetH: number;
  tilesH: boolean;
  tilesV: boolean;
  logicalW: number;
  logicalH: number;
}

// Always overridden so NineSlice and similar code get a truthy result for any
// non-empty atlas name (allowing SetAtlas to be called).
// WoW atlas names may carry _/! tiling-hint prefixes that are stripped before lookup.
// With manifest: returns full WoW-compatible info table.
// Without manifest: returns minimal {tilesHorizontally, tilesVertically}.
export async function registerC_Texture(
  lua: LuaEngine,
  atlasManifest: Record<string, AtlasEntry> | null | undefined,
): Promise<void> {
  const manifest = atlasManifest ?? null;
  lua.global.set("__scryer_atlas_getinfo", (name: unknown) => {
    if (typeof name !== "string" || !name) return;
    const origLower = name.toLowerCase();
    const stripped = name.replace(/^[_!]+/, "");
    const strippedLower = stripped.toLowerCase();
    // _ prefix means tile horizontally, ! means tile vertically
    const prefixTilesH = name.startsWith("_");
    const prefixTilesV = name.startsWith("!");
    if (manifest) {
      let entry = manifest[origLower] ?? manifest[stripped] ?? manifest[strippedLower];
      let scaleDivisor = 1;
      if (!entry) {
        entry = manifest[origLower + "-2x"] ?? manifest[strippedLower + "-2x"];
        if (entry) {
          // Use the DB2 OverrideWidth to derive the exact divisor when available;
          // fall back to ÷2 for -2x entries that carry no override.
          scaleDivisor = entry.logicalW > 0 ? entry.width / entry.logicalW : 2;
        }
      }
      if (entry) {
        const { x, y, width, height, sheetW, sheetH, tilesH, tilesV } = entry;
        const d = scaleDivisor;
        return {
          tilesHorizontally: tilesH || prefixTilesH,
          tilesVertically: tilesV || prefixTilesV,
          width: width / d,
          height: height / d,
          leftTexCoord: x / sheetW,
          rightTexCoord: (x + width) / sheetW,
          topTexCoord: y / sheetH,
          bottomTexCoord: (y + height) / sheetH,
        };
      }
    }
    return { tilesHorizontally: prefixTilesH, tilesVertically: prefixTilesV };
  });
  await lua.doString(`do
    local _getinfo = __scryer_atlas_getinfo
    C_Texture.GetAtlasInfo = function(name)
      return _getinfo(name)
    end
    __scryer_atlas_getinfo = nil
  end`);
}
