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
    local interface = tonumber(select(4, GetBuildInfo()))
    if not interface then return true end
    local allowed = FLAVOR_INTERFACES[packFlavor]
    if not allowed then return true end
    if allowed[interface] then return true end
    if packFlavor == "retail" and interface >= 100000 then return true end
    return false, interface
end

-- Safely inject compiled dataset into MarketSync's active database
function MSD.InjectIntoMarketSync()
    if MSD.injected then
        return true, 0, 0
    end

    local compat, iface = IsClientFlavorCompatible(MSD.flavor)
    if not compat then
        return false, string.format("DataPack flavor '%s' does not match client interface %s", tostring(MSD.flavor), tostring(iface))
    end

    if not MarketSync or not MarketSync.GetRealmDB then
        return false, "MarketSync core is not loaded"
    end

    local realmDB = MarketSync.GetRealmDB()
    if not realmDB then return false, "No active realm partition" end

    -- Determine realm safely (handling Lua's truthy empty strings)
    local realm = (GetNormalizedRealmName and GetNormalizedRealmName()) or nil
    if not realm or realm == "" then
        realm = (GetRealmName and GetRealmName()) or nil
    end
    if not realm or realm == "" then
        realm = MarketSync.myRealm or nil
    end

    -- Determine faction safely
    local faction = (MarketSync.GetPlayerMarketFaction and MarketSync.GetPlayerMarketFaction()) or nil
    if not faction or faction == "Unknown" then
        faction = (UnitFactionGroup and UnitFactionGroup("player")) or "Horde"
    end

    -- 1. Try exact partitionKey: "<realm>@<faction>"
    local data = nil
    if realm and realm ~= "" then
        data = MarketSyncDataDB[realm .. "@" .. faction]
        
        -- 2. Try normalized realm (e.g. "English 52" -> "english@Horde")
        if not data and MarketSync.NormalizeSyncRealm then
            local normRealm = MarketSync.NormalizeSyncRealm(realm)
            if normRealm and normRealm ~= "" then
                data = MarketSyncDataDB[normRealm .. "@" .. faction]
            end
        end
    end

    -- 3. If still not found (or realm was empty/unresolved), find matching faction partition in MarketSyncDataDB
    if not data then
        for key, pData in pairs(MarketSyncDataDB or {}) do
            if type(key) == "string" and key:find("@" .. faction .. "$") then
                data = pData
                break
            end
        end
    end

    -- 4. If still not found, check if there's any single partition in MarketSyncDataDB
    if not data then
        for _, pData in pairs(MarketSyncDataDB or {}) do
            if type(pData) == "table" and next(pData) then
                data = pData
                break
            end
        end
    end

    if not data or type(data) ~= "table" then
        return false, "No data available for faction: " .. tostring(faction)
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
                t = tonumber(entry.t) or (time and time() or 0),
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

    if inserted > 0 then
        MSD.injected = true
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
