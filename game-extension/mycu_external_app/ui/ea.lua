local ffi = require("ffi")
local C = ffi.C

local widgets

local mapMenu

local external = {
    maxGroup = 3, -- Maximum number of groups.
    cycleCounter = 0, -- Counter for cycle through groups.
    lastChecksums = {}, -- Store checksums of last sent results for change detection
};

local request = require("djfhe.http.request")
local method = 'POST'
local apiUrl = "http://" .. host .. ":" .. port .. "/api/data"
local ackUrl = "http://" .. host .. ":" .. port .. "/api/commands/ack"



local function init ()
    package.path = package.path .. ";extensions/mycu_external_app/ui/?.lua";
    widgets = require("widgets")

    mapMenu = Helper.getMenu("MapMenu")

    -- Main event
    RegisterEvent("externalapp.getMessages", external.send)

    -- Reputations and Professions mod event triggered after all available guild missions offers are created AFTER the player clicks on the "Connect to the Guild Network" button
    RegisterEvent("kProfs.guildNetwork_onLoaded", external.send)
end

---
--- Send data to external app server
---
function external.send (_, param)
    local payload = external.fetchData()

    request.new(method)
           :setUrl(apiUrl)
           :setBody(payload)
           :send(
            function(response, err)
                if err then
                    DebugError("Error occured while sending data to External App Server: " .. tostring(err))
                end
                if response then
                    external.handleServerReply(response)
                    response:cancel()
                end
            end
    )
end

---
--- Co-captain command bridge: the /api/data reply piggybacks queued commands
--- ({ status = "ok", commands = { { id, type, payload }, ... } }). Execute
--- each one via Mission Director and acknowledge the executed ids.
---
function external.handleServerReply (response)
    local reply = response:getJson()
    if type(reply) ~= "table" or type(reply.commands) ~= "table" then
        return
    end

    local ackIds = {}
    for _, command in ipairs(reply.commands) do
        if type(command) == "table" and command.id ~= nil then
            if external.executeCommand(command) then
                table.insert(ackIds, command.id)
            end
        end
    end

    if #ackIds > 0 then
        external.ackCommands(ackIds)
    end
end

---
--- Hand a single command to Mission Director (md/cocaptain_bridge.xml).
--- Returns true when the command was dispatched; commands that are not
--- dispatched are left unacked so they stay visible as 'delivered' on the
--- server for diagnosis.
---
function external.executeCommand (command)
    local payload = type(command.payload) == "table" and command.payload or {}

    if command.type == "notify" then
        if type(payload.text) ~= "string" or payload.text == "" then
            DebugError("Co-captain bridge: notify command " .. tostring(command.id) .. " has no text")
            return false
        end
        AddUITriggeredEvent("CoCaptainBridge", "notify", { text = payload.text })
        return true
    end

    if command.type == "logbook" then
        if type(payload.text) ~= "string" or payload.text == "" then
            DebugError("Co-captain bridge: logbook command " .. tostring(command.id) .. " has no text")
            return false
        end
        local title = payload.title
        if type(title) ~= "string" or title == "" then
            title = "Co-captain"
        end
        AddUITriggeredEvent("CoCaptainBridge", "logbook", { title = title, text = payload.text })
        return true
    end

    -- fly_my_ship_to (ship = the one the player is aboard) and order_ship_to
    -- (ship named by idcode/name) share one MD cue: control 'order_ship_to'.
    if command.type == "fly_my_ship_to" or command.type == "order_ship_to" then
        local out = {}
        if command.type == "order_ship_to" then
            if type(payload.ship) ~= "string" or payload.ship == "" then
                DebugError("Co-captain bridge: order_ship_to command " .. tostring(command.id) .. " has no ship")
                return false
            end
            out.ship = payload.ship
        end
        if type(payload.sector) == "string" and payload.sector ~= "" then
            out.sector = payload.sector
        end
        if type(payload.x) == "number" then out.x = payload.x end
        if type(payload.y) == "number" then out.y = payload.y end
        if type(payload.z) == "number" then out.z = payload.z end
        AddUITriggeredEvent("CoCaptainBridge", "order_ship_to", out)
        return true
    end

    if command.type == "clear_ship_orders" then
        local out = {}
        if type(payload.ship) == "string" and payload.ship ~= "" then
            out.ship = payload.ship
        end
        AddUITriggeredEvent("CoCaptainBridge", "clear_ship_orders", out)
        return true
    end

    if command.type == "get_ship_loadout" then
        local out = {}
        if type(payload.ship) == "string" and payload.ship ~= "" then
            out.ship = payload.ship
        end
        AddUITriggeredEvent("CoCaptainBridge", "get_ship_loadout", out)
        return true
    end

    if command.type == "rekit_ship" then
        if type(payload.ship) ~= "string" or payload.ship == ""
                or type(payload.loadout) ~= "string" or payload.loadout == ""
                or type(payload.station) ~= "string" or payload.station == "" then
            DebugError("Co-captain bridge: rekit_ship command " .. tostring(command.id) .. " needs ship, loadout, station")
            return false
        end
        AddUITriggeredEvent("CoCaptainBridge", "rekit_ship", {
            ship = payload.ship,
            loadout = payload.loadout,
            station = payload.station,
        })
        return true
    end

    if command.type == "set_weapons_hold" then
        local out = { hold = payload.hold ~= false }
        if type(payload.ship) == "string" and payload.ship ~= "" then
            out.ship = payload.ship
        end
        AddUITriggeredEvent("CoCaptainBridge", "set_weapons_hold", out)
        return true
    end

    if command.type == "ping_ship" then
        if type(payload.ship) ~= "string" or payload.ship == "" then
            DebugError("Co-captain bridge: ping_ship command " .. tostring(command.id) .. " has no ship")
            return false
        end
        AddUITriggeredEvent("CoCaptainBridge", "ping_ship", { ship = payload.ship })
        return true
    end

    if command.type == "set_guidance" then
        local out = {}
        if payload.clear == true then
            out.clear = true
        else
            if type(payload.sector) == "string" and payload.sector ~= "" then
                out.sector = payload.sector
            end
            if type(payload.x) == "number" then out.x = payload.x end
            if type(payload.y) == "number" then out.y = payload.y end
            if type(payload.z) == "number" then out.z = payload.z end
        end
        AddUITriggeredEvent("CoCaptainBridge", "set_guidance", out)
        return true
    end

    DebugError("Co-captain bridge: unknown command type '" .. tostring(command.type) .. "' (id " .. tostring(command.id) .. ")")
    return false
end

---
--- Report executed command ids back to the server so they move from
--- 'delivered' to 'executed'.
---
function external.ackCommands (ackIds)
    request.new('POST')
           :setUrl(ackUrl)
           :setBody({ ids = ackIds })
           :send(
            function(response, err)
                if err then
                    DebugError("Co-captain bridge: command ack failed: " .. tostring(err))
                end
                if response then
                    response:cancel()
                end
            end
    )
end

---
--- Fetch data from widgets
---
function external.fetchData()
    local payload = {
        time = C.GetCurrentGameTime()
    }
    external.cycleCounter = external.cycleCounter + 1

    -- Determine which group to process (1,2,3 and then repeat)
    local widgetGroupToProcess = external.cycleCounter % external.maxGroup + 1

    for key, widget in pairs(widgets) do
        for _, group in ipairs(widget.groups) do
            -- Process only the widgets that belong to the current group
            if group == widgetGroupToProcess then
                local output = require(widget.path) -- this will be cached after first load
                local result = output.handle()
                if result ~= nil then
                    local exclusions = output.hashExclusions or {}
                    -- Check if result has changed since last time
                    if external.hasResultChanged(key, result, exclusions) then
                        payload[key] = result
                        -- Update stored checksum
                        external.lastChecksums[key] = external.generateChecksum(result, exclusions)
                    end
                end
                break
            end
        end
    end

    -- Co-captain fleet telemetry: md/cocaptain_bridge.xml sweeps player ships
    -- into this blackboard var every ~30s; forward it when it changes. Keys
    -- arrive with MD's $ prefix stripped (idcode, name, sector, ...).
    local ok, fleet = pcall(function ()
        return GetNPCBlackboard(ConvertStringTo64Bit(tostring(C.GetPlayerID())), "$cocaptain_fleet")
    end)
    if ok and type(fleet) == "table" then
        if external.hasResultChanged("fleet", fleet, {}) then
            payload.fleet = fleet
            external.lastChecksums["fleet"] = external.generateChecksum(fleet, {})
        end
    end

    -- On-demand loadout report written by the get_ship_loadout bridge command.
    local lok, loadout = pcall(function ()
        return GetNPCBlackboard(ConvertStringTo64Bit(tostring(C.GetPlayerID())), "$cocaptain_loadout")
    end)
    if lok and type(loadout) == "table" then
        if external.hasResultChanged("ship_loadout", loadout, {}) then
            payload.ship_loadout = loadout
            external.lastChecksums["ship_loadout"] = external.generateChecksum(loadout, {})
        end
    end

    return external.removeUnsupportedTypes(payload)
end

---
--- Remove unsupported types
---
function external.removeUnsupportedTypes(value)
    local elementType = type(value)

    if elementType == "cname" or elementType == "userdata" or elementType == "cdata" then
        value = nil
    end

    if elementType == "table" then
        for k, v in pairs(value) do
            value[k] = external.removeUnsupportedTypes(v)
        end
    end

    return value
end

---
--- Check if result has changed since last time
---
function external.hasResultChanged(key, newResult, exclusions)
    local lastChecksum = external.lastChecksums[key]

    -- If no previous checksum exists, consider it changed
    if lastChecksum == nil then
        return true
    end

    -- Compare checksums with exclusions
    exclusions = exclusions or {}
    local newChecksum = external.generateChecksum(newResult, exclusions)
    return lastChecksum ~= newChecksum
end

---
--- Generate a simple checksum for any value
---
function external.generateChecksum(value, exclusions)
    exclusions = exclusions or {}
    return external.hashValue(value, 0, exclusions)
end

---
--- Hash a value recursively with exclusions support
---
function external.hashValue(value, hash, exclusions)
    local valueType = type(value)
    exclusions = exclusions or {}

    if valueType == "nil" then
        return external.hashString("nil", hash)
    elseif valueType == "boolean" then
        return external.hashString(tostring(value), hash)
    elseif valueType == "number" then
        return external.hashString(tostring(value), hash)
    elseif valueType == "string" then
        return external.hashString(value, hash)
    elseif valueType == "table" then
        -- Sort keys for consistent hashing
        local keys = {}
        for k in pairs(value) do
            table.insert(keys, k)
        end
        table.sort(keys, function(a, b)
            return tostring(a) < tostring(b)
        end)

        -- Hash each key-value pair, excluding specified properties
        for _, k in ipairs(keys) do
            if not external.isExcluded(k, exclusions) then
                hash = external.hashValue(k, hash, exclusions)
                hash = external.hashValue(value[k], hash, exclusions)
            end
        end
        return hash
    else
        -- For other types, just hash the type name
        return external.hashString(valueType, hash)
    end
end

---
--- Check if a property should be excluded from hashing
---
function external.isExcluded(property, exclusions)
    for _, excluded in ipairs(exclusions) do
        if property == excluded then
            return true
        end
    end
    return false
end

---
--- Simple string hashing function (djb2 algorithm)
---
function external.hashString(str, hash)
    hash = hash or 5381 -- djb2 initial value

    for i = 1, #str do
        local byte = string.byte(str, i)
        hash = ((hash * 33) + byte) % 4294967296
    end

    return hash
end

init()