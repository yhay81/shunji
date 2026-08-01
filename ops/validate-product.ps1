[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerPath = Join-Path $RepoRoot "src\worker.tsx"
$DomainPath = Join-Path $RepoRoot "src\domain\dictionary.ts"
$MigrationPath = Join-Path $RepoRoot "migrations\0001_dictionary.sql"
$AppPath = Join-Path $RepoRoot "public\app.js"
$StylesPath = Join-Path $RepoRoot "public\styles.css"
$SourcePath = Join-Path $RepoRoot "SOURCE.md"
$BuilderPath = Join-Path $RepoRoot "scripts\build_jmdict.py"
$WranglerPath = Join-Path $RepoRoot "wrangler.jsonc"
$PublicDirectory = Join-Path $RepoRoot "public"

$RequiredFiles = @(
    "DECISIONS.md", "EXPERIMENT.md", "METRICS.md", "PRIVACY.md", "README.md", "SECURITY.md", "SOURCE.md", "STACK.md",
    ".github\workflows\ci.yml", "migrations\0001_dictionary.sql", "ops\build-dictionary.ps1", "ops\import-dictionary.ps1",
    "public\app.js", "public\favicon.svg", "public\manifest.webmanifest", "public\styles.css", "public\og.svg",
    "public\robots.txt", "scripts\build_jmdict.py", "src\domain\dictionary.ts", "src\worker.tsx"
)
foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $RelativePath))) { throw "Missing required release file: $RelativePath" }
}

$Worker = Get-Content -Raw -LiteralPath $WorkerPath
$Domain = Get-Content -Raw -LiteralPath $DomainPath
$Migration = Get-Content -Raw -LiteralPath $MigrationPath
$App = Get-Content -Raw -LiteralPath $AppPath
$Styles = Get-Content -Raw -LiteralPath $StylesPath
$Source = Get-Content -Raw -LiteralPath $SourcePath
$Builder = Get-Content -Raw -LiteralPath $BuilderPath
$Wrangler = Get-Content -Raw -LiteralPath $WranglerPath
$ProductSurface = @($Worker, $App) -join "`n"

if (-not $Worker.Contains('class="dictionary-glyph"') -or -not $Worker.Contains('class="entry-card') -or -not $Worker.Contains('class="saved-preview"')) { throw "Expected the dictionary-card visual system" }
if ($ProductSurface -match '(?i)public validation|success criteria|experiment|仮説|成功条件|市場スコア|移行候補|収益性') { throw "Research copy must not appear on the product surface" }
if ($Styles -match '(?i)gradient') { throw "Product CSS must not use gradients" }
if ($Styles -match '(?s)h1\s*\{[^}]*font-size:\s*(?:[4-9]\d|[1-9]\d{2})px') { throw "Primary heading is too large" }
if ($ProductSurface -match '(?i)innerHTML|eval\(|new Function') { throw "Dictionary content must not be interpreted as markup or code" }
if (-not $Worker.Contains('app.post("/api/search"') -or -not $Worker.Contains('Cache-Control", "no-store')) { throw "Search must use a non-cacheable POST API" }
if ($Worker -match '/search\?q=|URLSearchParams\(.+query') { throw "Search text must not enter URLs" }
if (-not $Worker.Contains('await recordEvent(c, entries.length ? "searched" : "no_result")')) { throw "Search quality events must omit query text" }
if ($Migration -match '(?i)search_query|query_text|email|phone_number|telephone|advertising_id|password') { throw "Search, contact, advertising, and authentication data do not belong in storage" }
if (-not $Migration.Contains("CREATE VIRTUAL TABLE entry_fts USING fts5") -or -not $Migration.Contains("content=''")) { throw "Expected a compact FTS5 English index" }
if (-not $Migration.Contains("ON DELETE CASCADE") -or -not $Worker.Contains("35 * 86400")) { throw "Expected bounded telemetry retention and relational cleanup" }
if (-not $Domain.Contains('normalize("NFKC")') -or -not $Domain.Contains("rerankEnglish")) { throw "Expected normalized bilingual search and exact-gloss reranking" }
if (-not $Builder.Contains("EXPECTED_MINIMUM_ENTRIES = 200_000") -or -not $Builder.Contains("source_sha256")) { throw "Dictionary builds must reject partial input and record provenance" }
if (-not $Source.Contains("CC BY-SA 4.0") -or -not $Source.Contains("JMdict")) { throw "Dictionary attribution is incomplete" }
if ($ProductSurface -match '(?i)better-auth|betterAuth') { throw "Account authentication is not needed for local word cards" }
if ($Wrangler.Contains("00000000-0000-0000-0000-000000000000")) { throw "The production D1 database ID has not been configured" }
if ((Get-Item -LiteralPath (Join-Path $PublicDirectory "og.svg")).Length -lt 1500) { throw "Expected a product-specific OG SVG larger than 1.5 KB" }
if ((Get-Item -LiteralPath $AppPath).Length -lt 10000) { throw "Expected a substantial local word-card client" }

$KeyFiles = @(Get-ChildItem -LiteralPath $PublicDirectory -File | Where-Object { $_.Name -match "^[a-zA-Z0-9-]{8,128}\.txt$" })
if ($KeyFiles.Count -ne 1) { throw "Expected exactly one generated IndexNow key file, found $($KeyFiles.Count)" }
$Key = (Get-Content -Raw -LiteralPath $KeyFiles[0].FullName).Trim()
if ($Key -ne $KeyFiles[0].BaseName) { throw "IndexNow key file name and content do not match" }

Write-Output "Product release contract is satisfied"
