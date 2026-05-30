import { type LuaEngine } from "wasmoon";

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
  /** Receives output from Lua print() and DEFAULT_CHAT_FRAME:AddMessage(). */
  print?: (msg: string) => void;
  /** Returns true if the named addon is considered loaded. Defaults to always-true. */
  isAddonLoaded?: (name: string) => boolean;
  /** Returns TOC metadata for a loaded addon. Defaults to null. */
  getAddonMetadata?: (name: string, key: string) => string | null;
  /** Atlas manifest for C_Texture.GetAtlasInfo. When provided, atlas lookups return full sprite data. */
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

  // ── Blizzard SharedXML utilities ─────────────────────────────────────────
  // Pre-stubs for globals used by many Blizzard Lua files. Defined here so
  // files load in order without aborting on first-use errors.
  await lua.doString(`
    -- Texture kit string formatter (TextureUtil.lua)
    function GetFinalNameFromTextureKit(fmt, textureKits)
      if type(textureKits) == "table" then
        return fmt:format(unpack(textureKits))
      else
        return fmt:format(textureKits)
      end
    end

    -- Secure template environment accessor (WoW internal); return _G as a safe stand-in.
    function GetCurrentEnvironment() return _G end

    -- Global enum table; Blizzard code indexes into sub-tables like Enum.ItemQuality.
    -- Use a recursive __index proxy so any depth of access returns an empty table.
    local function _enum_proxy()
      return setmetatable({}, { __index = function(_, k)
        local t = _enum_proxy()
        rawset(_, k, t)
        return t
      end })
    end
    Enum = _enum_proxy()

    -- Enum utility used by scrollbox and friends.
    EnumUtil = {
      MakeEnum = function(...)
        local t = {}
        for i = 1, select('#', ...) do
          local v = select(i, ...)
          t[v] = i - 1
        end
        return t
      end,
    }

    -- Table utilities used by scrollbox.lua.
    function CopyValuesAsKeys(t)
      local r = {}
      for _, v in pairs(t) do r[v] = v end
      return r
    end
    function CopyTable(t, deep)
      local r = {}
      for k, v in pairs(t) do
        r[k] = (deep and type(v) == "table") and CopyTable(v, true) or v
      end
      return r
    end

    -- CallbackRegistry stub (Blizzard_SharedXMLBase/CallbackRegistry.lua).
    -- Provides GenerateCallbackEvents so mixin files that call it at module level
    -- don't abort. The actual callback dispatch is not needed for static preview.
    -- If the real file loads from SharedXMLBase, it will override these stubs.
    CallbackRegistryMixin = {}
    function CallbackRegistryMixin:GenerateCallbackEvents(events)
      self.Event = self.Event or {}
      for _, e in ipairs(events or {}) do self.Event[e] = e end
    end
    function CallbackRegistryMixin:RegisterCallback() end
    function CallbackRegistryMixin:UnregisterCallback() end
    function CallbackRegistryMixin:TriggerEvent() end
    function CallbackRegistryMixin:OnLoad() end
    CallbackRegistrantMixin = CallbackRegistryMixin  -- alias used by some files

    -- Frame pool stubs (FrameXML pool system)
    function CreateFramePoolCollection() return {} end
    function CreateObjectPool() return {} end
    function CreateFramePool() return {} end

    -- Constants table — game constants indexed by sub-table (e.g. Constants.Item.MaxBagSize)
    local function _const_proxy()
      return setmetatable({}, { __index = function(t, k)
        local v = _const_proxy(); rawset(t, k, v); return v
      end })
    end
    Constants = _const_proxy()

    -- MathUtil stub (Blizzard_SharedXMLBase/MathUtil.lua); overridden when real file loads
    MathUtil = { Lerp = function(a, b, t) return a + (b - a) * t end }

    -- ColorMixin + CreateColor (Color.lua); overridden when the real Blizzard file loads.
    -- GenerateHexColor returns AARRGGBB (8 hex chars) matching WoW's colorStr format.
    ColorMixin = {}
    function ColorMixin:GenerateHexColor()
      return string.format("%02x%02x%02x%02x",
        math.floor((self.a or 1) * 255 + 0.5),
        math.floor(self.r * 255 + 0.5),
        math.floor(self.g * 255 + 0.5),
        math.floor(self.b * 255 + 0.5))
    end
    function ColorMixin:GenerateHexColorMarkup()
      return "|c" .. self:GenerateHexColor()
    end
    function ColorMixin:WrapTextInColorCode(text)
      return self:GenerateHexColorMarkup() .. text .. "|r"
    end
    function ColorMixin:GetRGB() return self.r, self.g, self.b end
    function ColorMixin:GetRGBA() return self.r, self.g, self.b, self.a or 1 end
    function ColorMixin:GetRGBAsBytes()
      return self.r * 255, self.g * 255, self.b * 255
    end
    function ColorMixin:GetRGBAAsBytes()
      return self.r * 255, self.g * 255, self.b * 255, (self.a or 1) * 255
    end
    function ColorMixin:SetRGBA(r, g, b, a)
      self.r = r; self.g = g; self.b = b; self.a = a
      self.colorStr = self:GenerateHexColor()
    end
    function ColorMixin:SetRGB(r, g, b) self:SetRGBA(r, g, b) end
    function ColorMixin:IsEqualTo(other)
      return self.r == other.r and self.g == other.g and self.b == other.b
        and (self.a or 1) == (other.a or 1)
    end
    function CreateColor(r, g, b, a)
      local c = setmetatable({}, { __index = ColorMixin })
      c:SetRGBA(r, g, b, a)
      return c
    end
    -- GenerateHexColorFromHexValues(r, g, b) — byte values 0–255, returns AARRGGBB
    function GenerateHexColorFromHexValues(r, g, b)
      return string.format("ff%02x%02x%02x", r, g, b)
    end
    function WrapTextInColorCode(text, colorHexString)
      return "|c" .. colorHexString .. text .. "|r"
    end

    -- Faction color tables referenced in sharedcolorconstants.lua
    local _default_color = CreateColor(1, 1, 1, 1)
    PLAYER_FACTION_COLOR_HORDE    = _default_color
    PLAYER_FACTION_COLOR_ALLIANCE = _default_color

    -- Misc WoW globals used by some SharedXML files
    function UnitRace() return "Human", "Human" end
    function GetLocale() return "enUS" end
  `);

  // C_Texture.GetAtlasInfo — always overridden so NineSlice and similar code get a
  // truthy result for any non-empty atlas name (allowing SetAtlas to be called).
  // WoW atlas names may carry _/! tiling-hint prefixes that are stripped before lookup.
  // With manifest: returns full WoW-compatible info table.
  // Without manifest: returns minimal {tilesHorizontally=false,tilesVertically=false}.
  {
    const manifest = opts.atlasManifest ?? null;
    lua.global.set("__scryer_atlas_getinfo", (name: unknown) => {
      if (typeof name !== "string" || !name) return;
      // WoW uses _ and ! prefixes as tiling hints; the manifest may store keys with
      // or without them. Try the original name first, then the stripped variant.
      const origLower = name.toLowerCase();
      const stripped = name.replace(/^[_!]+/, "");
      const strippedLower = stripped.toLowerCase();
      // The _ prefix means tile horizontally, ! means tile vertically.
      const prefixTilesH = name.startsWith("_");
      const prefixTilesV = name.startsWith("!");
      if (manifest) {
        const entry =
          manifest[origLower] ??
          manifest[stripped] ??
          manifest[strippedLower] ??
          manifest[strippedLower + "-2x"];
        if (entry) {
          const { x, y, width, height, sheetW, sheetH, tilesH, tilesV } = entry;
          // texcoords in 0–1 UV space
          return {
            tilesHorizontally: tilesH || prefixTilesH,
            tilesVertically: tilesV || prefixTilesV,
            width,
            height,
            leftTexCoord: x / sheetW,
            rightTexCoord: (x + width) / sheetW,
            topTexCoord: y / sheetH,
            bottomTexCoord: (y + height) / sheetH,
          };
        }
      }
      // No manifest entry — return minimal truthy value so SetAtlas is still called
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
      fn(...args);
    } catch {
      // swallow
    }
  });
  lua.global.set("securecallfunction", (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => {
    try {
      return fn(...args);
    } catch {
      return; // undefined → Lua nil
    }
  });

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

  // ── Event listener registry ───────────────────────────────────────────────
  // Initialized here so frame-class.lua can capture it as a local upvalue.
  // frame-class.lua populates it via RegisterEvent/UnregisterEvent.
  // toc-runner uses __scryer_fire_event (defined in frame-class.lua) to dispatch.
  await lua.doString("__scryer_event_listeners = {}");
}
