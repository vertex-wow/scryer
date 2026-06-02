import type { LuaEngine } from "wasmoon";

import { C_ScriptedAnimations } from "./retail/C_ScriptedAnimations.js";
import { C_UIColor } from "./retail/C_UIColor.js";
import { C_CurveUtil } from "./retail/C_CurveUtil.js";
import { registerC_Texture } from "./retail/C_Texture.js";

export interface WowApiOverrideOpts {
  /** Atlas manifest for C_Texture.GetAtlasInfo. */
  atlasManifest?: Record<
    string,
    {
      x: number;
      y: number;
      width: number;
      height: number;
      sheetW: number;
      sheetH: number;
      tilesH: boolean;
      tilesV: boolean;
    }
  > | null;
}

const _retailLua = [C_ScriptedAnimations, C_UIColor, C_CurveUtil].join("\n");

export async function registerOverrides(
  lua: LuaEngine,
  _flavor: "retail" | "classic" | "classic_era",
  opts: WowApiOverrideOpts,
): Promise<void> {
  await lua.doString(_retailLua);
  await registerC_Texture(lua, opts.atlasManifest);
}
