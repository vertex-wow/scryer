import type { LuaEngine } from "wasmoon";

import { C_ScriptedAnimations } from "./retail/C_ScriptedAnimations.js";
import { C_UIColor } from "./retail/C_UIColor.js";
import { C_CurveUtil } from "./retail/C_CurveUtil.js";

const _retailLua = [C_ScriptedAnimations, C_UIColor, C_CurveUtil].join("\n");

export async function registerOverrides(
  lua: LuaEngine,
  _flavor: "retail" | "classic" | "classic_era",
): Promise<void> {
  await lua.doString(_retailLua);
}
