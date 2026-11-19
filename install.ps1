# Video Download Helper: one-line installer (Windows, PowerShell).
#
#   irm https://raw.githubusercontent.com/kinhsman/video-download-helper/main/install.ps1 | iex
#
# What it does:
#   1. Downloads the latest extension + helper into %USERPROFILE%\.video-download-helper
#   2. Registers the optional yt-dlp helper with Chrome (and Edge, Brave, Chromium if present)
#   3. Opens chrome://extensions so you can Load unpacked (Chrome does not allow scripts to do that step)
# Re-run it any time to update. Nothing outside your user profile is touched, no admin needed.

function Install-VideoDownloadHelper {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $Repo = if ($env:VDH_REPO) { $env:VDH_REPO } else { 'kinhsman/video-download-helper' }
  $Branch = if ($env:VDH_BRANCH) { $env:VDH_BRANCH } else { 'main' }
  $Dest = if ($env:VDH_HOME) { $env:VDH_HOME } else { Join-Path $env:USERPROFILE '.video-download-helper' }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("vdh-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    if ($env:VDH_SRC_DIR) {
      Write-Host "Using local source: $env:VDH_SRC_DIR"
      $src = $env:VDH_SRC_DIR
    } else {
      Write-Host "Downloading $Repo ($Branch)..."
      $zip = Join-Path $tmp 'src.zip'
      Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip
      Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
      $top = Get-ChildItem (Join-Path $tmp 'x') -Directory | Select-Object -First 1
      if (-not $top) { throw 'Download looks empty.' }
      $src = $top.FullName
    }

    foreach ($f in @('extension\manifest.json', 'host\video_helper_host.py', 'host\install.ps1', 'version.json', 'extension-id.txt')) {
      if (-not (Test-Path (Join-Path $src $f))) { throw "Download looks incomplete (missing $f)." }
    }

    $newVersion = (Get-Content (Join-Path $src 'version.json') -Raw | ConvertFrom-Json).version
    $oldVersion = $null
    $oldFile = Join-Path $Dest 'version.json'
    if (Test-Path $oldFile) {
      try { $oldVersion = (Get-Content $oldFile -Raw | ConvertFrom-Json).version } catch { $oldVersion = 'unknown' }
    }

    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    foreach ($d in @('extension', 'host')) {
      $target = Join-Path $Dest $d
      if (Test-Path $target) { Remove-Item -Recurse -Force $target }
      Copy-Item -Recurse -Path (Join-Path $src $d) -Destination $target
    }
    foreach ($f in @('version.json', 'extension-id.txt', 'README.md', 'LICENSE')) {
      $from = Join-Path $src $f
      if (Test-Path $from) { Copy-Item -Force $from (Join-Path $Dest $f) }
    }

    Write-Host ''
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dest 'host\install.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Helper setup failed (see the message above).' }

    Write-Host ''
    if (-not $oldVersion) {
      Write-Host "Installed version $newVersion to $Dest"
      Write-Host ''
      Write-Host 'Last step, in Chrome:'
      Write-Host '  1. chrome://extensions  ->  turn on Developer mode (top right)'
      Write-Host '  2. Load unpacked  ->  pick this folder:'
      Write-Host "       $(Join-Path $Dest 'extension')"
      Write-Host '  3. Click the extension icon, press Enable helper, accept the prompt.'
      if (-not $env:VDH_NO_OPEN) {
        try { Start-Process 'chrome' 'chrome://extensions' } catch { }
      }
    } else {
      Write-Host "Updated $oldVersion -> $newVersion in $Dest"
      Write-Host 'Now reload the extension: chrome://extensions, press the reload arrow on Video Download Helper.'
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Install-VideoDownloadHelper
