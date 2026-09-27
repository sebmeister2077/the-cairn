# Builds the mod and packages modinfo.json + the DLL + assets/ into a
# spec-correct zip (forward-slash entries) placed in the Vintage Story Mods
# folder. Windows PowerShell's Compress-Archive / .NET Framework
# ZipFile.CreateFromDirectory write BACKSLASH entry paths, which VS's asset
# loader won't traverse — so we build the archive entries by hand.
#
# Usage:  .\pack.ps1            (installs to %APPDATA%\Vintagestory\Mods)
#         .\pack.ps1 -ModsDir "D:\path\to\Mods"

param(
    [string]$ModsDir = (Join-Path $env:APPDATA "Vintagestory\Mods")
)

$ErrorActionPreference = "Stop"
$proj = $PSScriptRoot

Remove-Item Env:MSBuildSDKsPath -EA SilentlyContinue
dotnet build "$proj\CreatureIconExporter.csproj" -c Release

$stage = Join-Path $env:TEMP ("cie_stage_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$proj\modinfo.json" $stage
Copy-Item "$proj\bin\Release\net10.0\CreatureIconExporter.dll" $stage
Copy-Item "$proj\assets" $stage -Recurse

New-Item -ItemType Directory -Force -Path $ModsDir | Out-Null
$zip = Join-Path $ModsDir "CreatureIconExporter.zip"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[GC]::Collect(); [GC]::WaitForPendingFinalizers()
Remove-Item $zip -Force -EA SilentlyContinue

$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$arch = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($f in Get-ChildItem $stage -Recurse -File) {
    $rel = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $arch.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $es.Write($bytes, 0, $bytes.Length)
    $es.Dispose()
}
$arch.Dispose(); $fs.Dispose()
Remove-Item -Recurse -Force $stage -EA SilentlyContinue

Write-Host "Packaged -> $zip"
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
$z.Entries | Select-Object -ExpandProperty FullName
$z.Dispose()
