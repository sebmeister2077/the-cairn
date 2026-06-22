$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  "$env:APPDATA\Vintagestory\Mods\*.dll",
  "$env:APPDATA\Vintagestory\*.dll"
)
$files = Get-ChildItem $paths
foreach ($m in $files) {
  try {
    $asm = [System.Reflection.Assembly]::LoadFrom($m.FullName)
    $types = $null
    try { $types = $asm.GetTypes() } catch [System.Reflection.ReflectionTypeLoadException] { $types = $_.Exception.Types | Where-Object { $_ -ne $null } }
    $hits = $types | Where-Object { $_.Name -match 'Temporal|Storm' }
    foreach ($t in $hits) {
      Write-Host "$($m.Name) :: $($t.FullName)"
    }
  } catch {
    Write-Host "ERR $($m.Name): $($_.Exception.Message)"
  }
}
