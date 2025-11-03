# Windows Setup Guide - X4 Savegame Parser Integration

This guide covers setting up the X4-External-App with savegame parser integration on **Windows**.

## Prerequisites

### 1. Install Node.js for Windows

Download and install Node.js (v16 or higher) from:
**https://nodejs.org/en/download**

Choose the **Windows Installer (.msi)** for your system (64-bit recommended).

After installation, verify in PowerShell or Command Prompt:
```powershell
node --version
# Should show: v16.x.x or higher

npm --version
# Should show: 8.x.x or higher
```

### 2. Install Git for Windows (Optional)

If you want to clone the repository:
**https://git-scm.com/download/win**

## Installation

### Option 1: Clone the Repository

```powershell
# Open PowerShell or Command Prompt
cd C:\Users\YourName\Documents
git clone https://github.com/samscarrow/X4-External-App.git
cd X4-External-App
git checkout claude/integrate-x4-libraries-011CULfJXkccJeTE3wyMAUy3
```

### Option 2: Download ZIP

1. Download the branch as ZIP from GitHub
2. Extract to a folder (e.g., `C:\X4-External-App`)
3. Open PowerShell/Command Prompt in that folder

## Setup Steps

### Step 1: Install Dependencies

```powershell
npm install
```

This will install all required packages including:
- better-sqlite3 (database)
- fast-xml-parser (savegame parsing)
- chokidar (file watching)
- And all other dependencies

### Step 2: Find Your X4 Savegame Path

Your X4 savegames are typically located at:
```
C:\Users\<YourUsername>\Documents\Egosoft\X4\<PlayerID>\save
```

**To find the exact path:**

#### Method 1: PowerShell Script (Automatic)

Run this in PowerShell:
```powershell
# Find X4 savegame directories
Get-ChildItem "$env:USERPROFILE\Documents\Egosoft\X4\*\save" -Directory | Select-Object FullName
```

Example output:
```
FullName
--------
C:\Users\Sam\Documents\Egosoft\X4\12345678\save
C:\Users\Sam\Documents\Egosoft\X4\87654321\save
```

Choose the one that corresponds to your current playthrough (the `12345678` is your Steam ID or player identifier).

#### Method 2: File Explorer (Manual)

1. Open File Explorer
2. Navigate to: `C:\Users\<YourUsername>\Documents\Egosoft\X4`
3. You'll see folders with numbers (e.g., `12345678`)
4. Open the folder → Look for the `save` subfolder
5. Inside, you'll see `.xml.gz` files (these are your savegames)
6. Copy the full path from the address bar

#### Method 3: From X4 Game

1. Launch X4 Foundations
2. Go to Load Game
3. Right-click on a savegame → "Show in folder" (if available)
4. Or note the savegame name and find it manually

### Step 3: Create Configuration File

Create a `.env` file in the project root:

**Using PowerShell:**
```powershell
# Create .env file from template
Copy-Item .env.example .env

# Edit the file
notepad .env
```

**Edit the `.env` file:**
```env
# Application host
APP_HOST=127.0.0.1

# Application port
APP_PORT=8080

# X4 Savegame Path - REPLACE WITH YOUR ACTUAL PATH
X4_SAVEGAME_PATH=C:\Users\YourUsername\Documents\Egosoft\X4\12345678\save
```

**Important:**
- Replace `YourUsername` with your Windows username
- Replace `12345678` with your actual player ID
- Use **backslashes** (`\`) not forward slashes
- **No quotes** around the path

**Example configurations:**
```env
# Example 1: Standard Steam installation
X4_SAVEGAME_PATH=C:\Users\Sam\Documents\Egosoft\X4\76561198012345678\save

# Example 2: Custom Documents folder
X4_SAVEGAME_PATH=D:\MyDocuments\Egosoft\X4\12345678\save

# Example 3: OneDrive Documents
X4_SAVEGAME_PATH=C:\Users\Sam\OneDrive\Documents\Egosoft\X4\12345678\save
```

### Step 4: Initial Test (Optional)

Test that the path is correct:

```powershell
# List savegames in the directory
Get-ChildItem "C:\Users\YourUsername\Documents\Egosoft\X4\12345678\save\*.xml.gz"
```

You should see your savegame files listed.

## Running the Application

### Development Mode

```powershell
npm run dev
```

This will:
1. Start the Vite development server (frontend)
2. Start the Express backend server
3. Initialize the SQLite database
4. Begin watching your savegame directory
5. Automatically open your browser to `http://localhost:8080`

**Expected console output:**
```
X4 External App Server v3.3.0
Database initialized at C:\X4-External-App\data\x4_savegame.db
✓ Watching savegames at: C:\Users\Sam\Documents\Egosoft\X4\12345678\save
Parsing savegame: quicksave-001.xml.gz
✓ Savegame parsed successfully: quicksave-001.xml.gz
  Ships: 5, Stations: 2, Blueprints: 24
✓ Savegame watcher is ready
*********************************************
** Server running at http://127.0.0.1:8080
** Local IPv4 address: 192.168.1.100
*********************************************
```

### Production Build

To create a standalone executable:

```powershell
# Build and package for Windows
npm run package:win
```

This creates `dist/x4_external_app.exe` - a standalone executable that you can run without installing Node.js.

## Using the Application

### 1. Add the Savegame Info Widget

Once the app is running:

1. Open your browser to `http://localhost:8080`
2. Click the **Settings** gear icon (⚙️) in the header
3. Scroll down to **"Available widgets"**
4. Find **"Savegame Info"** in the list
5. **Drag it** to any column (Column 1, 2, 3, or 4)
6. The widget will appear and start loading data

### 2. Play X4 and Save Your Game

1. Launch X4 Foundations
2. Play the game normally
3. When you **save your game** (F5 for quicksave):
   - The app will detect the new savegame file
   - Automatically parse it (takes 2-10 seconds)
   - Update the database
   - Refresh the widget (within 30 seconds)

### 3. View Your Data

The Savegame Info widget displays:

**Summary Cards:**
- **Ships** - Total count of your ships
- **Stations** - Total count of your stations
- **Blueprints** - Total known blueprints

**Tabs:**
- **Ships Tab** - List of all ships with:
  - Ship name and type
  - Current sector/location
  - Hull and shield health
- **Stations Tab** - List of all stations with:
  - Station name and sector
  - Owner information
  - Module count and inventory
- **Blueprints Tab** - List of known blueprints

**Controls:**
- **Refresh Button** - Manually refresh data
- **Show More** - Expand lists to see more items
- **Tab Navigation** - Switch between ships/stations/blueprints

## File Locations

After running the app, these files/folders are created:

```
X4-External-App/
├── .env                        # Your configuration (DO NOT commit)
├── data/                       # Created automatically
│   └── x4_savegame.db         # SQLite database with parsed data
├── node_modules/               # Installed packages
├── dist/                       # Built application (after npm run build)
│   └── x4_external_app.exe    # Windows executable (after npm run package:win)
└── dev-data.json              # Development mode data (if applicable)
```

## Troubleshooting

### Issue: "Cannot find module 'better-sqlite3'"

**Solution:**
```powershell
# Rebuild native modules for Windows
npm rebuild better-sqlite3
```

Or reinstall:
```powershell
npm install
```

### Issue: "X4_SAVEGAME_PATH not set" Warning

**Cause:** The `.env` file is missing or `X4_SAVEGAME_PATH` is not configured.

**Solution:**
1. Verify `.env` file exists in the project root
2. Check that `X4_SAVEGAME_PATH` is set correctly
3. Restart the server

### Issue: Widget shows "No savegame data available"

**Possible causes:**
1. **No savegames found** - Make sure you have at least one savegame in the directory
2. **Wrong path** - Verify the path in `.env` is correct
3. **Parsing failed** - Check the console for error messages

**Solutions:**

**A. Verify path is correct:**
```powershell
# Test the path
Test-Path "C:\Users\YourUsername\Documents\Egosoft\X4\12345678\save"
# Should return: True
```

**B. List savegames:**
```powershell
Get-ChildItem "C:\Users\YourUsername\Documents\Egosoft\X4\12345678\save\*.xml.gz"
```

**C. Manually trigger parsing via API:**
```powershell
# Using PowerShell
Invoke-RestMethod -Uri "http://localhost:8080/api/savegames/parse-latest" -Method POST
```

### Issue: File watching not working

**Cause:** Windows Defender or antivirus might be blocking file system events.

**Solution:**
1. Add the savegame folder to Windows Defender exclusions
2. Add the X4-External-App folder to exclusions
3. Restart the app

**Add to Windows Defender exclusions:**
1. Open Windows Security
2. Virus & threat protection → Manage settings
3. Exclusions → Add or remove exclusions
4. Add folder: `C:\Users\YourUsername\Documents\Egosoft\X4`
5. Add folder: `C:\X4-External-App` (or wherever you installed)

### Issue: Port 8080 already in use

**Solution:**

The app will automatically find a free port. Check the console output:
```
Port 8080 is already in use. Using port 8081 instead.
```

Or manually set a different port in `.env`:
```env
APP_PORT=9090
```

### Issue: Database locked or corrupted

**Solution:**
```powershell
# Stop the server (Ctrl+C)

# Delete the database
Remove-Item data\x4_savegame.db

# Restart the server - database will be recreated
npm run dev
```

### Issue: Slow parsing or high CPU usage

**Cause:** Large savegames (>500MB) can be slow to parse.

**Solutions:**
- Normal behavior for large savegames (can take 10-30 seconds)
- Parsing happens in the background, doesn't affect X4 performance
- Consider cleaning up old savegames

## Advanced Configuration

### Parse on Demand (Disable Auto-watching)

If you don't want automatic parsing, you can:

1. **Remove** `X4_SAVEGAME_PATH` from `.env`
2. Use the **manual refresh button** in the widget
3. Or trigger via API:
```powershell
# Parse a specific file
Invoke-RestMethod -Uri "http://localhost:8080/api/savegames/parse" -Method POST -Body (@{filePath="C:\path\to\savegame.xml.gz"} | ConvertTo-Json) -ContentType "application/json"
```

### Access from Other Devices (LAN)

To access the dashboard from another device (phone, tablet):

1. Edit `.env`:
```env
APP_HOST=0.0.0.0
```

2. Find your computer's IP address:
```powershell
ipconfig
# Look for "IPv4 Address" under your active network adapter
# Example: 192.168.1.100
```

3. On other device, open browser to:
```
http://192.168.1.100:8080
```

4. **Important:** Allow through Windows Firewall when prompted

### Performance Tuning

**For large savegames (>1GB):**

The parser uses streaming XML parsing to handle large files efficiently. However, you can optimize:

1. **Increase Node.js memory** (if needed):
```powershell
$env:NODE_OPTIONS="--max-old-space-size=4096"
npm run dev
```

2. **Reduce auto-refresh frequency** - Edit `src/widgets/savegame_info/SavegameInfoWidget.vue`:
```javascript
// Change from 30000 (30 sec) to 60000 (60 sec)
this.refreshInterval = setInterval(() => {
  this.loadSavegameData(true);
}, 60000);
```

## Firewall Configuration

If you have issues with the server not being accessible:

### Allow Node.js through Windows Firewall

1. Open **Windows Defender Firewall with Advanced Security**
2. Click **Inbound Rules** → **New Rule**
3. Rule Type: **Program**
4. Program path: `C:\Program Files\nodejs\node.exe`
5. Action: **Allow the connection**
6. Profile: Check all (Domain, Private, Public)
7. Name: "Node.js - X4 External App"

## Next Steps

Once you have the savegame parser working:

1. **Explore the API** - See `SAVEGAME_INTEGRATION.md` for API documentation
2. **Customize the widget** - Modify `src/widgets/savegame_info/SavegameInfoWidget.vue`
3. **Phase 2: Real-time Events** - Integrate X4-rest-server for live game events
4. **Phase 3: Game Metadata** - Add X4FProjector for ware/ship data
5. **Phase 4: Analytics** - Build production tracking and trade flow analysis
6. **Phase 5: AI Copilot** - Integrate Claude API for intelligent assistance

## Useful PowerShell Commands

```powershell
# Find all X4 savegame directories
Get-ChildItem "$env:USERPROFILE\Documents\Egosoft\X4\*\save" -Directory

# Count savegames
(Get-ChildItem "$env:USERPROFILE\Documents\Egosoft\X4\12345678\save\*.xml.gz").Count

# Get latest savegame
Get-ChildItem "$env:USERPROFILE\Documents\Egosoft\X4\12345678\save\*.xml.gz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# Check if server is running
Test-NetConnection -ComputerName localhost -Port 8080

# View database file
Get-Item data\x4_savegame.db | Select-Object FullName, Length, LastWriteTime
```

## Support

For issues or questions:
- Check `SAVEGAME_INTEGRATION.md` for detailed technical documentation
- Review the main `README.md` for general app information
- Check the GitHub repository for updates and issues

---

**Happy gaming, Commander!** 🚀

Your X4 empire data is now being tracked in real-time. Plan your next station, optimize your trade routes, and build your economic powerhouse with data-driven insights!
