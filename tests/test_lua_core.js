const { lua, lauxlib, lualib, to_luastring } = require('../../MarketSync/node_modules/fengari');
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
  function CreateFrame() return { RegisterEvent = function() end, SetScript = function() end } end
  function time() return 1795324800 end
  MarketSync = {
    GetRealmDB = function() return { GuildData = {} } end,
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
  local ok, inserted, skipped = MarketSyncData.InjectIntoMarketSync()
  assert(ok == true, "Inject should succeed even when realm name is empty string")
  assert(inserted == 1, "Should have inserted 1 item matching faction")
  print("Fengari Lua test passed! Inserted: " .. inserted)
`);
