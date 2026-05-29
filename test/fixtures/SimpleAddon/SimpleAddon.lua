-- SimpleAddon.lua
-- Lua file in the TOC load sequence. Runs after SimpleAddon.xml is processed.

SimpleAddonLuaLoaded = true

-- Access the XML-defined frame by name
if SimpleAddonFrame then
  SimpleAddonFrame:SetSize(500, 350)
  SimpleAddonLuaModifiedFrame = true
end

-- Register another event listener from Lua
local f = CreateFrame("Frame", "SimpleAddonLuaFrame")
f:RegisterEvent("ADDON_LOADED")
f:SetScript("OnEvent", function(self, event, arg1)
  if event == "ADDON_LOADED" and arg1 == "SimpleAddon" then
    SimpleAddonLuaEventFired = true
  end
end)
