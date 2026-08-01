[CmdletBinding()]
param([switch]$Local)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SqlDirectory = Join-Path $RepoRoot "data\import"
$Wrangler = Join-Path $RepoRoot "node_modules\.bin\wrangler.cmd"
$Target = if ($Local) { "--local" } else { "--remote" }

if (-not (Test-Path -LiteralPath $SqlDirectory)) {
    throw "Dictionary imports are missing. Run npm run dictionary:build first."
}

$Files = @(Get-ChildItem -LiteralPath $SqlDirectory -Filter "*.sql" -File | Sort-Object Name)
if ($Files.Count -ne 5) { throw "Expected five dictionary import files, found $($Files.Count)" }

foreach ($File in $Files) {
    Write-Output "Importing $($File.Name) ($([Math]::Round($File.Length / 1MB, 1)) MiB)"
    $ImportOutput = & $Wrangler d1 execute shunji $Target --file $File.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        $ImportOutput | Select-Object -Last 40 | Write-Output
        throw "D1 import failed for $($File.Name)"
    }
}

$Output = & $Wrangler d1 execute shunji $Target --json --command "SELECT (SELECT COUNT(*) FROM entries) AS entries,(SELECT COUNT(*) FROM terms) AS terms,(SELECT COUNT(*) FROM entry_fts) AS fts;"
if ($LASTEXITCODE -ne 0) { throw "D1 import verification failed" }
$Payload = ($Output -join [Environment]::NewLine) | ConvertFrom-Json
$Row = $Payload[0].results[0]
if ([int]$Row.entries -lt 200000 -or [int]$Row.terms -lt 400000 -or [int]$Row.fts -ne [int]$Row.entries) {
    throw "D1 dictionary counts are incomplete: $($Row | ConvertTo-Json -Compress)"
}
$Row | ConvertTo-Json
