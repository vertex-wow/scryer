-- ApiStubsAddon.lua
-- Exercises all stubs added in M019 (3rd-party addon API gap analysis).
-- If any call below crashes the sandbox the test spec will catch it via the
-- errors collector. Non-crashing wrong return values are checked in the spec
-- by reading named globals exposed through frame attributes.

-- ── Key modifier states ──────────────────────────────────────────────────────
local shift = IsShiftKeyDown()
local ctrl  = IsControlKeyDown()
local alt   = IsAltKeyDown()
local meta  = IsMetaKeyDown()

-- ── Combat ───────────────────────────────────────────────────────────────────
local inCombat = InCombatLockdown()

-- ── Unit queries ─────────────────────────────────────────────────────────────
local pName, pRealm = UnitName("player")
local guid           = UnitGUID("player")
local class, token   = UnitClass("player")
local exists         = UnitExists("player")
local isUnit         = UnitIsUnit("player", "player")
local faction        = UnitFactionGroup("player")
local hp             = UnitHealth("player")
local hpMax          = UnitHealthMax("player")
local dead           = UnitIsDeadOrGhost("player")
local isPlayer       = UnitIsPlayer("player")
local level          = UnitLevel("player")
local fullName       = UnitFullName("player")
local power          = UnitPower("player")
local powerMax       = UnitPowerMax("player")
local unitRealm      = UnitRealm("player")   -- removed API → nil

-- ── Game state ───────────────────────────────────────────────────────────────
local build          = GetBuildInfo()
local serverTime     = GetServerTime()
local preciseTime    = GetTimePreciseSec()
local groupMembers   = GetNumGroupMembers()
local subMembers     = GetNumSubgroupMembers()
local realmName      = GetRealmName()
local inInstance     = IsInInstance()
local zone           = GetZoneText()
local subZone        = GetSubZoneText()
local miniZone       = GetMinimapZoneText()
local realZone       = GetRealZoneText()
local inWorld        = IsPlayerInWorld()
local onTaxi         = UnitOnTaxi("player")

-- ── Cursor ───────────────────────────────────────────────────────────────────
ClearCursor()
local cx, cy   = GetCursorPosition()
local cursorInfo = GetCursorInfo()
DeleteCursorItem()

-- ── Removed APIs (nil stubs — must not crash) ────────────────────────────────
local _ = GetAchievementCriteriaInfo(1, 1)
local _ = GetAchievementInfo(1)
local _ = GetSpellInfo(1)
local _ = GetSpellBookItemName(1, "SPELL")
local _ = UnitBuff("player", 1)
local _ = UnitDebuff("player", 1)
local _ = UnitAura("player", 1)
local _ = GetTalentInfo(1, 1, 1)
local _ = GetNumTalents(1)
local _ = GetSpecialization()   -- removed

-- ── Category B: Blizzard Lua namespace stubs ─────────────────────────────────
if MenuUtil then
  MenuUtil.CreateContextMenu(UIParent, function() end)
  MenuUtil.CreateRadioMenu(UIParent, {})
end
if Menu then
  Menu.ModifyMenu("MENU_TYPE", function() end)
  Menu.GetManager()
end
if AuraUtil then
  AuraUtil.ForEachAura("player", "HELPFUL", nil, function() end)
  AuraUtil.FindAura("player", "TestAura", "HELPFUL")
end

-- ── StatusBar fill ───────────────────────────────────────────────────────────
local bar = CreateFrame("StatusBar", "ApiStubsBar", UIParent)
bar:SetSize(200, 20)
bar:SetPoint("CENTER")
bar:SetMinMaxValues(0, 100)
bar:SetValue(75)
bar:SetStatusBarColor(0, 0.5, 1, 1)

-- Store sampled return values as attributes so the spec can inspect them.
bar:SetAttribute("pName",        pName)
bar:SetAttribute("guid",         guid)
bar:SetAttribute("inCombat",     inCombat)
bar:SetAttribute("exists",       exists)
bar:SetAttribute("isUnit",       isUnit)
bar:SetAttribute("hp",           hp)
bar:SetAttribute("hpMax",        hpMax)
bar:SetAttribute("dead",         dead)
bar:SetAttribute("groupMembers", groupMembers)
bar:SetAttribute("realmName",    realmName)
bar:SetAttribute("inInstance",   inInstance)
bar:SetAttribute("inWorld",      inWorld)
bar:SetAttribute("build",        build)
bar:SetAttribute("shift",        shift)
