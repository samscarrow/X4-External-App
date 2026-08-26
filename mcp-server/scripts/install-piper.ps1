# Installs Piper (local neural TTS) into mcp-server\piper\ for the co-captain's
# speak tool. The speak tool auto-detects piper\piper.exe + voices\*.onnx and
# prefers Piper over the Windows engines.
#
# Usage:
#   .\install-piper.ps1                      # binary + default voice (en_GB-alan-medium)
#   .\install-piper.ps1 -Voice en_US-ryan-high     # add/install a different voice
#
# Voice catalog (name format <lang>_<REGION>-<speaker>-<quality>):
#   https://huggingface.co/rhasspy/piper-voices  (samples: https://rhasspy.github.io/piper-samples/)

param(
    [string]$Voice = 'en_GB-alan-medium'
)

$ErrorActionPreference = 'Stop'
$piperDir = Join-Path $PSScriptRoot '..\piper'
$voicesDir = Join-Path $piperDir 'voices'
New-Item -ItemType Directory -Force $voicesDir | Out-Null

if (-not (Test-Path (Join-Path $piperDir 'piper.exe'))) {
    $zip = Join-Path $env:TEMP 'piper_windows_amd64.zip'
    Write-Host 'Downloading Piper binary (rhasspy/piper 2023.11.14-2)...'
    Invoke-WebRequest 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip' -OutFile $zip
    Expand-Archive $zip -DestinationPath (Join-Path $env:TEMP 'piper_extract') -Force
    Copy-Item (Join-Path $env:TEMP 'piper_extract\piper\*') $piperDir -Recurse -Force
    Remove-Item $zip
    Remove-Item (Join-Path $env:TEMP 'piper_extract') -Recurse -Force
}

# Voice path on HuggingFace: en/en_GB/alan/medium/en_GB-alan-medium.onnx
if ($Voice -notmatch '^([a-z]{2})_([A-Z]{2})-(.+)-([a-z_]+)$') {
    throw "Voice '$Voice' does not look like <lang>_<REGION>-<speaker>-<quality> (e.g. en_GB-alan-medium)"
}
$lang = $Matches[1]; $region = "$($Matches[1])_$($Matches[2])"; $speaker = $Matches[3]; $quality = $Matches[4]
$base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/$lang/$region/$speaker/$quality/$Voice.onnx"

$modelPath = Join-Path $voicesDir "$Voice.onnx"
if (-not (Test-Path $modelPath)) {
    Write-Host "Downloading voice $Voice..."
    Invoke-WebRequest $base -OutFile $modelPath
    Invoke-WebRequest "$base.json" -OutFile "$modelPath.json"
}

Write-Host "Piper ready at $((Resolve-Path $piperDir).Path)"
Get-ChildItem $voicesDir -Filter *.onnx | ForEach-Object { Write-Host "  voice: $($_.BaseName)" }
Write-Host 'The speak tool picks the voice via X4_TTS_VOICE / the voice argument (substring match), else the first model.'
