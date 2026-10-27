<#
.SYNOPSIS
  Builds VibeDeckHelper.exe (WASAPI loopback + Windows media session bridge).

.DESCRIPTION
  Uses the C# compiler that ships with the .NET Framework 4.x on every Windows 10/11
  machine (no Visual Studio or .NET SDK required). Output goes to helper/bin.

  References:
    - helper/lib/NAudio.Core.dll, helper/lib/NAudio.Wasapi.dll (MIT, netstandard2.0)
    - netstandard.dll facade from the .NET Framework directory
    - WinRT metadata from C:\Windows\System32\WinMetadata (Windows.Media / Foundation / Storage)
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [string]$Icon = ''
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not available while parameter defaults are evaluated in Windows PowerShell 5.1.
$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $root 'bin' }
if ([string]::IsNullOrEmpty($Icon)) { $Icon = Join-Path (Split-Path $root -Parent) 'build\icon.ico' }

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path (Join-Path $fw 'csc.exe'))) {
  $fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) {
  throw "csc.exe not found. The .NET Framework 4.x compiler is required (present on all Windows 10/11 installs)."
}
$winmd = Join-Path $env:WINDIR 'System32\WinMetadata'
foreach ($m in @('Windows.Media.winmd', 'Windows.Foundation.winmd', 'Windows.Storage.winmd')) {
  if (-not (Test-Path (Join-Path $winmd $m))) { throw "Missing WinRT metadata: $m" }
}

$src = Join-Path $root 'src'
$lib = Join-Path $root 'lib'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$sources = Get-ChildItem -Path $src -Filter '*.cs' | ForEach-Object { $_.FullName }
if ($sources.Count -eq 0) { throw "No C# sources found in $src" }

$exe = Join-Path $OutDir 'VibeDeckHelper.exe'

$args = @(
  '/nologo',
  '/target:exe',
  '/platform:anycpu',
  '/optimize+',
  '/warn:3',
  '/nowarn:1701,1702',
  "/out:$exe",
  "/reference:$(Join-Path $lib 'NAudio.Core.dll')",
  "/reference:$(Join-Path $lib 'NAudio.Wasapi.dll')",
  "/reference:$(Join-Path $fw 'netstandard.dll')",
  "/reference:$(Join-Path $fw 'System.Runtime.dll')",
  "/reference:$(Join-Path $fw 'System.Runtime.InteropServices.WindowsRuntime.dll')",
  "/reference:$(Join-Path $winmd 'Windows.Media.winmd')",
  "/reference:$(Join-Path $winmd 'Windows.Foundation.winmd')",
  "/reference:$(Join-Path $winmd 'Windows.Storage.winmd')"
)
if (Test-Path $Icon) { $args += "/win32icon:$Icon" }
$args += $sources

Write-Host "Compiling VibeDeckHelper.exe with $csc"
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Copy-Item (Join-Path $lib 'NAudio.Core.dll') $OutDir -Force
Copy-Item (Join-Path $lib 'NAudio.Wasapi.dll') $OutDir -Force

# App config: make sure the exe binds to the installed .NET Framework 4.x runtime.
@'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <startup>
    <supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" />
    <supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.7.2" />
  </startup>
  <runtime>
    <AppContextSwitchOverrides value="Switch.System.Globalization.NoAsyncCurrentCulture=true" />
    <gcConcurrent enabled="false" />
  </runtime>
</configuration>
'@ | Set-Content -Path (Join-Path $OutDir 'VibeDeckHelper.exe.config') -Encoding UTF8

@'
VibeDeck Audio Helper
=====================
VibeDeckHelper.exe captures Windows system audio (WASAPI loopback) and reads the
Windows media session (title / artist / artwork) for the VibeDeck app.
It is started automatically by VibeDeck and needs no manual setup.

Diagnostics:  VibeDeckHelper.exe --selftest

Third-party: NAudio (MIT) - https://github.com/naudio/NAudio
'@ | Set-Content -Path (Join-Path $OutDir 'README.txt') -Encoding UTF8

$size = (Get-Item $exe).Length
Write-Host "Built $exe ($size bytes)"
