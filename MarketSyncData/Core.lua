-- ============================================================================
-- MarketSyncData - Core AddOn & Integration Layer
-- ============================================================================
-- Serves as the data delivery container for MarketSync.
-- Pre-seeds MarketSync with authoritative auction snapshots compiled daily.
-- ============================================================================

local ADDON_NAME, ns = ...
MarketSyncData = MarketSyncData or {}
local MSD = MarketSyncData

MSD.version = "1.0.0"
MSD.generatedAt = 0

-- Global database container populated by MarketSyncData.lua
-- Structure: MarketSyncDataDB[partitionKey][itemKey] = { m = minPrice, q = quantity, t = timestamp }
MarketSyncDataDB = MarketSyncDataDB or {}

local function Log(msg)
    if DEFAULT_CHAT_FRAME then
        DEFAULT_CHAT_FRAME:AddMessage("|cFF00FF00[MarketSyncData]|r " .. tostring(msg))
    end
end

local FLAVOR_INTERFACES = {
    forever = { [16001] = true },
    anniversary = { [20506] = true, [20505] = true, [11509] = true, [11508] = true },
    classicEra = { [11509] = true, [11508] = true },
    classic = { [50503] = true, [38000] = true, [20506] = true, [20505] = true },
    retail = { [120001] = true, [120000] = true },
}

local function IsClientFlavorCompatible(packFlavor)
    if not packFlavor or packFlavor == "" then return true end
    if not GetBuildInfo then return true end
    local rawInterface = select(4, GetBuildInfo())
    local interface = tonumber(rawInterface)
    if not interface then return true end
    local allowed = FLAVOR_INTERFACES[packFlavor]
    if not allowed then return true end
    if allowed[interface] then return true end
    if packFlavor == "retail" and interface >= 100000 then return true end
    return false, interface
end

-- Each Forever pack is its own LoadOnDemand addon named MarketSyncData_Forever_<ruleset>_<faction>.
-- Loading one is one-way until /reload, so only the character's own pack is loaded by default.
function MSD.PackAddonName(ruleset, faction)
    return "MarketSyncData_Forever_" .. tostring(ruleset) .. "_" .. tostring(faction)
end

-- Loads the pack for a ruleset and faction. Returns true when its data is available.
function MSD.EnsureForeverPack(ruleset, faction)
    if not ruleset or not faction then return false end
    local name = MSD.PackAddonName(ruleset, faction)
    local api = C_AddOns or {}
    if api.IsAddOnLoaded and api.IsAddOnLoaded(name) then return true end
    local load = api.LoadAddOn or LoadAddOn
    if type(load) ~= "function" then return false end
    pcall(load, name)
    return api.IsAddOnLoaded and api.IsAddOnLoaded(name) == true or false
end

function MSD.GetCurrentMarketPrices()
    local compat, iface = IsClientFlavorCompatible(MSD.flavor)
    if not compat then
        return nil, nil, string.format("DataPack flavor '%s' does not match client interface %s", tostring(MSD.flavor), tostring(iface))
    end
    local realm = MarketSync and MarketSync.GetAuctionRealm and MarketSync.GetAuctionRealm()
        or (GetNormalizedRealmName and GetNormalizedRealmName())
    if not realm or realm == "" then
        realm = GetRealmName and GetRealmName()
    end
    local faction = UnitFactionGroup and UnitFactionGroup("player")
    if MSD.flavor == "forever" and MarketSync and MarketSync.GetForeverAuctionRuleset then
        realm = MarketSync.GetForeverAuctionRuleset() or realm
    elseif MSD.flavor == "retail" then
        realm, faction = "region", "Commodities"
    elseif MSD.flavor == "classic" then
        faction = "CrossFaction"
    end
    if not realm or realm == "" or (faction ~= "Alliance" and faction ~= "Horde"
        and faction ~= "CrossFaction" and faction ~= "Commodities") then
        return nil, nil, "The current auction market is unavailable"
    end
    local suffix = "@" .. faction
    local slug = realm:lower():gsub("[%s']", "")
    if MSD.flavor == "forever" then
        -- Forever packs are split per ruleset and faction. Load this character's pack first.
        MSD.EnsureForeverPack(realm, faction)
    end
    local prices = MarketSyncDataDB[realm .. suffix] or MarketSyncDataDB[slug .. suffix]
    return prices, realm .. " / " .. faction
end

-- Price record for one item in this character's market, or nil. Loads this
-- character's Forever pack the first time (load on demand).
function MSD.GetPrice(itemKey)
    local prices = MSD.GetCurrentMarketPrices()
    local rec = type(prices) == "table" and itemKey ~= nil and prices[tostring(itemKey)]
    return type(rec) == "table" and rec or nil
end

-- Pack rows are no longer copied into MarketSync's saved GuildData. Copies
-- were shared by guild sync and uploads as if they were scans, and they kept
-- the pack in memory twice. MarketSync reads the pack directly, only for
-- items nobody has scanned. Kept as a no-op for older MarketSync versions.
function MSD.InjectIntoMarketSync()
    return true, 0, 0
end