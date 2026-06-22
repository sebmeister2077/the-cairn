# Build & package the DeterministicTempStorm mod into a single zip.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Clear stale SDK pin (per workspace memory).
Remove-Item Env:MSBuildSDKsPath -ErrorAction SilentlyContinue

dotnet build -c Release -nologo | Write-Host

$bin   = Join-Path $PSScriptRoot 'bin\Release'
$dll   = Join-Path $bin 'DeterministicTempStorm.dll'
$info  = Join-Path $PSScriptRoot 'modinfo.json'
$out   = Join-Path $PSScriptRoot 'dist'
$zip   = Join-Path $out 'DeterministicTempStorm_1.0.0.zip'

if (!(Test-Path $dll))  { throw "DLL not built: $dll" }
if (!(Test-Path $info)) { throw "modinfo.json missing" }

if (!(Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }
if (Test-Path $zip) { Remove-Item $zip }

Compress-Archive -Path $dll, $info -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Built: $zip"
Write-Host "Install: copy to `$env:APPDATA\Vintagestory\Mods\"
