<#
.SYNOPSIS
  Verifies that VibeSync was installed correctly by dist\VibeSync-Setup-<Version>.exe.

.DESCRIPTION
  Prints one PASS / FAIL line per check and exits with 0 only when every check passes:

    1. Desktop shortcut      VibeSync.lnk on the Desktop whose target is an existing VibeSync.exe
    2. Start Menu shortcut   VibeSync.lnk under %APPDATA%\Microsoft\Windows\Start Menu\Programs
                             (directly or inside a sub-folder) pointing at the same VibeSync.exe
    3. Uninstall registry    HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<key> with
                             DisplayName 'VibeSync', DisplayVersion <Version> and an UninstallString
                             whose uninstaller executable exists
    4. Native helper         <install dir>\resources\helper\VibeDeckHelper.exe (+ NAudio DLLs)

  Additional lines marked INFO are diagnostics and never affect the exit code.

.PARAMETER Version
  Expected DisplayVersion (defaults to the version in package.json).

.PARAMETER ProductName
  Product / shortcut name (default VibeSync).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-install.ps1 -Version <version>
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$ProductName = 'VibeSync'
)

if ([string]::IsNullOrEmpty($Version)) {
  $Version = (Get-Content -Raw (Join-Path $PSScriptRoot '..\package.json') | ConvertFrom-Json).version
}

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2.0

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

function Get-ShortcutInfo {
  param([string]$Path)
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    return [pscustomobject]@{
      Path       = $Path
      Target     = [string]$lnk.TargetPath
      Arguments  = [string]$lnk.Arguments
      WorkingDir = [string]$lnk.WorkingDirectory
    }
  } catch {
    Write-Info ("Could not read shortcut {0}: {1}" -f $Path, $_.Exception.Message)
    return $null
  }
}

function Get-ExecutableFromCommand {
  # "C:\path\Uninstall VibeSync.exe" /currentuser  ->  C:\path\Uninstall VibeSync.exe
  param([string]$Command)
  if ([string]::IsNullOrWhiteSpace($Command)) { return '' }
  $c = $Command.Trim()
  if ($c.StartsWith('"')) {
    $end = $c.IndexOf('"', 1)
    if ($end -gt 1) { return $c.Substring(1, $end - 1) }
    return $c.Trim('"')
  }
  $m = [regex]::Match($c, '^(.+?\.exe)', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  return $c
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
Write-Host ("VibeSync install verification (expected version {0})" -f $Version) -ForegroundColor Cyan
Write-Host ('=' * 60)

$exeName = "$ProductName.exe"
$lnkName = "$ProductName.lnk"
$installDir = ''

# ---------------------------------------------------------------------------
# 1. Desktop shortcut
# ---------------------------------------------------------------------------
$desktopDirs = Get-UniquePaths @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
)
$desktopLnk = $null
foreach ($d in $desktopDirs) {
  $candidate = Join-Path $d $lnkName
  if (Test-Path -LiteralPath $candidate) { $desktopLnk = $candidate; break }
}
if ($null -eq $desktopLnk) {
  Write-Result 'Desktop shortcut exists' $false ("{0} not found in: {1}" -f $lnkName, ($desktopDirs -join '; '))
  Write-Result 'Desktop shortcut target' $false 'no shortcut to inspect'
} else {
  Write-Result 'Desktop shortcut exists' $true $desktopLnk
  $info = Get-ShortcutInfo $desktopLnk
  if ($null -eq $info) {
    Write-Result 'Desktop shortcut target' $false 'shortcut could not be read'
  } else {
    $targetOk = ($info.Target -and (Test-Path -LiteralPath $info.Target) -and ([IO.Path]::GetFileName($info.Target) -ieq $exeName))
    Write-Result 'Desktop shortcut target' $targetOk ("target = {0}" -f $info.Target)
    if ($targetOk) { $installDir = Split-Path -Parent $info.Target }
  }
}

# ---------------------------------------------------------------------------
# 2. Start Menu shortcut
# ---------------------------------------------------------------------------
$programsDirs = Get-UniquePaths @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)
$startLnk = $null
foreach ($dir in $programsDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $direct = Join-Path $dir $lnkName
  if (Test-Path -LiteralPath $direct) { $startLnk = $direct; break }
  $found = Get-ChildItem -LiteralPath $dir -Recurse -Filter $lnkName -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $found) { $startLnk = $found.FullName; break }
}
if ($null -eq $startLnk) {
  Write-Result 'Start Menu shortcut exists' $false ("{0} not found under: {1}" -f $lnkName, ($programsDirs -join '; '))
} else {
  Write-Result 'Start Menu shortcut exists' $true $startLnk
  $info = Get-ShortcutInfo $startLnk
  if ($null -ne $info) {
    $targetOk = ($info.Target -and (Test-Path -LiteralPath $info.Target) -and ([IO.Path]::GetFileName($info.Target) -ieq $exeName))
    Write-Result 'Start Menu shortcut target' $targetOk ("target = {0}" -f $info.Target)
    if ($targetOk -and -not $installDir) { $installDir = Split-Path -Parent $info.Target }
  } else {
    Write-Result 'Start Menu shortcut target' $false 'shortcut could not be read'
  }
}

# ---------------------------------------------------------------------------
# 3. Uninstall registry entry
# ---------------------------------------------------------------------------
$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$entries = @()
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in (Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
    $props = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $props) { continue }
    $displayName = ''
    if ($props.PSObject.Properties['DisplayName']) { $displayName = [string]$props.DisplayName }
    if (($key.PSChildName -like "*$ProductName*") -or ($displayName -eq $ProductName)) {
      $entries += [pscustomobject]@{
        Key             = ($root -replace '^HK(CU|LM):', 'HK$1') + '\' + $key.PSChildName
        Hive            = $root.Substring(0, 4)
        DisplayName     = $displayName
        DisplayVersion  = $(if ($props.PSObject.Properties['DisplayVersion']) { [string]$props.DisplayVersion } else { '' })
        UninstallString = $(if ($props.PSObject.Properties['UninstallString']) { [string]$props.UninstallString } else { '' })
        InstallLocation = $(if ($props.PSObject.Properties['InstallLocation']) { [string]$props.InstallLocation } else { '' })
        Publisher       = $(if ($props.PSObject.Properties['Publisher']) { [string]$props.Publisher } else { '' })
      }
    }
  }
}
# Prefer the per-user (HKCU) entry: the installer is perMachine: false.
$entry = $entries | Where-Object { $_.Hive -eq 'HKCU' } | Select-Object -First 1
if ($null -eq $entry) { $entry = $entries | Select-Object -First 1 }

if ($null -eq $entry) {
  Write-Result 'Uninstall registry entry exists' $false ("no key containing '{0}' or DisplayName '{0}' under HKCU/HKLM Uninstall" -f $ProductName)
  Write-Result 'Uninstall entry DisplayName' $false 'no entry'
  Write-Result 'Uninstall entry DisplayVersion' $false 'no entry'
  Write-Result 'Uninstall entry UninstallString' $false 'no entry'
} else {
  Write-Result 'Uninstall registry entry exists' $true $entry.Key
  if ($entries.Count -gt 1) { Write-Info ("{0} matching uninstall entries found; checking {1}" -f $entries.Count, $entry.Key) }
  if ($entry.Hive -ne 'HKCU') { Write-Info 'Entry lives in HKLM (per-machine install); the assisted installer normally writes HKCU.' }
  Write-Result 'Uninstall entry DisplayName' ($entry.DisplayName -eq $ProductName) ("DisplayName = '{0}'" -f $entry.DisplayName)
  Write-Result 'Uninstall entry DisplayVersion' ($entry.DisplayVersion -eq $Version) ("DisplayVersion = '{0}', expected '{1}'" -f $entry.DisplayVersion, $Version)
  $uninstallExe = Get-ExecutableFromCommand $entry.UninstallString
  $uninstallOk = ($uninstallExe -and (Test-Path -LiteralPath $uninstallExe))
  Write-Result 'Uninstall entry UninstallString' $uninstallOk ("UninstallString = {0}" -f $entry.UninstallString)
  if ($entry.Publisher) { Write-Info ("Publisher = {0}" -f $entry.Publisher) }
  if ($entry.InstallLocation) {
    Write-Info ("InstallLocation = {0}" -f $entry.InstallLocation)
    if (-not $installDir -and (Test-Path -LiteralPath $entry.InstallLocation)) { $installDir = $entry.InstallLocation.TrimEnd('\') }
  } elseif ($uninstallOk -and -not $installDir) {
    $installDir = Split-Path -Parent $uninstallExe
  }
}

# ---------------------------------------------------------------------------
# 4. Installed files: VibeSync.exe + resources\helper\*
# ---------------------------------------------------------------------------
if (-not $installDir) {
  $default = Join-Path $env:LOCALAPPDATA ("Programs\{0}" -f $ProductName)
  if (Test-Path -LiteralPath (Join-Path $default $exeName)) { $installDir = $default }
}
if (-not $installDir) {
  Write-Result 'Installed VibeSync.exe' $false 'install directory could not be determined from shortcuts or registry'
  Write-Result 'Helper VibeDeckHelper.exe' $false 'install directory unknown'
} else {
  $exePath = Join-Path $installDir $exeName
  $exeOk = Test-Path -LiteralPath $exePath
  Write-Result 'Installed VibeSync.exe' $exeOk $exePath
  if ($exeOk) {
    try {
      $vi = (Get-Item -LiteralPath $exePath).VersionInfo
      Write-Info ("VibeSync.exe ProductVersion = {0}, FileVersion = {1}" -f $vi.ProductVersion, $vi.FileVersion)
    } catch { }
  }
  $helperDir = Join-Path $installDir 'resources\helper'
  $helperExe = Join-Path $helperDir 'VibeDeckHelper.exe'
  $helperOk = Test-Path -LiteralPath $helperExe
  Write-Result 'Helper VibeDeckHelper.exe' $helperOk $helperExe
  $missing = @()
  foreach ($f in @('NAudio.Core.dll', 'NAudio.Wasapi.dll', 'VibeDeckHelper.exe.config')) {
    if (-not (Test-Path -LiteralPath (Join-Path $helperDir $f))) { $missing += $f }
  }
  $depsOk = ($missing.Count -eq 0)
  Write-Result 'Helper dependencies (NAudio DLLs, exe.config)' $depsOk $(if ($depsOk) { $helperDir } else { "missing: " + ($missing -join ', ') })

  # Informational extras written by installer\installer.nsh / the app itself.
  $appPaths = "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
  if (Test-Path $appPaths) {
    $ap = Get-ItemProperty -Path $appPaths -ErrorAction SilentlyContinue
    $apDefault = ''
    if ($null -ne $ap -and $ap.PSObject.Properties['(default)']) { $apDefault = [string]$ap.'(default)' }
    Write-Info ("App Paths entry present: {0}" -f $apDefault)
  } else {
    Write-Info 'App Paths entry (HKCU\...\App Paths\VibeSync.exe) not present'
  }
  $run = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  if ($null -ne $run -and ($run.PSObject.Properties[$ProductName] -or $run.PSObject.Properties["electron.app.$ProductName"])) {
    Write-Info 'Start-with-Windows Run entry is present (user opted in)'
  } else {
    Write-Info 'Start-with-Windows Run entry not present (default)'
  }
  $appData = Join-Path $env:APPDATA $ProductName
  if (Test-Path -LiteralPath $appData) { Write-Info ("User data folder exists: {0}" -f $appData) }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
$total = $script:Results.Count
$passed = @($script:Results | Where-Object { $_.Ok }).Count
Write-Host ('=' * 60)
if ($passed -eq $total) {
  Write-Host ("RESULT: PASS ({0}/{1} checks)" -f $passed, $total) -ForegroundColor Green
  exit 0
} else {
  Write-Host ("RESULT: FAIL ({0}/{1} checks passed)" -f $passed, $total) -ForegroundColor Red
  foreach ($r in ($script:Results | Where-Object { -not $_.Ok })) { Write-Host ("  - {0}" -f $r.Name) -ForegroundColor Red }
  exit 1
}
