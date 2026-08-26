# Installs the co-captain command bridge files into the mycu_external_app
# extension of an X4 Foundations installation. Re-run after updating the
# mod from Nexus/GitHub (an update overwrites the patched ui\ea.lua).
#
# Usage:
#   .\install-bridge.ps1                # auto-detect Steam install
#   .\install-bridge.ps1 -GameDir "D:\Games\X4 Foundations"

param(
    [string]$GameDir = "C:\Program Files (x86)\Steam\steamapps\common\X4 Foundations"
)

$ErrorActionPreference = 'Stop'

$extDir = Join-Path $GameDir 'extensions\mycu_external_app'
if (-not (Test-Path (Join-Path $extDir 'content.xml'))) {
    throw "mycu_external_app not found at $extDir - install the mod first (Nexus mod 818 or github.com/mycumycu/mycu_external_app)"
}

$src = Join-Path $PSScriptRoot 'mycu_external_app'
Copy-Item (Join-Path $src 'ui\ea.lua') (Join-Path $extDir 'ui\ea.lua') -Force
New-Item -ItemType Directory -Force (Join-Path $extDir 'md') | Out-Null
Copy-Item (Join-Path $src 'md\cocaptain_bridge.xml') (Join-Path $extDir 'md\cocaptain_bridge.xml') -Force

Write-Host "Co-captain bridge installed into $extDir"
Write-Host "  ui\ea.lua              (patched: parses /api/data reply, acks commands)"
Write-Host "  md\cocaptain_bridge.xml (executes notify/logbook via Mission Director)"
