# Quick test: header vs query-param auth
# Run with: .\test-auth-header.ps1
# Requires $env:TICKETING_API_KEY to be set

param(
    [ValidateSet('us', 'eu', 'apac')]
    [string]$Region = 'us',
    [string]$Timezone = '0'
)

$hosts = @{
    us   = 'https://teamswork.azure-api.net'
    eu   = 'https://ticketing-apim-eu.azure-api.net'
    apac = 'https://ticketing-apim-aus.azure-api.net'
}

if (-not $hosts.ContainsKey($Region)) {
    Write-Error "Unsupported region '$Region'. Use one of: us, eu, apac."
    exit 1
}

$key = $env:TICKETING_API_KEY
if (-not $key) {
    Write-Error 'Set $env:TICKETING_API_KEY before running this script.'
    exit 1
}

$baseUri = "$($hosts[$Region])/ticketing/v1/instance?timezone=$([uri]::EscapeDataString($Timezone))"
Write-Output "Base URI : $($baseUri)"
Write-Output "Key length: $($key.Length)"
Write-Output ''

# --- Test 1: Ocp-Apim-Subscription-Key header ---
Write-Output '=== Test 1: Ocp-Apim-Subscription-Key header ==='
try {
    $r = Invoke-WebRequest -Uri $baseUri `
        -Headers @{ 'Ocp-Apim-Subscription-Key' = $key } -Method GET -TimeoutSec 15
    Write-Output "HTTP $($r.StatusCode) - OK (header auth works)"
    ($r.Content | ConvertFrom-Json | Select-Object -First 1) | Format-List
} catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'no response' }
    $safeMessage = $_.Exception.Message -replace '([?&]key=)[^&\s]+', '${1}***'
    Write-Output "HTTP $code - FAILED: $safeMessage"
}

Write-Output ''

# --- Test 2: ?key= query param ---
Write-Output '=== Test 2: ?key= query param ==='
$encodedKey = [uri]::EscapeDataString($key)
$queryUri   = "${baseUri}&key=${encodedKey}"
try {
    $r2 = Invoke-WebRequest -Uri $queryUri -Method GET -TimeoutSec 15
    Write-Output "HTTP $($r2.StatusCode) - OK (query param auth works)"
    ($r2.Content | ConvertFrom-Json | Select-Object -First 1) | Format-List
} catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'no response' }
    $safeMessage = $_.Exception.Message -replace '([?&]key=)[^&\s]+', '${1}***'
    Write-Output "HTTP $code - FAILED: $safeMessage"
}
