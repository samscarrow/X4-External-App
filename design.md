# X4 External App Design
This design doc is not comprehensive.  It is being updated as development occurs.
For the co-captain side see `mcp-server/README.md` and `game-extension/COMMAND_BRIDGE.md`.

# Widgets
Widgets are what show the information from the game on the web page.  The information for each widget is sent by the game mod.  The mod's code is broken down into separate files for each widget.  The mod reads from the game using LUA and then makes HTTP/REST calls to the X4-External-App web server, passing on the information from the game.  The web server then takes the information and displays it in a widget.

Widgets must be enumerated in the language files under src/lang/ and in the widgetConfig.js file under src/.

# Endpoints
- `POST /api/data` — the game's telemetry POST (every ~2s). The reply carries queued co-captain commands (see `game-extension/COMMAND_BRIDGE.md`); the stock extension ignores it.
- `GET /api/data` — latest snapshot, read by the frontend and the MCP server.
- `/api/commands`, `/api/commands/ack`, `/api/commands/:id` — co-captain command queue.
- `/api/savegames/...` — parsed savegame data (see `SAVEGAME_INTEGRATION.md`).
- `/api/events`, `/api/status` — events journal and server health for the MCP server.

# X4 LUA Functions
To find out what LUA functions are available, see this page: https://wiki.egosoft.com:1337/X%20Rebirth%20Wiki/Modding%20support/UI%20Modding%20support/Lua%20function%20overview/

# Testing
The first time X4-External-App is ran for development, it will create a cached copy of data from the game in a file named `dev-data.json`.  The next time the server is ran it will use this file for data instead of waiting for data from the game.  This means you do not need to keep re-launching the game to test.

To test, for the first time run, perform the following steps in order:
- CLI/terminal: `npm run build`
- CLI/terminal: `node server.js`
- Launch the X4 game
- Load a saved game
- Perform validations
- Check that the dev-data.json file was created
- Close the game