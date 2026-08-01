[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^https://")]
    [string]$BaseUrl
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PublicDirectory = Join-Path $RepoRoot "public"
$NormalizedBaseUrl = $BaseUrl.TrimEnd("/")
$KeyFiles = @(
    Get-ChildItem -LiteralPath $PublicDirectory -File |
        Where-Object { $_.Name -match "^[a-zA-Z0-9-]{8,128}\.txt$" }
)
if ($KeyFiles.Count -ne 1) { throw "Expected exactly one IndexNow key file, found $($KeyFiles.Count)" }
$Key = (Get-Content -Raw -LiteralPath $KeyFiles[0].FullName).Trim()
if ($Key -ne $KeyFiles[0].BaseName) { throw "IndexNow key file name and content do not match" }

$KeyLocation = "$NormalizedBaseUrl/$Key.txt"
$KeyResponse = Invoke-WebRequest -Uri $KeyLocation -SkipHttpErrorCheck -TimeoutSec 30
if ($KeyResponse.StatusCode -ne 200 -or $KeyResponse.Content.Trim() -ne $Key) {
    throw "Published IndexNow key file is unavailable or mismatched"
}

$SitemapResponse = Invoke-WebRequest -Uri "$NormalizedBaseUrl/sitemaps/static.xml?v=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -SkipHttpErrorCheck -TimeoutSec 30
if ($SitemapResponse.StatusCode -ne 200) { throw "Published static sitemap is unavailable" }
[xml]$Sitemap = $SitemapResponse.Content
$Urls = @($Sitemap.urlset.url.loc | ForEach-Object { [string]$_ })
if ($Urls.Count -ne 4) { throw "Expected four stable URLs in the static sitemap" }

$Payload = @{
    host = ([uri]$NormalizedBaseUrl).Host
    key = $Key
    keyLocation = $KeyLocation
    urlList = $Urls
} | ConvertTo-Json -Depth 3
$Response = Invoke-WebRequest -Uri "https://api.indexnow.org/indexnow" -Method Post -ContentType "application/json; charset=utf-8" -Body $Payload -SkipHttpErrorCheck -TimeoutSec 30
if ($Response.StatusCode -notin @(200, 202)) { throw "IndexNow submission failed with HTTP $($Response.StatusCode)" }

[ordered]@{
    submitted_at = (Get-Date).ToUniversalTime().ToString("o")
    service = ([uri]$NormalizedBaseUrl).Host
    status = [int]$Response.StatusCode
    url_count = $Urls.Count
    urls = $Urls
} | ConvertTo-Json -Depth 3
