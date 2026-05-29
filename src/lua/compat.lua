-- WoW Lua 5.1 compatibility bootstrap
-- Executed once inside a fresh wasmoon (Lua 5.4) state before any addon code.
-- Dangerous globals are removed by the TypeScript host before this runs.

-- ─── Table extensions ────────────────────────────────────────────────────────
function table.wipe(t)
    for k in pairs(t) do t[k] = nil end
    return t
end

function table.getn(t) return #t end

function table.maxn(t)
    local max = 0
    for k in pairs(t) do
        if type(k) == "number" and k > max then max = k end
    end
    return max
end

function table.foreach(t, f)
    for k, v in pairs(t) do f(k, v) end
end

function table.foreachi(t, f)
    for i, v in ipairs(t) do f(i, v) end
end

-- ─── String extensions ───────────────────────────────────────────────────────
function string.trim(s)
    return (s:gsub("^%s*(.-)%s*$", "%1"))
end

-- strsplit(delimiter, str[, pieces])
-- delimiter: string of separator characters (each char is a separator)
-- Returns multiple values, not a table.
function string.split(delimiter, str, pieces)
    local esc = delimiter:gsub("[%(%)%.%%%+%-%*%?%[%]%^%$]", "%%%0")
    local pat = "[" .. esc .. "]"
    local result = {}
    local start = 1
    while true do
        local s, e = str:find(pat, start)
        if s == nil then
            table.insert(result, str:sub(start))
            break
        end
        table.insert(result, str:sub(start, s - 1))
        start = e + 1
        if pieces and #result >= pieces - 1 then
            table.insert(result, str:sub(start))
            break
        end
    end
    return table.unpack(result)
end

function string.join(delimiter, ...)
    return table.concat({...}, delimiter)
end

function string.concat(...)
    return table.concat({...})
end

-- ─── bit library (32-bit LuaBitOp semantics) ─────────────────────────────────
-- Lua 5.4 native bitwise operators work on 64-bit integers; we mask to 32.
local function _tobit(x)
    x = math.tointeger(x) & 0xFFFFFFFF
    if x >= 0x80000000 then x = x - 0x100000000 end
    return x
end

bit = {}

function bit.band(a, b, ...)
    local r = math.tointeger(a) & math.tointeger(b)
    for _, v in ipairs({...}) do r = r & math.tointeger(v) end
    return _tobit(r)
end

function bit.bor(a, b, ...)
    local r = math.tointeger(a) | math.tointeger(b)
    for _, v in ipairs({...}) do r = r | math.tointeger(v) end
    return _tobit(r)
end

function bit.bxor(a, b, ...)
    local r = math.tointeger(a) ~ math.tointeger(b)
    for _, v in ipairs({...}) do r = r ~ math.tointeger(v) end
    return _tobit(r)
end

function bit.bnot(a)
    return _tobit(~math.tointeger(a))
end

function bit.lshift(a, n)
    return _tobit(math.tointeger(a) << n)
end

function bit.rshift(a, n)
    -- Logical (zero-fill) right shift
    return _tobit((math.tointeger(a) & 0xFFFFFFFF) >> n)
end

function bit.arshift(a, n)
    -- Arithmetic (sign-extending) right shift
    local x = math.tointeger(a) & 0xFFFFFFFF
    if x >= 0x80000000 then x = x - 0x100000000 end
    return _tobit(x >> n)
end

function bit.mod(a, n)
    return math.fmod(a, n)
end

-- ─── setfenv / getfenv shim ───────────────────────────────────────────────────
-- Lua 5.4 chunks have _ENV as an explicit upvalue; setupvalue takes effect for
-- all subsequent global accesses in that chunk.
local function _findenv(f)
    local i = 1
    repeat
        local name, val = debug.getupvalue(f, i)
        if name == "_ENV" then return i, val end
        i = i + 1
    until name == nil
end

function getfenv(f)
    if f == nil or f == 0 then return _G end
    if type(f) == "number" then
        local info = debug.getinfo(f + 1, "f")
        if info == nil then return _G end
        f = info.func
    end
    local _, env = _findenv(f)
    return env or _G
end

function setfenv(f, t)
    if type(f) == "number" then
        local info = debug.getinfo(f + 1, "f")
        if info == nil then return f end
        f = info.func
    end
    local level = _findenv(f)
    if level then debug.setupvalue(f, level, t) end
    return f
end

-- ─── 5.1 globals ─────────────────────────────────────────────────────────────
unpack      = table.unpack
loadstring  = load
_VERSION    = "Lua 5.1"

-- Table aliases
tinsert   = table.insert
tremove   = table.remove
wipe      = table.wipe
sort      = table.sort
foreach   = table.foreach
foreachi  = table.foreachi
getn      = table.getn

-- Math aliases — CRITICAL: WoW uses degrees, not radians
abs    = math.abs
ceil   = math.ceil
floor  = math.floor
max    = math.max
min    = math.min
mod    = math.fmod
log10  = math.log10
exp    = math.exp
sqrt   = math.sqrt
PI     = math.pi
random = math.random
cos    = function(x) return math.cos(math.rad(x)) end
sin    = function(x) return math.sin(math.rad(x)) end
tan    = function(x) return math.tan(math.rad(x)) end
acos   = function(x) return math.deg(math.acos(x)) end
asin   = function(x) return math.deg(math.asin(x)) end
atan   = function(x) return math.deg(math.atan(x)) end
atan2  = function(x, y) return math.deg(math.atan(x, y)) end

-- String aliases
strbyte   = string.byte
strchar   = string.char
strfind   = string.find
format    = string.format
gmatch    = string.gmatch
gsub      = string.gsub
strlen    = string.len
strlower  = string.lower
strmatch  = string.match
strrep    = string.rep
strrev    = string.reverse
strsub    = string.sub
strupper  = string.upper
strtrim   = string.trim
strsplit  = string.split
strjoin   = string.join
strconcat = string.concat
