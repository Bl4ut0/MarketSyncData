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

-- Safely inject compiled dataset into MarketSync's active database
function MSD.InjectIntoMarketSync()
    if not MarketSync or not MarketSync.GetRealmDB then
        return false, "MarketSync core is not loaded"
    end

    local realmDB = MarketSync.GetRealmDB()
    if not realmDB then return false, "No active realm partition" end

    -- Determine partition key (e.g. "english@Horde", "english@Alliance")
    local partitionKey = MarketSync.GetFactionRealmKey and MarketSync.GetFactionRealmKey()
    if not partitionKey and MarketSync.GetSyncMarketRealm then
        partitionKey = MarketSync.GetSyncMarketRealm()
    end
    if not partitionKey then
        local realm = GetNormalizedRealmName and GetNormalizedRealmName() or GetRealmName()
        local faction = UnitFactionGroup and UnitFactionGroup("player") or "Unknown"
        partitionKey = tostring(realm) .. "@" .. tostring(faction)
    end

    local data = MarketSyncDataDB[partitionKey]
    if not data then
        -- Also check normalized key without shard numbers (e.g., "english@Horde")
        if MarketSync.NormalizeSyncRealm then
            local rawRealm, faction = partitionKey:match("^(.+)@([^@]+)$")
            local normRealm = MarketSync.NormalizeSyncRealm(rawRealm)
            local altKey = (normRealm or rawRealm) .. "@" .. (faction or "Unknown")
            data = MarketSyncDataDB[altKey]
        end
    end

    if not data or type(data) ~= "table" then
        return false, "No data available for partition: " .. tostring(partitionKey)
    end

    if not realmDB.GuildData then realmDB.GuildData = {} end
    local guildData = realmDB.GuildData
    local inserted, skipped = 0, 0

    for itemKey, entry in pairs(data) do
        local existing = guildData[itemKey]
        -- Only insert or update if existing entry is missing or older
        if not existing or (entry.t and (tonumber(existing.t) or 0) < tonumber(entry.t)) then
            guildData[itemKey] = {
                m = tonumber(entry.m) or 0,
                q = tonumber(entry.q) or 1,
                t = tonumber(entry.t) or time(),
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

    return true, inserted, skipped
end

-- Frame listener to trigger ingestion on login or when MarketSync loads
local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")

frame:SetScript("OnEvent", function(self, event, arg1)
    if event == "ADDON_LOADED" then
        if arg1 == ADDON_NAME or arg1 == "MarketSync" then
            if MarketSync and MarketSync.GetRealmDB then
                local ok, count = MSD.InjectIntoMarketSync()
                if ok and count and count > 0 then
                    Log(string.format("Loaded %d daily auction price observations.", count))
                end
            end
        end
    elseif event == "PLAYER_LOGIN" then
        C_Timer.After(2.0, function()
            if MarketSync and MarketSync.GetRealmDB then
                local ok, count = MSD.InjectIntoMarketSync()
                if ok and count and count > 0 then
                    Log(string.format("Synced %d baseline auction prices into MarketSync.", count))
                end
            end
        end)
    end
end)
