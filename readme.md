# X4 External App

External dashboard for X4: Foundations that displays real-time game data on separate devices (monitors, tablets, smartphones).

![X4 External App](https://img.shields.io/badge/X4-Foundations-blue)
![Node.js](https://img.shields.io/badge/Node.js-16+-green)
![Vue.js](https://img.shields.io/badge/Vue.js-3-brightgreen)

## Features

### Real-time Dashboard Widgets
- **Player Profile** - Name, faction, location, credits
- **Active Mission** - Current mission details and objectives
- **Mission Offers** - Available missions with filtering
- **Logbook** - Real-time game events with search
- **Player Goals** - User-defined goals with drag-to-prioritize
- **Factions** - Faction relationships and licenses
- **Current Research** - Active research progress
- **Transaction Log** - Financial transactions
- **Savegame Info** ⭐ NEW - Ships, stations, and blueprints from savegames

### Savegame Parser Integration (NEW!)

Automatically parse your X4 savegames to track:
- **Ships** - Fleet overview with health status
- **Stations** - Station empire with modules and inventory
- **Blueprints** - Known ship and station blueprints
- **Historical Data** - Track your empire growth over time

Features:
- 🔄 **Automatic parsing** - Detects new savegames and parses automatically
- 💾 **SQLite database** - Persistent storage for historical analysis
- 🌐 **REST API** - Access game state data programmatically
- 📊 **Interactive UI** - Browse ships, stations, and blueprints
- 🤖 **AI Copilot Ready** - Foundation for intelligent game assistance

### Customizable Layout
- 1-4 column layouts
- Drag-and-drop widget arrangement
- Adjustable font sizes
- Fullscreen mode
- Compact mode for higher information density
- Auto-hide header
- Widget height limiting

### Internationalization
- English
- Russian
- Easily extensible for more languages

### Export/Import Settings
- Export settings to JSON file
- Import settings from file
- Preserve your layout and preferences

## Quick Start

### Windows (Recommended)

**Automated Setup:**
```powershell
# 1. Install Node.js from https://nodejs.org
# 2. Clone/download this repository
# 3. Run the setup script:
.\setup-windows.ps1
```

The script will:
- Check prerequisites
- Find your X4 savegame directory automatically
- Create the `.env` configuration file
- Install dependencies
- Offer to start the application

**Manual Setup:**

See [WINDOWS_SETUP.md](WINDOWS_SETUP.md) for detailed instructions.

### Linux / macOS

```bash
# Install dependencies
npm install

# Configure savegame path (optional)
cp .env.example .env
# Edit .env and set X4_SAVEGAME_PATH

# Run development server
npm run dev
```

### WSL (Windows Subsystem for Linux)

**Note:** File watching may not work in WSL2 due to cross-filesystem limitations. We recommend running natively on Windows for the best experience.

If using WSL, see [WINDOWS_SETUP.md](WINDOWS_SETUP.md) for WSL-specific considerations.

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Application host
APP_HOST=127.0.0.1

# Application port (auto-finds free port if busy)
APP_PORT=8080

# X4 Savegame Path (optional - enables savegame parsing)
# Windows: C:\Users\YourName\Documents\Egosoft\X4\12345678\save
# Linux:   /home/username/.steam/steam/steamapps/compatdata/392160/pfx/drive_c/users/steamuser/Documents/Egosoft/X4/12345678/save
X4_SAVEGAME_PATH=
```

### Game Mod Configuration

The app receives data from the X4 game via HTTP POST requests. You need to install a companion mod in X4:

1. Install the **mycu_external_app** extension in your X4 `extensions` folder
2. Configure the extension's `config.lua` to point to your server:
   - Host: `127.0.0.1`
   - Port: `8080` (or your configured port)

## Usage

### Starting the Application

**Development mode:**
```bash
npm run dev
```

**Production build:**
```bash
npm run build
npm start
```

**Windows executable:**
```bash
npm run package:win
# Creates: dist/x4_external_app.exe
```

**Linux executable:**
```bash
npm run package:linux
# Creates: dist/x4_external_app_linux
```

### Accessing the Dashboard

1. Open your browser to `http://localhost:8080`
2. Configure your layout using the settings (⚙️) icon
3. Drag widgets from "Available widgets" to columns
4. Launch X4 Foundations and load a game
5. Data will appear automatically

### Multi-Device Access

To access from other devices (tablets, phones):

1. Set `APP_HOST=0.0.0.0` in `.env`
2. Find your computer's IP address
3. On other device, navigate to `http://<your-ip>:8080`

## Savegame Parser Features

### Automatic Parsing

When configured, the app automatically:
1. Watches your X4 savegame directory
2. Detects new savegame files
3. Parses them in the background (2-10 seconds)
4. Updates the database
5. Refreshes the UI

### REST API

Access savegame data via API:

```bash
# Get all parsed savegames
GET /api/savegames

# Get latest savegame
GET /api/savegames/latest

# Get complete savegame data (ships, stations, blueprints)
GET /api/savegames/:id

# Get ships only
GET /api/savegames/:id/ships

# Get stations with modules and inventory
GET /api/savegames/:id/stations

# Get blueprints
GET /api/savegames/:id/blueprints

# Manually trigger parsing
POST /api/savegames/parse
Body: { "filePath": "path/to/savegame.xml.gz" }

# Parse most recent savegame
POST /api/savegames/parse-latest
```

### Database

Parsed data is stored in SQLite database at `data/x4_savegame.db`

Tables:
- `savegames` - Savegame metadata
- `ships` - Player ships
- `stations` - Player stations
- `station_modules` - Station modules (production, storage, etc.)
- `inventory` - Station inventory (wares)
- `blueprints` - Known blueprints

## Documentation

- **[WINDOWS_SETUP.md](WINDOWS_SETUP.md)** - Detailed Windows setup guide
- **[SAVEGAME_INTEGRATION.md](SAVEGAME_INTEGRATION.md)** - Savegame parser technical documentation
- **API Documentation** - See SAVEGAME_INTEGRATION.md for API details

## Architecture

```
┌─────────────────────────────────────────┐
│  X4 Foundations Game                    │
│  ├── HTTP Mod (real-time data)          │
│  └── Savegame Files (periodic state)    │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│  X4 External App Server (Node.js)       │
│  ├── Express.js Backend                 │
│  ├── Savegame Parser                    │
│  ├── File Watcher                       │
│  └── SQLite Database                    │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│  Vue.js 3 Frontend                      │
│  ├── Dashboard Widgets                  │
│  ├── Customizable Layout                │
│  └── Real-time Updates                  │
└─────────────────────────────────────────┘
```

## Technology Stack

**Backend:**
- Node.js + Express.js
- better-sqlite3 (database)
- fast-xml-parser (savegame parsing)
- chokidar (file watching)

**Frontend:**
- Vue.js 3 (Composition API)
- Vite (build tool)
- Bootstrap 5 (styling)
- Vuex 4 (state management)
- Vue-i18n (internationalization)

## Development

### Prerequisites
- Node.js 16+ and npm
- Git (optional)

### Setup
```bash
# Clone repository
git clone https://github.com/samscarrow/X4-External-App.git
cd X4-External-App

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your configuration

# Start development server
npm run dev
```

### Project Structure
```
X4-External-App/
├── services/              # Backend services
│   ├── database.js        # SQLite database service
│   ├── savegameParser.js  # Savegame parsing logic
│   └── savegameWatcher.js # File watching service
├── src/                   # Frontend source
│   ├── components/        # Shared UI components
│   ├── widgets/           # Dashboard widgets
│   │   ├── player_profile/
│   │   ├── savegame_info/ # NEW: Savegame widget
│   │   └── ...
│   ├── lang/              # Translations
│   └── scss/              # Styles
├── server.js              # Express.js server
├── vite.config.js         # Vite configuration
└── package.json           # Dependencies
```

### Adding a New Widget

1. Create widget directory in `src/widgets/`
2. Create `YourWidgetWidget.vue` component
3. Add translation keys to `src/lang/en.json` and `src/lang/ru.json`
4. Register in `src/widgetConfig.js`
5. Widget will appear in available widgets list

## Roadmap

### ✅ Phase 1: Savegame Parser Integration (COMPLETE)
- Automatic savegame parsing
- SQLite database storage
- REST API endpoints
- Savegame Info widget

### 🔄 Phase 2: Real-time Event Streaming (IN PROGRESS)
- Integrate X4-rest-server for live game events
- WebSocket support for real-time push updates
- Trade event tracking
- Combat event tracking

### 📋 Phase 3: Game Metadata Integration
- Integrate X4FProjector for game data
- Ware statistics and pricing
- Ship specifications
- Module data

### 📊 Phase 4: Advanced Analytics
- Production efficiency tracking
- Trade flow visualization
- Market trend analysis
- Station profitability reports

### 🤖 Phase 5: AI Copilot
- ✅ MCP server for LLM co-captain (see `mcp-server/`)
- ✅ Command bridge into the game: notifications, logbook entries, and HUD guidance
  (`set_guidance`) — see `game-extension/COMMAND_BRIDGE.md`
- Natural language queries about game state
- AI-powered recommendations
- Further fleet orders, one allowlisted command at a time (advise-by-default)

## Troubleshooting

### Widget shows "Waiting for connection"
- Ensure X4 is running with a save loaded
- Check that the game mod is installed and configured correctly
- Verify the port in mod config matches `.env` APP_PORT

### Savegame parsing not working
- Check that `X4_SAVEGAME_PATH` is set in `.env`
- Verify the path exists and contains `.xml.gz` files
- Check server console for error messages
- Try manual parsing via API

### Port already in use
- App will automatically find a free port
- Check console output for the actual port
- Update game mod config if port changed

See [WINDOWS_SETUP.md](WINDOWS_SETUP.md) for more troubleshooting tips.

## Contributing

Contributions are welcome! Areas for improvement:

- New widgets (trading, fleet management, mining)
- Parser improvements (extract more data)
- UI enhancements (charts, graphs, visualizations)
- Translation to other languages
- Performance optimizations

## Credits

**Original X4-External-App:**
- Author: Mycu (mycumycu)
- Repository: https://github.com/mycumycu/X4-External-App

**Savegame Parser Integration:**
- Inspired by: Mistralys/x4-savegame-parser
- Contributors: Claude (AI assistant)

**Related Projects:**
- Alia5/X4-rest-server - REST server for X4 (future integration)
- bno1/X4FProjector - Game data extractor (future integration)
- SirNukes Mod Support APIs - X4 modding framework

## License

Same as original X4-External-App project.

## Support

- GitHub Issues: https://github.com/samscarrow/X4-External-App/issues
- Documentation: See `*.md` files in repository
- X4 Forums: Check Egosoft forums for X4 mod support

---

**Fly safe, Commander!** 🚀
