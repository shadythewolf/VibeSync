<#
.SYNOPSIS
  Builds the custom VibeSync setup and uninstall windows.

.DESCRIPTION
  Same toolchain as helper/build.ps1: the C# compiler that ships with .NET Framework 4.x,
  plus its WPF assemblies, so no Visual Studio or .NET SDK is needed.

  -Mode uninstall  Builds installer/setup/bin/Uninstall.exe. Run before electron-builder,
                   which ships it in resources/uninstaller (see electron-builder.yml).
  -Mode setup      Builds dist/VibeSync-Setup-<version>.exe around the NSIS package that
                   electron-builder made (dist/VibeSync-Package-<version>.exe).
#>
[CmdletBinding()]
param(
  [ValidateSet('setup', 'uninstall')]
  [string]$Mode = 'setup'
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$repo = Split-Path (Split-Path $root -Parent) -Parent

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path (Join-Path $fw 'csc.exe'))) {
  $fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) {
  throw "csc.exe not found. The .NET Framework 4.x compiler is required (present on all Windows 10/11 installs)."
}
$wpf = Join-Path $fw 'WPF'

$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
# electron-builder's registry key name: UUID v5 of the appId in its own namespace (NsisTarget.js).
$appId = (Select-String -Path (Join-Path $repo 'electron-builder.yml') -Pattern '^appId:\s*(\S+)').Matches[0].Groups[1].Value
$guid = (& node -e "const {UUID}=require('builder-util-runtime');console.log(UUID.v5(process.argv[1],UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')))" $appId).Trim()
if ($LASTEXITCODE -ne 0 -or $guid -notmatch '^[0-9a-f-]{36}$') { throw "Could not compute the app GUID" }

$gen = Join-Path $root 'obj'
New-Item -ItemType Directory -Force -Path $gen | Out-Null
$src = Join-Path $root 'src'
$resources = @(
  "$(Join-Path $src 'Styles.xaml'),Styles.xaml",
  "$(Join-Path $src 'SetupWindow.xaml'),SetupWindow.xaml",
  "$(Join-Path $src 'UninstallWindow.xaml'),UninstallWindow.xaml",
  "$(Join-Path $repo 'build\icon-256.png'),logo.png"
)

if ($Mode -eq 'setup') {
  $package = Join-Path $repo "dist\VibeSync-Package-$version.exe"
  if (-not (Test-Path $package)) { throw "Missing $package. Run electron-builder first." }
  $unpacked = Join-Path $repo 'dist\win-unpacked'
  if (-not (Test-Path $unpacked)) { throw "Missing $unpacked. Run electron-builder first." }
  # The unpacked size drives the progress bar while NSIS installs silently.
  $size = (Get-ChildItem $unpacked -Recurse -File | Measure-Object -Property Length -Sum).Sum
  $resources += "$package,package.exe"
  $out = Join-Path $repo "dist\VibeSync-Setup-$version.exe"
} else {
  $size = 0
  $outDir = Join-Path $root 'bin'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $out = Join-Path $outDir 'Uninstall.exe'
}

$props = Join-Path $gen "$Mode.properties"
@"
mode=$Mode
version=$version
guid=$guid
exe=VibeSync.exe
size=$size
"@ | Set-Content -Path $props -Encoding ASCII
$resources += "$props,setup.properties"

$args = @(
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  '/warn:4',
  "/out:$out",
  "/win32icon:$(Join-Path $repo 'build\icon.ico')",
  "/win32manifest:$(Join-Path $root 'app.manifest')",
  "/reference:$(Join-Path $wpf 'PresentationFramework.dll')",
  "/reference:$(Join-Path $wpf 'PresentationCore.dll')",
  "/reference:$(Join-Path $wpf 'WindowsBase.dll')",
  "/reference:$(Join-Path $fw 'System.Xaml.dll')",
  "/reference:$(Join-Path $fw 'System.Windows.Forms.dll')"
)
foreach ($r in $resources) { $args += "/resource:$r" }
$args += (Get-ChildItem -Path $src -Filter '*.cs' | ForEach-Object { $_.FullName })

Write-Host "Compiling $out with $csc"
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

$bytes = (Get-Item $out).Length
Write-Host "Built $out ($bytes bytes)"
