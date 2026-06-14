import { type LuaEngine } from "wasmoon";

import { registerStubs } from "./api-stubs/index.js";
import { registerOverrides } from "./api/index.js";

// ─── C_* namespace names ──────────────────────────────────────────────────────
// Sourced from _reference/vscode-wow-api/src/data/globalapi.ts.
// C_Timer is excluded here — it is registered as a real implementation below.
const C_NAMESPACES = [
  "C_AccountInfo",
  "C_AccountServices",
  "C_AccountStore",
  "C_AchievementInfo",
  "C_AchievementTelemetry",
  "C_ActionBar",
  "C_AddOnProfiler",
  "C_AddOns",
  "C_AdventureJournal",
  "C_AdventureMap",
  "C_AlliedRaces",
  "C_AnimaDiversion",
  "C_ArdenwealdGardening",
  "C_AreaPoiInfo",
  "C_ArrowCalloutManager",
  "C_ArtifactUI",
  "C_AssistedCombat",
  "C_AuctionHouse",
  "C_AzeriteEmpoweredItem",
  "C_AzeriteEssence",
  "C_AzeriteItem",
  "C_Bank",
  "C_BarberShop",
  "C_BattleNet",
  "C_BehavioralMessaging",
  "C_BlackMarket",
  "C_Calendar",
  "C_CampaignInfo",
  "C_ChallengeMode",
  "C_CharacterServices",
  "C_CharacterServicesPublic",
  "C_ChatBubbles",
  "C_ChatInfo",
  "C_ChromieTime",
  "C_ClassColor",
  "C_ClassTalents",
  "C_ClassTrial",
  "C_ClickBindings",
  "C_Club",
  "C_ClubFinder",
  "C_ColorOverrides",
  "C_Commentator",
  "C_ConsoleScriptCollection",
  "C_Container",
  "C_ContentTracking",
  "C_ContributionCollector",
  "C_CooldownViewer",
  "C_CovenantCallings",
  "C_CovenantPreview",
  "C_Covenants",
  "C_CovenantSanctumUI",
  "C_CraftingOrders",
  "C_CreatureInfo",
  "C_CurrencyInfo",
  "C_Cursor",
  "C_CurveUtil",
  "C_CVar",
  "C_DateAndTime",
  "C_DeathInfo",
  "C_Debug",
  "C_DelvesUI",
  "C_EditMode",
  "C_EncodingUtil",
  "C_EncounterJournal",
  "C_EndOfMatchUI",
  "C_EquipmentSet",
  "C_EventScheduler",
  "C_EventToastManager",
  "C_EventUtils",
  "C_ExpansionTrial",
  "C_FogOfWar",
  "C_FrameManager",
  "C_FriendList",
  "C_FunctionContainers",
  "C_GamePad",
  "C_GameRules",
  "C_Garrison",
  "C_GenericWidgetDisplay",
  "C_Glue",
  "C_GossipInfo",
  "C_GuildBank",
  "C_GuildInfo",
  "C_Heirloom",
  "C_HeirloomInfo",
  "C_ImmersiveInteraction",
  "C_IncomingSummon",
  "C_InstanceLeaver",
  "C_InterfaceFileManifest",
  "C_InvasionInfo",
  "C_IslandsQueue",
  "C_Item",
  "C_ItemInteraction",
  "C_ItemSocketInfo",
  "C_ItemUpgrade",
  "C_KeyBindings",
  "C_LegendaryCrafting",
  "C_LevelLink",
  "C_LevelSquish",
  "C_LFGInfo",
  "C_LFGList",
  "C_LobbyMatchmakerInfo",
  "C_Log",
  "C_Loot",
  "C_LootHistory",
  "C_LootJournal",
  "C_LoreText",
  "C_LossOfControl",
  "C_Macro",
  "C_Mail",
  "C_MajorFactions",
  "C_Map",
  "C_MapExplorationInfo",
  "C_MerchantFrame",
  "C_Minimap",
  "C_ModelInfo",
  "C_ModifiedInstance",
  "C_MountJournal",
  "C_MythicPlus",
  "C_NamePlate",
  "C_Navigation",
  "C_NewItems",
  "C_PaperDollInfo",
  "C_PartyInfo",
  "C_PartyPose",
  "C_PerksActivities",
  "C_PerksProgram",
  "C_PetBattles",
  "C_PetInfo",
  "C_PetJournal",
  "C_Ping",
  "C_PlayerChoice",
  "C_PlayerInfo",
  "C_PlayerInteractionManager",
  "C_PlayerMentorship",
  "C_ProfSpecs",
  "C_PrototypeDialog",
  "C_PvP",
  "C_QuestHub",
  "C_QuestInfoSystem",
  "C_QuestItemUse",
  "C_QuestLine",
  "C_QuestLog",
  "C_QuestOffer",
  "C_QuestSession",
  "C_RaidLocks",
  "C_RecruitAFriend",
  "C_Reincarnation",
  "C_ReportSystem",
  "C_Reputation",
  "C_ResearchInfo",
  "C_ReturningPlayerUI",
  "C_Scenario",
  "C_ScenarioInfo",
  "C_ScrappingMachineUI",
  "C_ScriptedAnimations",
  "C_SeasonInfo",
  "C_SharedCharacterServices",
  "C_SocialQueue",
  "C_SocialRestrictions",
  "C_Soulbinds",
  "C_Sound",
  "C_SpecializationInfo",
  "C_SpectatingUI",
  "C_Spell",
  "C_SpellActivationOverlay",
  "C_SpellBook",
  "C_SplashScreen",
  "C_StableInfo",
  "C_StorePublic",
  "C_SummonInfo",
  "C_SuperTrack",
  "C_System",
  "C_SystemVisibilityManager",
  "C_TalkingHead",
  "C_TaskQuest",
  "C_TaxiMap",
  "C_Texture",
  "C_TooltipComparison",
  "C_TooltipInfo",
  "C_ToyBox",
  "C_ToyBoxInfo",
  "C_TradeInfo",
  "C_TradeSkillUI",
  "C_Traits",
  "C_Transmog",
  "C_TransmogCollection",
  "C_TransmogSets",
  "C_Trophy",
  "C_TTSSettings",
  "C_Tutorial",
  "C_UI",
  "C_UIColor",
  "C_UIWidgetManager",
  "C_UnitAuras",
  "C_UserFeedback",
  "C_VideoOptions",
  "C_VignetteInfo",
  "C_VoiceChat",
  "C_WarbandScene",
  "C_WeeklyRewards",
  "C_Widget",
  "C_WorldLootObject",
  "C_WowLabsDataManager",
  "C_WoWLabsMatchmaking",
  "C_WowTokenPublic",
  "C_WowTokenUI",
  "C_XMLUtil",
  "C_ZoneAbility",
] as const;

// ─── Canonical LibStub ────────────────────────────────────────────────────────

const LIBSTUB_LUA = `
LibStub = LibStub or (function()
  local LibStub = { libs = {}, minors = {} }
  setmetatable(LibStub, {
    __call = function(self, major, silent)
      return self:GetLibrary(major, silent)
    end
  })
  function LibStub:NewLibrary(major, minor)
    assert(type(major) == "string",
      ("Bad argument #1 to 'NewLibrary' (string expected, got %s)"):format(type(major)))
    minor = assert(tonumber(minor),
      ("Bad argument #2 to 'NewLibrary' (number expected, got %s)"):format(type(minor)))
    local oldminor = self.minors[major]
    if oldminor and oldminor >= minor then return nil end
    self.minors[major] = minor
    self.libs[major] = self.libs[major] or {}
    return self.libs[major], oldminor
  end
  function LibStub:GetLibrary(major, silent)
    if not self.libs[major] and not silent then
      error(("Cannot find a library instance of %q."):format(tostring(major)), 2)
    end
    return self.libs[major], self.minors[major]
  end
  function LibStub:IterateLibraries()
    return pairs(self.libs)
  end
  return LibStub
end)()
`;

// ─── Virtual clock ────────────────────────────────────────────────────────────

interface TimerEntry {
  fireAt: number;
  callback: () => void;
  cancelled: boolean;
  interval: number | undefined;
  count: number;
  maxIter: number | undefined;
}

export class VirtualClock {
  private _time = 0;
  private _timers: TimerEntry[] = [];

  now(): number {
    return this._time;
  }

  /** Advance time by `dt` seconds, firing all due timers in chronological order.
   *  Repeating timers can fire multiple times per advance call. */
  advance(dt: number): void {
    const targetTime = this._time + dt;
    while (true) {
      // Find the earliest timer still due within [_time, targetTime]
      let earliest: TimerEntry | undefined;
      for (const t of this._timers) {
        if (!t.cancelled && t.fireAt <= targetTime) {
          if (!earliest || t.fireAt < earliest.fireAt) earliest = t;
        }
      }
      if (!earliest) break;
      this._time = earliest.fireAt;
      earliest.callback();
      if (earliest.interval !== undefined) {
        earliest.fireAt += earliest.interval;
        earliest.count++;
        if (earliest.maxIter !== undefined && earliest.count >= earliest.maxIter) {
          earliest.cancelled = true;
        }
      } else {
        earliest.cancelled = true;
      }
    }
    this._time = targetTime;
    this._timers = this._timers.filter((t) => !t.cancelled);
  }

  /** Schedule a one-shot or repeating callback. Returns a cancellable handle. */
  schedule(
    fireAt: number,
    callback: () => void,
    opts?: { interval?: number; maxIter?: number },
  ): FunctionContainerHandle {
    const entry: TimerEntry = {
      fireAt,
      callback,
      cancelled: false,
      interval: opts?.interval,
      count: 0,
      maxIter: opts?.maxIter,
    };
    this._timers.push(entry);
    return {
      Cancel: () => {
        entry.cancelled = true;
      },
      IsCancelled: () => entry.cancelled,
      Invoke: () => {
        if (!entry.cancelled) entry.callback();
      },
    };
  }
}

/** Shape returned to Lua as a FunctionContainer. */
export interface FunctionContainerHandle {
  Cancel(): void;
  IsCancelled(): boolean;
  Invoke(): void;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dayOfYear(d: Date, utc: boolean): number {
  const start = utc
    ? Date.UTC(d.getUTCFullYear(), 0, 0)
    : new Date(d.getFullYear(), 0, 0).getTime();
  return Math.floor((d.getTime() - start) / 86_400_000);
}

function formatDateStr(pattern: string, d: Date, utc: boolean): string {
  const n = (local: () => number, u: () => number) => (utc ? u() : local());
  const p2 = (x: number) => String(x).padStart(2, "0");
  const p3 = (x: number) => String(x).padStart(3, "0");

  return pattern
    .replace(
      /%Y/g,
      String(
        n(
          () => d.getFullYear(),
          () => d.getUTCFullYear(),
        ),
      ),
    )
    .replace(
      /%y/g,
      p2(
        n(
          () => d.getFullYear(),
          () => d.getUTCFullYear(),
        ) % 100,
      ),
    )
    .replace(
      /%m/g,
      p2(
        n(
          () => d.getMonth() + 1,
          () => d.getUTCMonth() + 1,
        ),
      ),
    )
    .replace(
      /%d/g,
      p2(
        n(
          () => d.getDate(),
          () => d.getUTCDate(),
        ),
      ),
    )
    .replace(
      /%H/g,
      p2(
        n(
          () => d.getHours(),
          () => d.getUTCHours(),
        ),
      ),
    )
    .replace(
      /%I/g,
      p2(
        n(
          () => d.getHours() % 12 || 12,
          () => d.getUTCHours() % 12 || 12,
        ),
      ),
    )
    .replace(
      /%M/g,
      p2(
        n(
          () => d.getMinutes(),
          () => d.getUTCMinutes(),
        ),
      ),
    )
    .replace(
      /%S/g,
      p2(
        n(
          () => d.getSeconds(),
          () => d.getUTCSeconds(),
        ),
      ),
    )
    .replace(/%j/g, p3(dayOfYear(d, utc)))
    .replace(
      /%A/g,
      WEEKDAYS[
        n(
          () => d.getDay(),
          () => d.getUTCDay(),
        )
      ],
    )
    .replace(
      /%a/g,
      WEEKDAYS_SHORT[
        n(
          () => d.getDay(),
          () => d.getUTCDay(),
        )
      ],
    )
    .replace(
      /%B/g,
      MONTHS[
        n(
          () => d.getMonth(),
          () => d.getUTCMonth(),
        )
      ],
    )
    .replace(
      /%b/g,
      MONTHS_SHORT[
        n(
          () => d.getMonth(),
          () => d.getUTCMonth(),
        )
      ],
    )
    .replace(
      /%p/g,
      n(
        () => d.getHours(),
        () => d.getUTCHours(),
      ) < 12
        ? "AM"
        : "PM",
    )
    .replace(/%%/g, "%");
}

function wowDate(fmt: unknown, time: unknown): unknown {
  const d = time != null ? new Date(Number(time) * 1000) : new Date();
  const f = fmt == null ? "%c" : String(fmt);
  const utc = f.startsWith("!");
  const pattern = utc ? f.slice(1) : f;

  if (pattern === "*t") {
    return {
      year: utc ? d.getUTCFullYear() : d.getFullYear(),
      month: (utc ? d.getUTCMonth() : d.getMonth()) + 1,
      day: utc ? d.getUTCDate() : d.getDate(),
      hour: utc ? d.getUTCHours() : d.getHours(),
      min: utc ? d.getUTCMinutes() : d.getMinutes(),
      sec: utc ? d.getUTCSeconds() : d.getSeconds(),
      wday: (utc ? d.getUTCDay() : d.getDay()) + 1,
      yday: dayOfYear(d, utc),
      isdst: false,
    };
  }

  return formatDateStr(pattern, d, utc);
}

// ─── API options ──────────────────────────────────────────────────────────────

export interface WowApiOptions {
  clock: VirtualClock;
  /** WoW flavor for API stub registration. Defaults to "retail". */
  flavor?: "retail" | "classic" | "classic_era";
  /** Receives output from Lua print() and DEFAULT_CHAT_FRAME:AddMessage(). */
  print?: (msg: string) => void;
  /** Returns true if the named addon is considered loaded. Defaults to always-true. */
  isAddonLoaded?: (name: string) => boolean;
  /** Returns TOC metadata for a loaded addon. Defaults to null. */
  getAddonMetadata?: (name: string, key: string) => string | null;
  /** Locale code returned by GetLocale(). Defaults to "enUS". */
  locale?: string;
  /** Atlas manifest for C_Texture.GetAtlasInfo. When provided, atlas lookups return full sprite data. */
  atlasManifest?: Record<
    string,
    {
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
  > | null;
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Inject WoW API stubs into an existing M5 sandbox. Safe to call once per engine.
 */
export async function registerWowApi(lua: LuaEngine, opts: WowApiOptions): Promise<void> {
  const { clock, print = console.log } = opts;

  // ── C_* namespace stubs ──────────────────────────────────────────────────
  // Empty tables with __index returning a stub that explicitly returns nil,
  // so any call to any C_Namespace.Fn() returns nil without raising an error.
  const namespaceLua = C_NAMESPACES.map(
    (ns) =>
      `${ns} = setmetatable({}, { __index = function() return function() return nil end end })`,
  ).join("\n");
  await lua.doString(namespaceLua);

  // Generated stubs (from api-stubs/) layer explicit _nil/_tbl functions on
  // top of the nil-metatable tables above, then manual overrides (api/) replace
  // any stubs that need a real implementation.
  const flavor = opts.flavor ?? "retail";
  await registerStubs(lua, flavor);
  await registerOverrides(lua, flavor, { atlasManifest: opts.atlasManifest });

  // ── WoW C-layer globals ───────────────────────────────────────────────────
  // These are provided by the WoW C layer before any Lua loads.
  // Only things that do NOT exist in any Blizzard Lua file belong here.
  // See docs/decisions/011_blizzard_lua_load_philosophy.md.
  await lua.doString(`
    -- Mixin system — C API; Blizzard_SharedXMLBase/Mixin.lua wraps these but they
    -- must exist first so Mixin.lua itself can capture them as local upvalues.
    function Mixin(t, ...)
      for i = 1, select("#", ...) do
        local m = select(i, ...)
        for k, v in pairs(m) do t[k] = v end
      end
      return t
    end
    function CreateFromMixins(...)
      return Mixin({}, ...)
    end

    -- Security — always non-secure outside the real game client.
    function issecure() return false end
    function issecretvalue() return false end
    function secureexecuterange(tbl, fn, ...)
      for _, v in ipairs(tbl) do fn(v, ...) end
    end
    -- securecallfunction must live in Lua (not JS) so it can propagate multiple
    -- return values. The JS bridge collapses multi-returns to a single value,
    -- which breaks callers like: local a, b = securecallfunction(unpack, t)
    function securecallfunction(fn, ...)
      local t = table.pack(pcall(fn, ...))
      if t[1] then return table.unpack(t, 2, t.n) end
    end

    -- WoW-specific Lua library extensions injected by the C layer.
    table.wipe = function(t) for k in pairs(t) do t[k] = nil end return t end
    wipe = table.wipe
    table.count = function(t) local n = 0; for _ in pairs(t) do n = n + 1 end return n end
    string.trim = function(s) return (s:gsub("^%s*(.-)%s*$", "%1")) end
    strtrim = string.trim

    function strsplit(sep, str, limit)
      local parts, n = {}, 0
      local pat = "([^" .. sep .. "]*)" .. sep .. "?"
      for part in (str .. sep):gmatch("([^" .. sep .. "]+)") do
        n = n + 1
        parts[n] = part
        if limit and n >= limit then break end
      end
      if n == 0 then return str end
      return unpack(parts)
    end
    function strjoin(sep, ...) return table.concat({...}, sep) end

    -- Closure / function utilities (C API).
    function GenerateClosure(fn, ...)
      local args = {...}
      return function(...) return fn(unpack(args), ...) end
    end
    function nop() end

    -- Counter factory (C API). Returns a callable that increments and returns an integer each call.
    function CreateCounter(start)
      local n = (start or 0)
      return function() n = n + 1; return n end
    end

    -- Table utility (C API). Returns tbl[key], creating and storing an empty table if absent.
    function GetOrCreateTableEntry(tbl, key)
      local v = tbl[key]
      if v == nil then v = {}; tbl[key] = v end
      return v
    end

    -- Error / callstack (WoW C debugging internals; no-ops in preview).
    function SetErrorCallstackHeight() end
    function GetCallstackHeight() return 0 end
    function ProcessExceptionClient() end
    function AddSourceLocationExclude() end

    -- Secure template environment accessor (WoW C internal).
    function GetCurrentEnvironment() return _G end

    -- Enum and Constants are populated by the C layer before any addon Lua loads.
    -- Recursive proxy so any depth of indexing returns a consistent sub-table.
    -- Arithmetic metamethods treat any unknown proxy as 0, so Enum.Foo.NumValues - 1
    -- produces -1 (empty for-loop) rather than crashing.
    local function _deep_proxy()
      local mt = {}
      mt.__index = function(t, k)
        local v = _deep_proxy(); rawset(t, k, v); return v
      end
      local function _n(x) return type(x) == "number" and x or 0 end
      mt.__add = function(a, b) return _n(a) + _n(b) end
      mt.__sub = function(a, b) return _n(a) - _n(b) end
      mt.__mul = function(a, b) return _n(a) * _n(b) end
      mt.__div = function(a, b) local bn = _n(b); return bn ~= 0 and _n(a) / bn or 0 end
      mt.__unm = function(a) return 0 end
      mt.__mod = function(a, b) local bn = _n(b); return bn ~= 0 and _n(a) % bn or 0 end
      return setmetatable({}, mt)
    end
    Enum = _deep_proxy()
    Constants = _deep_proxy()

    -- Game state C APIs — return fixed values for the static preview context.
    function UnitRace() return "Human", "Human" end
    function UnitSex() return 2 end
    function GetLocale() return "${opts.locale ?? "enUS"}" end

    -- SlashCmdList is a C-layer-seeded global; addons append to it.
    if SlashCmdList == nil then SlashCmdList = {} end

  `);

  // ── Priority globals ─────────────────────────────────────────────────────
  lua.global.set("GetTime", () => clock.now());
  lua.global.set("date", wowDate);

  const printFn = (...args: unknown[]) =>
    print(args.map((v) => (v == null ? "nil" : String(v))).join("\t"));
  lua.global.set("print", printFn);

  // Chat frame — built as a real Lua table so :AddMessage(...) colon-call works
  // correctly. wasmoon binds JS proxy methods to `this`, stripping Lua's `self`
  // from the argument list; a Lua wrapper avoids that.
  // The do...end block captures the helper in a local upvalue before nil-ing
  // the global, so the closure keeps working after cleanup.
  lua.global.set("__scryer_dcf_print", (msg: unknown) => print(msg == null ? "nil" : String(msg)));
  await lua.doString(`do
    local _p = __scryer_dcf_print
    DEFAULT_CHAT_FRAME = { AddMessage = function(_, msg) _p(msg) end }
    __scryer_dcf_print = nil
  end`);

  lua.global.set("IsAddOnLoaded", (name: string) =>
    opts.isAddonLoaded ? opts.isAddonLoaded(name) : true,
  );
  lua.global.set("GetAddOnMetadata", (name: string, key: string) => {
    if (!opts.getAddonMetadata) return; // undefined → Lua nil
    const val = opts.getAddonMetadata(name, key);
    return val ?? undefined; // null → undefined → Lua nil (avoid wasmoon null crash)
  });

  // Safe-call wrappers — WoW's versions suppress errors; ours forward return values
  lua.global.set("securecall", (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => {
    try {
      return fn(...args);
    } catch {
      // swallow
    }
  });
  // securecallfunction is defined in Lua (see the doString block above) so it
  // can propagate multiple return values — JS functions cannot do this.

  // Stubs for hook/error globals — non-functional but prevent nil crashes
  lua.global.set("hooksecurefunc", () => {});
  lua.global.set("geterrorhandler", () => {});
  lua.global.set("seterrorhandler", () => {});

  // ── LibStub ──────────────────────────────────────────────────────────────
  await lua.doString(LIBSTUB_LUA);

  // ── C_Timer ──────────────────────────────────────────────────────────────
  // Built as a real Lua table (not a JS proxy) so type(C_Timer) == "table".
  // JS helpers are captured as local upvalues before the globals are cleared.
  lua.global.set("__scryer_timer_after", (seconds: number, fn: () => void) =>
    clock.schedule(clock.now() + seconds, fn),
  );
  lua.global.set("__scryer_timer_ticker", (interval: number, fn: () => void, iterations?: number) =>
    clock.schedule(clock.now() + interval, fn, { interval, maxIter: iterations ?? 10_000 }),
  );
  await lua.doString(`do
    local _after = __scryer_timer_after
    local _ticker = __scryer_timer_ticker
    C_Timer = {
      After     = function(s, fn)        return _after(s, fn)        end,
      NewTicker = function(iv, fn, iter) return _ticker(iv, fn, iter) end,
      NewTimer  = function(s, fn)        return _after(s, fn)        end,
    }
    __scryer_timer_after  = nil
    __scryer_timer_ticker = nil
  end`);

  // ── Faction color stubs ──────────────────────────────────────────────────
  // C-layer-populated color constants needed by SharedColorConstants.lua.
  // These are global color objects that WoW creates before any Lua loads.
  // Stub implementation with minimal methods needed by Blizzard code.
  await lua.doString(`do
    local function CreateStubColor(r, g, b, a)
      local color = {}
      color.r = r
      color.g = g
      color.b = b
      color.a = a or 1
      
      function color:GetRGB()
        return self.r, self.g, self.b
      end
      
      function color:GetRGBA()
        return self.r, self.g, self.b, self.a
      end
      
      function color:GenerateHexColor()
        local r = math.floor(self.r * 255)
        local g = math.floor(self.g * 255)
        local b = math.floor(self.b * 255)
        return string.format("%02x%02x%02x", r, g, b)
      end
      
      return color
    end
    
    -- Faction color constants (C-layer populated in real WoW)
    PLAYER_FACTION_COLOR_ALLIANCE = CreateStubColor(0.0, 0.678, 0.941, 1.0)
    PLAYER_FACTION_COLOR_HORDE = CreateStubColor(1.0, 0.161, 0.204, 1.0)
  end`);

  // ── Event listener registry ───────────────────────────────────────────────
  // Initialized here so frame-class.lua can capture it as a local upvalue.
  // frame-class.lua populates it via RegisterEvent/UnregisterEvent.
  // toc-runner uses __scryer_fire_event (defined in frame-class.lua) to dispatch.
  await lua.doString("__scryer_event_listeners = {}");
}
