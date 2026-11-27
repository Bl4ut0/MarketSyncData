const { lua, lauxlib, lualib, to_luastring } = require('fengari');
const fs = require('fs');
const path = require('path');
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

function run(code) {
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
    throw new Error(lua.lua_tojsstring(L, -1));
  }
}

// Simulate client where realm name is empty string (Forever behavior during early load)
run(`
  function GetNormalizedRealmName() return "" end
  function GetRealmName() return "" end
  function UnitFactionGroup() return "Horde" end
  function GetBuildInfo() return "1.60.1", "71037", "Nov 2026", 16001 end
  function CreateFrame() return { RegisterEvent = function() end, SetScript = function() end } end
  function time() return 1795324800 end
  MarketSyncDB = {}
  MarketSync = {
    GetRealmDB = function() return { GuildData = {} } end,
    GetForeverAuctionRuleset = function() return "english" end,
    NormalizeSyncRealm = function(r) return r end,
    InvalidateIndexCache = function() end
  }
  MarketSyncDataDB = {
    ["english@Horde"] = { ["13464"] = { m = 12500, q = 10, t = 1795324800 } }
  }
`);

const coreLua = fs.readFileSync(path.join(__dirname, '../MarketSyncData/Core.lua'), 'utf8');
run(coreLua);
run(`
  MarketSyncData.flavor = "forever"
  -- Pack rows stay in the pack; nothing is copied into MarketSync's GuildData.
  local guildData = {}
  MarketSync.GetRealmDB = function() return { GuildData = guildData } end
  local ok, inserted = MarketSyncData.InjectIntoMarketSync()
  assert(ok == true and inserted == 0 and next(guildData) == nil, "The pack must not be copied into GuildData")
  -- Lookups read the pack directly, even when the realm name is empty during early load.
  local rec = MarketSyncData.GetPrice(13464)
  assert(rec and rec.m == 12500, "GetPrice should read this character's market: " .. tostring(rec and rec.m))
  assert(MarketSyncData.GetPrice(99999) == nil, "Unknown items have no pack price")
  print("Fengari Lua test passed! Pack read directly, GuildData untouched.")
`);