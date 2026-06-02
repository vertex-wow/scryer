// orphan guard: if the generated stub is removed, this import breaks at compile time
import "../../api-stubs/retail/C_UIColor.js";

// GetColors must return a table or color.lua crashes when iterating it with ipairs.
export const C_UIColor = `
C_UIColor.GetColors = function() return {} end
`;
