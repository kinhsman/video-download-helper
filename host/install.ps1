# Registers the optional yt-dlp helper with Chrome and other Chromium browsers (Windows).
# Safe to re-run. Never installs anything without asking.
#   -Refresh   non-interactive: only rewrite the launcher and browser registration
#   -Python    full path of the python to use (the helper passes its own when it updates itself)
param(
  [switch]$Refresh,
  [string]$Python = ''
)
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$HostName = 'com.sang.video_helper'
$ExtId = (Get-Content (Join-Path $Root 'extension-id.txt') -Raw).Trim()

function Test-Python([string]$exe) {
  if (-not $exe) { return $false }
  try {
    & $exe -c "import sys" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

function Find-Python {
  foreach ($name in @('python', 'python3')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    # skip the Microsoft Store "alias" stubs, they open the Store instead of running Python
    if ($cmd -and $cmd.Source -notlike '*\Microsoft\WindowsApps\python*' -and (Test-Python $cmd.Source)) { return $cmd.Source }
  }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    $p = & py -3 -c "import sys;print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Test-Ask([string]$question) {
  if ($Refresh -or $env:VDH_SKIP_TOOLS) { return $false }
  if ($env:VDH_YES -eq '1') { return $true }
  try {
    $ans = Read-Host "$question [y/N]"
    return ($ans -match '^[Yy]')
  } catch { return $false }
}

function Find-Tool([string]$name) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { return $true }
  $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
  return (Test-Path (Join-Path $links "$name.exe"))
}

# --- python ---
if (-not (Test-Python $Python)) { $Python = Find-Python }
if (-not $Python -and -not $Refresh) {
  Write-Host 'Python 3 was not found (the helper needs it).'
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Test-Ask 'Install Python with winget now?')) {
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
    $Python = Find-Python
  }
}
if (-not $Python) {
  throw 'Python 3 not found. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then run this again.'
}

# --- yt-dlp and ffmpeg (optional, for YouTube-style sites) ---
if (-not $Refresh -and -not $env:VDH_SKIP_TOOLS) {
  $tools = @(@{ cmd = 'yt-dlp'; id = 'yt-dlp.yt-dlp' }, @{ cmd = 'ffmpeg'; id = 'Gyan.FFmpeg' })
  foreach ($t in $tools) {
    if (Find-Tool $t.cmd) { continue }
    Write-Host "$($t.cmd) is not installed (needed for YouTube-style sites)."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      if (Test-Ask "Install $($t.cmd) with winget now?") {
        winget install --id $t.id -e --accept-source-agreements --accept-package-agreements
      } else {
        Write-Host "  Skipped. Later: winget install --id $($t.id)"
      }
    } else {
      Write-Host "  Install $($t.cmd) and make sure it is on your PATH."
    }
  }
}

# --- launcher: browsers cannot start a .py directly, so point them at a small .bat ---
$Launcher = Join-Path $Root 'run_host.bat'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$bat = "@echo off`r`n@chcp 65001 >nul`r`n`"$Python`" `"%~dp0host\video_helper_host.py`"`r`n"
[System.IO.File]::WriteAllText($Launcher, $bat, $utf8)

$ManifestPath = Join-Path $Root "$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'Video Download Helper (yt-dlp bridge)'
  path            = $Launcher
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtId/")
}
[System.IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)

# --- register with every Chromium browser that is installed (per user, no admin needed) ---
$browsers = [ordered]@{
  'Chrome'   = 'HKCU:\Software\Google\Chrome'
  'Chromium' = 'HKCU:\Software\Chromium'
  'Edge'     = 'HKCU:\Software\Microsoft\Edge'
  'Brave'    = 'HKCU:\Software\BraveSoftware\Brave-Browser'
}
$registered = 0
foreach ($name in $browsers.Keys) {
  $base = $browsers[$name]
  if ($name -eq 'Chrome' -or (Test-Path $base)) {
    $key = "$base\NativeMessagingHosts\$HostName"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $ManifestPath
    $registered++
    if (-not $Refresh) { Write-Host "Registered helper for: $name" }
  }
}
if (-not $Refresh) { Write-Host "Helper installed for extension $ExtId ($registered browser(s))." }
