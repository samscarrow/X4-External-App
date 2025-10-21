# X4 Savegame Parser Integration - Proof of Concept

This document describes the savegame parser integration for X4-External-App, which is the first step towards building an AI copilot with real-time knowledge of your X4 Foundations playthrough.

## Overview

The savegame parser integration provides:
- **Automatic savegame parsing**: Watches your X4 savegame directory and automatically parses new saves
- **SQLite database storage**: Stores parsed savegame data in a local database for historical tracking
- **REST API**: Exposes savegame data via API endpoints for easy access
- **UI Widget**: Displays savegame information (ships, stations, blueprints) in the dashboard

## Architecture

```
X4 Savegame Files (.xml.gz)
         ↓
File Watcher (chokidar)
         ↓
Savegame Parser (decompress + XML parsing)
         ↓
SQLite Database (data/x4_savegame.db)
         ↓
REST API Endpoints
         ↓
Vue.js Widget (UI Display)
```

## Installation & Setup

### 1. Install Dependencies

The new dependencies have already been added to `package.json`:
- `better-sqlite3` - SQLite database
- `fast-xml-parser` - XML parsing
- `node-cron` - Scheduled tasks (for future use)

Run:
```bash
npm install
```

### 2. Configure Savegame Path

Create a `.env` file in the project root (copy from `.env.example`):

**Windows:**
```env
X4_SAVEGAME_PATH=C:\Users\YourName\Documents\Egosoft\X4\12345678\save
```

**Linux (Steam/Proton):**
```env
X4_SAVEGAME_PATH=/home/username/.steam/steam/steamapps/compatdata/392160/pfx/drive_c/users/steamuser/Documents/Egosoft/X4/12345678/save
```

**Note:** Replace `12345678` with your actual player ID number.

### 3. Start the Server

```bash
npm run dev
```

The server will:
- Initialize the SQLite database at `data/x4_savegame.db`
- Start watching your savegame directory (if configured)
- Parse any existing savegames
- Auto-parse new savegames as they're created

## Database Schema

The integration creates the following tables:

### `savegames`
Stores metadata about parsed savegames
- `id` - Unique identifier
- `filename` - Savegame filename
- `file_path` - Full path to savegame
- `parsed_at` - When the savegame was parsed
- `player_name` - Player name
- `player_money` - Credits
- `playtime_seconds` - Total playtime
- `game_version` - X4 game version

### `ships`
Stores player ships
- `savegame_id` - Reference to savegame
- `ship_name`, `ship_class`, `ship_type`
- `sector` - Current location
- `hull_health`, `shield_health`

### `stations`
Stores player stations
- `savegame_id` - Reference to savegame
- `station_name`, `owner`, `sector`
- `position_x`, `position_y`, `position_z`
- `total_storage`, `total_workforce`

### `station_modules`
Stores station modules
- `station_db_id` - Reference to station
- `module_macro`, `module_type`
- `quantity`

### `inventory`
Stores station inventory
- `station_db_id` - Reference to station
- `ware` - Ware ID
- `quantity`, `capacity`, `price`

### `blueprints`
Stores known blueprints
- `savegame_id` - Reference to savegame
- `blueprint_name`, `blueprint_type`
- `is_owned`

## API Endpoints

### Get All Savegames
```
GET /api/savegames
```
Returns list of all parsed savegames with metadata.

### Get Latest Savegame
```
GET /api/savegames/latest
```
Returns the most recently modified savegame.

### Get Savegame by ID
```
GET /api/savegames/:id
```
Returns complete savegame data including ships, stations, and blueprints.

### Get Ships
```
GET /api/savegames/:id/ships
```
Returns all ships for a specific savegame.

### Get Stations
```
GET /api/savegames/:id/stations
```
Returns all stations with modules and inventory for a specific savegame.

### Get Blueprints
```
GET /api/savegames/:id/blueprints
```
Returns all known blueprints for a specific savegame.

### Manual Parse
```
POST /api/savegames/parse
Body: { "filePath": "/path/to/savegame.xml.gz" }
```
Manually trigger parsing of a specific savegame file.

### Parse Latest
```
POST /api/savegames/parse-latest
```
Manually trigger parsing of the most recent savegame in the watched directory.

## UI Widget

The **Savegame Info** widget displays:
- Player name, credits, playtime, game version
- Summary cards showing counts of ships, stations, blueprints
- Tabbed interface to browse:
  - **Ships**: List of all ships with health status
  - **Stations**: List of stations with module/inventory counts
  - **Blueprints**: List of known blueprints
- Auto-refresh every 30 seconds
- Manual refresh button

### Adding the Widget

1. Start the app
2. Click the settings gear icon in the header
3. Scroll to "Available widgets"
4. Drag "Savegame Info" to any column
5. The widget will automatically fetch and display the latest savegame data

## File Structure

```
X4-External-App/
├── services/
│   ├── database.js           # SQLite database service
│   ├── savegameParser.js     # Savegame parsing logic
│   └── savegameWatcher.js    # File watcher service
├── src/
│   ├── widgets/
│   │   └── savegame_info/
│   │       └── SavegameInfoWidget.vue
│   └── lang/
│       ├── en.json           # English translations
│       └── ru.json           # Russian translations
├── data/
│   └── x4_savegame.db        # SQLite database (auto-created)
└── SAVEGAME_INTEGRATION.md   # This file
```

## How It Works

### 1. File Watching
When you save your game in X4:
- The file watcher detects the new `.xml.gz` file
- It waits for the file to finish writing (2-second stability threshold)
- Then triggers the parser

### 2. Parsing
The parser:
1. Reads the compressed savegame file
2. Decompresses it using zlib (gzip)
3. Parses the XML using fast-xml-parser
4. Extracts relevant data (player, ships, stations, blueprints)
5. Stores everything in the database

### 3. Data Access
- The Vue widget polls the API every 30 seconds
- It fetches the latest savegame and displays the data
- Users can manually refresh at any time

## Troubleshooting

### Savegame auto-parsing not working
1. Check that `X4_SAVEGAME_PATH` is set in `.env`
2. Verify the path is correct and accessible
3. Check server console for error messages
4. Try manually parsing: `POST /api/savegames/parse-latest`

### Widget shows "No savegame data available"
1. Ensure you have at least one savegame in the watched directory
2. Try manually triggering a parse via the API
3. Check browser console for errors
4. Verify the API endpoint `/api/savegames/latest` returns data

### Database errors
1. Check that the `data/` directory exists and is writable
2. Delete `data/x4_savegame.db` and restart to recreate
3. Check for disk space issues

### Parsing errors
1. Ensure savegame files are valid X4 savegames (`.xml.gz`)
2. Check that files aren't corrupted
3. Try parsing a different savegame
4. Check server console for detailed error messages

## Future Enhancements

This POC demonstrates the foundation for the full AI copilot system. Next steps:

### Phase 2: Real-time Event Streaming
- Integrate Alia5/X4-rest-server for live game events
- Add WebSocket support for push updates
- Track trade events, combat, missions in real-time

### Phase 3: Game Data Metadata
- Integrate bno1/X4FProjector to extract game metadata
- Store ware stats, ship specs, module data
- Use for calculations and enrichment

### Phase 4: Advanced Analytics
- Production efficiency tracking
- Trade flow visualization
- Market trend analysis
- Station profitability reports

### Phase 5: AI Copilot
- LLM integration (Claude, OpenAI)
- Natural language queries about game state
- AI-powered recommendations
- Automated insights and alerts

## API Examples

### Fetch Latest Savegame Data
```javascript
// Get latest savegame
const response = await fetch('http://localhost:8080/api/savegames/latest');
const savegame = await response.json();

// Get complete data
const fullData = await fetch(`http://localhost:8080/api/savegames/${savegame.id}`);
const data = await fullData.json();

console.log(`Player: ${data.player_name}`);
console.log(`Credits: ${data.player_money}`);
console.log(`Ships: ${data.ships.length}`);
console.log(`Stations: ${data.stations.length}`);
```

### Manually Trigger Parse
```javascript
const response = await fetch('http://localhost:8080/api/savegames/parse-latest', {
  method: 'POST'
});
const result = await response.json();
console.log(`Parsed ${result.filename}: ${result.summary.ships} ships, ${result.summary.stations} stations`);
```

## Performance Notes

- **Parsing time**: 2-10 seconds for typical savegames (depends on size)
- **Database size**: ~1-5 MB per savegame
- **Memory usage**: ~50-100 MB for the parser
- **API response time**: <100ms for most queries

## Contributing

This is a proof-of-concept implementation. Contributions and improvements are welcome:

1. **Parser improvements**: Extract more data from savegames
2. **UI enhancements**: Better visualizations, charts, graphs
3. **Performance**: Optimize parsing for large savegames
4. **Features**: Station production tracking, fleet management, etc.

## License

Same as X4-External-App main project.

## Credits

- **Mistralys/x4-savegame-parser** - Inspiration for savegame parsing approach
- **Alia5/X4-rest-server** - Future integration for real-time events
- **bno1/X4FProjector** - Future integration for game metadata
- **mycumycu/X4-External-App** - Base dashboard application

---

**Status**: ✅ Proof of Concept Complete
**Next**: Integrate X4-rest-server for real-time event streaming
