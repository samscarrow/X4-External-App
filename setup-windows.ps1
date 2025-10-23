# X4 External App - Windows Setup Script
# This script helps you configure the application for Windows

Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host "   X4 External App - Windows Setup Wizard" -ForegroundColor Cyan
Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
Write-Host "Checking prerequisites..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "OK Node.js found: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR Node.js not found!" -ForegroundColor Red
    Write-Host "  Please install Node.js from: https://nodejs.org" -ForegroundColor Red
    Write-Host "  Then run this script again." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

try {
    $npmVersion = npm --version
    Write-Host "OK npm found: v$npmVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR npm not found!" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Find X4 savegame directories
Write-Host "Searching for X4 savegame directories..." -ForegroundColor Yellow
$savegameDirs = Get-ChildItem "$env:USERPROFILE\Documents\Egosoft\X4\*\save" -Directory -ErrorAction SilentlyContinue

if ($savegameDirs.Count -eq 0) {
    Write-Host "ERROR No X4 savegame directories found!" -ForegroundColor Red
    Write-Host "  Expected location: $env:USERPROFILE\Documents\Egosoft\X4\<PlayerID>\save" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please enter your X4 savegame path manually:" -ForegroundColor Cyan
    $savegamePath = Read-Host "Savegame path"

    if (-not (Test-Path $savegamePath)) {
        Write-Host "ERROR Path does not exist: $savegamePath" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
} elseif ($savegameDirs.Count -eq 1) {
    $savegamePath = $savegameDirs[0].FullName
    Write-Host "OK Found savegame directory:" -ForegroundColor Green
    Write-Host "  $savegamePath" -ForegroundColor White

    # Check for savegame files
    $savegameFiles = Get-ChildItem "$savegamePath\*.xml.gz" -ErrorAction SilentlyContinue
    if ($savegameFiles.Count -gt 0) {
        Write-Host "  Contains $($savegameFiles.Count) savegame file(s)" -ForegroundColor Gray
        $latestSave = $savegameFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        Write-Host "  Latest: $($latestSave.Name) ($($latestSave.LastWriteTime))" -ForegroundColor Gray
    }
} else {
    Write-Host "OK Found multiple savegame directories:" -ForegroundColor Green
    Write-Host ""

    for ($i = 0; $i -lt $savegameDirs.Count; $i++) {
        $dir = $savegameDirs[$i]
        $savegameFiles = Get-ChildItem "$($dir.FullName)\*.xml.gz" -ErrorAction SilentlyContinue
        $latestSave = $savegameFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1

        Write-Host "  [$($i+1)] $($dir.FullName)" -ForegroundColor White
        if ($latestSave) {
            Write-Host "      Latest save: $($latestSave.Name) ($($latestSave.LastWriteTime))" -ForegroundColor Gray
        } else {
            Write-Host "      (No savegames found)" -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    $selection = Read-Host "Select directory (1-$($savegameDirs.Count))"

    try {
        $index = [int]$selection - 1
        if ($index -lt 0 -or $index -ge $savegameDirs.Count) {
            throw "Invalid selection"
        }
        $savegamePath = $savegameDirs[$index].FullName
        Write-Host "OK Selected: $savegamePath" -ForegroundColor Green
    } catch {
        Write-Host "ERROR Invalid selection!" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host ""

# Create .env file
Write-Host "Creating configuration file..." -ForegroundColor Yellow

$envContent = "# Application host (use 0.0.0.0 to allow access from other devices on your network)`r`nAPP_HOST=127.0.0.1`r`n`r`n# Application port - if busy, it will try to find a free one`r`nAPP_PORT=8080`r`n`r`n# X4 Savegame Path - Path to your X4 Foundations savegame directory`r`n# Automatically configured by setup script`r`nX4_SAVEGAME_PATH=$savegamePath`r`n"

$envPath = ".env"

if (Test-Path $envPath) {
    Write-Host "  .env file already exists" -ForegroundColor Yellow
    $overwrite = Read-Host "  Overwrite? (y/N)"
    if ($overwrite -ne "y" -and $overwrite -ne "Y") {
        Write-Host "  Skipping .env creation" -ForegroundColor Gray
    } else {
        Set-Content -Path $envPath -Value $envContent -NoNewline
        Write-Host "OK Created .env file" -ForegroundColor Green
    }
} else {
    Set-Content -Path $envPath -Value $envContent -NoNewline
    Write-Host "OK Created .env file" -ForegroundColor Green
}

Write-Host ""

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    Write-Host "  This may take a few minutes..." -ForegroundColor Gray
    Write-Host ""

    npm install

    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK Dependencies installed successfully" -ForegroundColor Green
    } else {
        Write-Host "ERROR Failed to install dependencies" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "OK Dependencies already installed" -ForegroundColor Green
}

Write-Host ""
Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host "   Setup Complete!" -ForegroundColor Green
Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Configuration:" -ForegroundColor Yellow
Write-Host "  Savegame path: $savegamePath" -ForegroundColor White
Write-Host "  Config file:   $((Get-Item $envPath).FullName)" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Run the application:  npm run dev" -ForegroundColor White
Write-Host "  2. Open your browser to: http://localhost:8080" -ForegroundColor White
Write-Host "  3. Add the 'Savegame Info' widget from settings" -ForegroundColor White
Write-Host "  4. Play X4 and save your game!" -ForegroundColor White
Write-Host ""
Write-Host "Documentation:" -ForegroundColor Yellow
Write-Host "  Windows Setup:  WINDOWS_SETUP.md" -ForegroundColor White
Write-Host "  Integration:    SAVEGAME_INTEGRATION.md" -ForegroundColor White
Write-Host ""

$startNow = Read-Host "Start the application now? (Y/n)"
if ($startNow -ne "n" -and $startNow -ne "N") {
    Write-Host ""
    Write-Host "Starting X4 External App..." -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Gray
    Write-Host ""
    npm run dev
}
