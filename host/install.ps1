# Registers the optional yt-dlp helper with Chrome and other Chromium browsers (Windows).
# Safe to re-run. Fully non-interactive: it installs Python, yt-dlp and ffmpeg with winget when missing.
#   set VDH_NO_INSTALL=1 to forbid installing anything, VDH_SKIP_TOOLS=1 to skip yt-dlp and ffmpeg
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

# After winget installs something, this window's PATH is stale. Re-read it from the registry.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join ';'
}

# Silent install through winget. Never prompts. Returns $true when winget reported success.
function Install-WithWinget([string]$id, [string]$label, [switch]$UserScope) {
  if ($env:VDH_NO_INSTALL) { Write-Host "  Skipping $label (VDH_NO_INSTALL is set)."; return $false }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "  winget is not available, so $label cannot be installed automatically."
    return $false
  }
  Write-Host "Installing $label (silent)..."
  $wingetArgs = @('install', '--id', $id, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
  if ($UserScope) { $wingetArgs += @('--scope', 'user') }
  & winget @wingetArgs | Out-Null
  $code = $LASTEXITCODE
  Update-SessionPath
  # 0x8A15002B (no newer version) and 0x8A150061 (already installed) both mean it is there already.
  if ($code -eq 0) { return $true }
  if ($code -eq -1978335189 -or $code -eq -1978335135) {
    Write-Host "  $label is already installed."
    return $true
  }
  Write-Host "  winget could not install $label (exit code $code)."
  return $false
}

function Find-Tool([string]$name) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { return $true }
  $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
  return (Test-Path (Join-Path $links "$name.exe"))
}

# --- python ---
# A window opened before Python was installed has a stale PATH, so re-read it first.
Update-SessionPath
if (-not (Test-Python $Python)) { $Python = Find-Python }
if (-not $Python -and -not $Refresh) {
  Write-Host 'Python 3 was not found (the helper needs it).'
  [void](Install-WithWinget 'Python.Python.3.12' 'Python 3.12' -UserScope)
  $Python = Find-Python
}
if (-not $Python) {
  throw 'Python 3 not found. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then run this again.'
}

# --- yt-dlp and ffmpeg (for YouTube-style sites). Failures here are not fatal. ---
if (-not $Refresh -and -not $env:VDH_SKIP_TOOLS) {
  $tools = @(@{ cmd = 'yt-dlp'; id = 'yt-dlp.yt-dlp' }, @{ cmd = 'ffmpeg'; id = 'Gyan.FFmpeg' })
  foreach ($t in $tools) {
    if (Find-Tool $t.cmd) { continue }
    Write-Host "$($t.cmd) is not installed (needed for YouTube-style sites)."
    [void](Install-WithWinget $t.id $t.cmd)
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
