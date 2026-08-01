[CmdletBinding()]
param(
    [switch]$Refresh
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DataDirectory = Join-Path $RepoRoot "data"
$SourcePath = Join-Path $DataDirectory "JMdict_e.gz"
$DatabasePath = Join-Path $DataDirectory "shunji.sqlite3"
$SqlDirectory = Join-Path $DataDirectory "import"
$SourceUrl = "https://www.edrdg.org/pub/Nihongo/JMdict_e.gz"

New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
if ($Refresh -or -not (Test-Path -LiteralPath $SourcePath)) {
    curl.exe -fL --retry 3 -o $SourcePath $SourceUrl
    if ($LASTEXITCODE -ne 0) { throw "JMdict download failed" }
}

$SourceDate = (Get-Item -LiteralPath $SourcePath).LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
py -3.14 (Join-Path $RepoRoot "scripts\build_jmdict.py") `
    --source $SourcePath `
    --database $DatabasePath `
    --sql-directory $SqlDirectory `
    --source-date $SourceDate
if ($LASTEXITCODE -ne 0) { throw "JMdict build failed" }

Write-Output "Dictionary database: $DatabasePath"
Write-Output "D1 import files: $SqlDirectory"
