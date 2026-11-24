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
    local prices = MarketSyncDataDB[realm .. suffix] or MarketSyncDataDB[slug .. suffix]
    return prices, realm .. " / " .. faction
end

function MSD.InjectIntoMarketSync()
    if not MarketSync or not MarketSync.GetRealmDB or not MarketSyncDB then
        return false, "MarketSync core is not loaded"
    end
    local data, market, reason = MSD.GetCurrentMarketPrices()
    if not data or type(data) ~= "table" then
        return false, reason or ("No data available for " .. tostring(market))
    end
    local realmDB = MarketSync.GetRealmDB()
    if not realmDB or not realmDB.GuildData then return false, "No active realm partition" end
    local guildData = realmDB.GuildData
    if MSD.importedInto == guildData and MSD.importedMarket == market then return true, 0, 0 end
    local inserted, skipped = 0, 0

    for itemKey, entry in pairs(data) do
        local existing = guildData[itemKey]
        local timestamp = tonumber(entry.t) or 0
        local fromPack = existing and existing.src == "DataPack"
            and (not existing.source or existing.source == "Web" or existing.source == "DataPack")
        if not existing or (fromPack and timestamp > (tonumber(existing.t) or 0)) then
            guildData[itemKey] = {
                m = tonumber(entry.m) or 0,
                q = tonumber(entry.q) or 1,
                t = timestamp,
                src = "DataPack"
            }
            inserted = inserted + 1
        else
            skipped = skipped + 1
        end
    end

    -- Invalidate index cache so Browse and Search reflect the fresh data
    if inserted > 0 and MarketSync.InvalidateIndexCache then
        MarketSync.InvalidateIndexCache()
    end

    MSD.importedInto, MSD.importedMarket = guildData, market

    return true, inserted, skipped
end

-- Frame listener to trigger ingestion on login, /reload, or when MarketSync loads
local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")

local function ImportPrices()
    local ok, count = MSD.InjectIntoMarketSync()
    if ok and count > 0 then
        Log(string.format("Loaded %d daily auction price observations.", count))
    end
end

frame:SetScript("OnEvent", function(_, event, arg1)
    if event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD"
        or (event == "ADDON_LOADED" and IsLoggedIn and IsLoggedIn()
            and (arg1 == ADDON_NAME or arg1 == "MarketSync")) then
        C_Timer.After(2, ImportPrices)
    end
end)
