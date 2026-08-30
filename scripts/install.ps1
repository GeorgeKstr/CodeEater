<#
CodeEater installer - Windows (native PowerShell).

One-liner (public repo):
  powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/GeorgeKstr/CodeEater/master/scripts/install.ps1 | iex"

Private repo / developer:
  git clone git@github.com:GeorgeKstr/CodeEater.git
  cd CodeEater
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1

Options:
  -Branch <name>       branch/ref to install (default: master)
  -InstallDir <path>   install location (default: $env:LOCALAPPDATA\CodeEater)
  -Token <ghpat>       GitHub personal access token (required for the private repo via tarball)
  -SkipBuild           reuse an existing build
  -Uninstall           remove shortcuts + install dir
#>
param(
  [string]$Branch = "master",
  [string]$InstallDir = "$env:LOCALAPPDATA\CodeEater",
  [string]$Token = "",
  [switch]$SkipBuild,
  [switch]$Uninstall,
  [switch]$Tarball
)
$ErrorActionPreference = "Stop"
$Repo = "GeorgeKstr/CodeEater"

function Write-Log($msg) { Write-Host "[coe] $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  foreach ($p in @("$([Environment]::GetFolderPath('Desktop'))\CodeEater.lnk",
                   "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\CodeEater.lnk")) {
    if (Test-Path $p) { Remove-Item $p -Force }
  }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Log "uninstalled: shortcuts + $InstallDir"
  exit 0
}

# ------------------------------------------------------------ prerequisites
foreach ($tool in @("node", "npm", "git")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "[coe-error] $tool not found. install node (https://nodejs.org) and git (https://git-scm.com), then re-run." -ForegroundColor Red
    exit 1
  }
}
$nodeMajor = [int]((node -v) -replace '^v', '' -replace '\..*$', '')
if ($nodeMajor -lt 18) {
  Write-Host "[coe-error] node >= 18 required (found $(node -v))." -ForegroundColor Red
  exit 1
}

# --------------------------------------------------------------- fetch repo
$isCheckout = Test-Path (Join-Path $PSScriptRoot "..\package.json")
if ($isCheckout) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  Write-Log "using existing checkout: $Root"
} else {
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path $InstallDir) -Force | Out-Null

  if ($Tarball) {
    $headers = @{}
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    Write-Log "downloading $Repo tarball ($Branch)..."
    $tmp = Join-Path $env:TEMP "coe.tar.gz"
    Invoke-WebRequest -Uri "https://api.github.com/repos/$Repo/tarball/$Branch" -Headers $headers -OutFile $tmp
    tar -xzf $tmp -C (Split-Path $InstallDir) --strip-components 1
    if (Test-Path (Join-Path $env:TEMP "coe")) { Move-Item (Join-Path $env:TEMP "coe") $InstallDir }
    if (-not (Test-Path $InstallDir)) {
      # tar may have extracted under a hashed dir name
      $extracted = Get-ChildItem (Split-Path $InstallDir) -Directory | Where-Object { $_.Name -like "CodeEater-*" } | Select-Object -First 1
      if ($extracted) { Move-Item $extracted.FullName $InstallDir }
    }
  } else {
    Write-Log "cloning $Repo ($Branch)..."
    $httpsUrl = "https://github.com/$Repo.git"
    $sshUrl = "git@github.com:$Repo.git"
    git clone --depth 1 --branch $Branch $httpsUrl $InstallDir 2>$null
    if ($LASTEXITCODE -ne 0) {
      git clone --depth 1 --branch $Branch $sshUrl $InstallDir
    }
  }
  $Root = $InstallDir
}

# -------------------------------------------------------------------- build
if (-not $SkipBuild) {
  if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Log "npm install (this downloads Electron + builds native modules)..."
    Push-Location $Root
    if (Test-Path "package-lock.json") { npm ci } else { npm install }
    Pop-Location
  } else {
    Write-Log "dependencies already present - skipping npm install"
  }
  Write-Log "building..."
  Push-Location $Root
  npm run build
  Pop-Location
}
if (-not (Test-Path (Join-Path $Root "out\main\index.js"))) {
  Write-Host "[coe-error] build did not produce out\main\index.js" -ForegroundColor Red
  exit 1
}

# --------------------------------------------------------------- shortcuts
$Wsh = New-Object -ComObject WScript.Shell
$launcher = Join-Path $Root "scripts\coe.cmd"
$ico = Join-Path $Root "build\icon.ico"
$lnkTargets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "CodeEater.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\CodeEater.lnk")
)
foreach ($lnk in $lnkTargets) {
  $dir = Split-Path $lnk
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $s = $Wsh.CreateShortcut($lnk)
  $s.TargetPath = $launcher
  $s.WorkingDirectory = $Root
  $s.IconLocation = "$ico,0"
  $s.Description = "AI-native code editor"
  $s.Save()
  Write-Log "shortcut: $lnk"
}

Write-Host ""
Write-Log "Done. Launch from the CodeEater shortcut, or:"
Write-Log "  \"$launcher\"              open CodeEater"
Write-Log "  \"$launcher\" .            open the current folder"
Write-Log "  \"$launcher\" C:\path      open a specific folder"