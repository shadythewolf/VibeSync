<#
.SYNOPSIS
  Verifies that VibeSync was removed completely by its uninstaller.

.DESCRIPTION
  The mirror image of verify-install.ps1. Prints PASS / FAIL per check and exits 0 only when
  every trace the installer created is gone:

    1. No Desktop shortcut         VibeSync.lnk (user and common desktop)
    2. No Start Menu shortcut      VibeSync.lnk anywhere under Programs (user and common)
    3. No uninstall registry entry under HKCU / HKLM ...\CurrentVersion\Uninstall
    4. No installed VibeSync.exe   in the install directory (default %LOCALAPPDATA%\Programs\VibeSync)
    5. No App Paths registry key   HKCU\...\App Paths\VibeSync.exe (written by installer\installer.nsh)
    6. No Run (start-up) entry     HKCU\...\CurrentVersion\Run\VibeSync

  Settings in %APPDATA%\VibeSync are intentionally preserved by the uninstaller
  (deleteAppDataOnUninstall: false); their presence is reported as INFO only.

.PARAMETER InstallDir
  Directory the app was installed to. Default: %LOCALAPPDATA%\Programs\VibeSync.

.PARAMETER ProductName
  Product / shortcut name (default VibeSync).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$ProductName = 'VibeSync'
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2.0

if ([string]::IsNullOrEmpty($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA ("Programs\{0}" -f $ProductName) }

$script:Results = New-Object System.Collections.ArrayList

function Write-Result {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  $color = if ($Ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1}" -f $tag, $Name) -ForegroundColor $color -NoNewline
  if ($Detail) { Write-Host (" - {0}" -f $Detail) } else { Write-Host '' }
  [void]$script:Results.Add([pscustomobject]@{ Name = $Name; Ok = $Ok })
}

function Write-Info {
  param([string]$Text)
  Write-Host ("[INFO] {0}" -f $Text) -ForegroundColor DarkGray
}

function Get-UniquePaths {
  param([string[]]$Paths)
  $seen = @{}
  $out = @()
  foreach ($p in $Paths) {
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    $key = $p.TrimEnd('\').ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $out += $p }
  }
  return $out
}

Write-Host ''
Write-Host 'VibeSync uninstall verification' -ForegroundColor Cyan
Write-Host ('=' * 60)

$exeName = "$ProductName.exe"
$lnkName = "$ProductName.lnk"

# 1. Desktop shortcut gone
$desktopDirs = Get-UniquePaths @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
)
$leftover = @()
foreach ($d in $desktopDirs) {
  $candidate = Join-Path $d $lnkName
  if (Test-Path -LiteralPath $candidate) { $leftover += $candidate }
}
Write-Result 'Desktop shortcut removed' ($leftover.Count -eq 0) $(if ($leftover.Count -eq 0) { "checked: " + ($desktopDirs -join '; ') } else { "still present: " + ($leftover -join '; ') })

# 2. Start Menu shortcut gone
$programsDirs = Get-UniquePaths @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)
$leftover = @()
foreach ($dir in $programsDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $found = Get-ChildItem -LiteralPath $dir -Recurse -Filter $lnkName -File -ErrorAction SilentlyContinue
  foreach ($f in @($found)) { if ($null -ne $f) { $leftover += $f.FullName } }
}
Write-Result 'Start Menu shortcut removed' ($leftover.Count -eq 0) $(if ($leftover.Count -eq 0) { "checked: " + ($programsDirs -join '; ') } else { "still present: " + ($leftover -join '; ') })

# 3. Uninstall registry entry gone
$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$leftover = @()
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in (Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
    $props = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
    $displayName = ''
    if ($null -ne $props -and $props.PSObject.Properties['DisplayName']) { $displayName = [string]$props.DisplayName }
    if (($key.PSChildName -like "*$ProductName*") -or ($displayName -eq $ProductName)) {
      $leftover += (($root -replace '^HK(CU|LM):', 'HK$1') + '\' + $key.PSChildName)
    }
  }
}
Write-Result 'Uninstall registry entry removed' ($leftover.Count -eq 0) $(if ($leftover.Count -eq 0) { 'no HKCU/HKLM Uninstall key references VibeSync' } else { "still present: " + ($leftover -join '; ') })

# 4. Installed executable gone
$exePath = Join-Path $InstallDir $exeName
$exeGone = -not (Test-Path -LiteralPath $exePath)
Write-Result 'Installed VibeSync.exe removed' $exeGone $exePath
if (Test-Path -LiteralPath $InstallDir) {
  $remaining = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File -ErrorAction SilentlyContinue)
  if ($remaining.Count -eq 0) {
    Write-Info ("Install directory still exists but is empty: {0}" -f $InstallDir)
  } else {
    Write-Result 'Install directory emptied' $false ("{0} file(s) remain in {1} (e.g. {2})" -f $remaining.Count, $InstallDir, $remaining[0].Name)
  }
} else {
  Write-Result 'Install directory removed' $true $InstallDir
}

# 5. App Paths key gone (installer.nsh customUnInstall)
$appPaths = "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
Write-Result 'App Paths registry key removed' (-not (Test-Path $appPaths)) ($appPaths -replace '^HKCU:', 'HKCU')
$appPathsMachine = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
if (Test-Path $appPathsMachine) { Write-Info ("Per-machine App Paths key still present: {0}" -f $appPathsMachine) }

# 6. Run entry gone
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$run = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
$runLeft = @()
if ($null -ne $run) {
  foreach ($name in @($ProductName, "electron.app.$ProductName")) {
    if ($run.PSObject.Properties[$name]) { $runLeft += $name }
  }
}
Write-Result 'Start-with-Windows Run entry removed' ($runLeft.Count -eq 0) $(if ($runLeft.Count -eq 0) { 'HKCU\...\CurrentVersion\Run has no VibeSync value' } else { "still present: " + ($runLeft -join ', ') })

# Info: user data is preserved by design.
$appData = Join-Path $env:APPDATA $ProductName
if (Test-Path -LiteralPath $appData) {
  Write-Info ("User settings preserved (by design) in {0}; delete the folder to remove them." -f $appData)
} else {
  Write-Info ("No user data folder at {0}" -f $appData)
}

# Summary
$total = $script:Results.Count
$passed = @($script:Results | Where-Object { $_.Ok }).Count
Write-Host ('=' * 60)
if ($passed -eq $total) {
  Write-Host ("RESULT: PASS ({0}/{1} checks) - VibeSync is fully uninstalled" -f $passed, $total) -ForegroundColor Green
  exit 0
} else {
  Write-Host ("RESULT: FAIL ({0}/{1} checks passed)" -f $passed, $total) -ForegroundColor Red
  foreach ($r in ($script:Results | Where-Object { -not $_.Ok })) { Write-Host ("  - {0}" -f $r.Name) -ForegroundColor Red }
  exit 1
}
