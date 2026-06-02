// orphan guard: if the generated stub is removed, this import breaks at compile time
import "../../api-stubs/retail/C_ScriptedAnimations.js";

// GetAllScriptedAnimationEffects must return a table (not nil) or scriptedanimationeffects.lua
// crashes on #effectDescriptions at module level.
export const C_ScriptedAnimations = `
C_ScriptedAnimations.GetAllScriptedAnimationEffects = function() return {} end
`;
