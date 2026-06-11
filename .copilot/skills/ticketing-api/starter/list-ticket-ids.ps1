<#
.SYNOPSIS
  READ-ONLY helper: list ticket id / ticketNo / status / title / assignee so you can pick a
  disposable ticket for the resolution write-test.

.DESCRIPTION
  Auth is ?key= query param; the key is never printed and errors are redacted.
  Optionally filter client-side by -Status (e.g. Open) to find a safe ticket to mutate.

.EXAMPLE
  $env:TICKETING_API_KEY = '...'
  .\list-ticket-ids.ps1 -Region us -Status Open -Top 20
#>
[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet('us', 'eu', 'apac')]
  [string]$Region = 'us',

  [Parameter()]
  [string]$Timezone = '-5',

  [Parameter()]
  [string]$Status,

  [Parameter()]
  [ValidateRange(1, 200)]
  [int]$Top = 25,

  [Parameter()]
  [ValidateRange(1, 1000)]
  [int]$Limit = 200
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Protect-SensitiveText.ps1')

$apiKey = $env:ticketingAPIKey
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  $apiKey = $env:TICKETING_API_KEY
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'Set ticketingAPIKey (or TICKETING_API_KEY) in terminal before running list-ticket-ids.ps1.'
}

$hosts = @{
  us   = 'teamswork.azure-api.net'
  eu   = 'ticketing-apim-eu.azure-api.net'
  apac = 'ticketing-apim-aus.azure-api.net'
}
$hostName = $hosts[$Region]
if ([string]::IsNullOrWhiteSpace($hostName)) {
  throw "Unsupported region '$($Region)'."
}

$base = "https://$($hostName)/ticketing/v1"
$encodedKey = [uri]::EscapeDataString($apiKey)
$encodedTimezone = [uri]::EscapeDataString($Timezone)

$uri = "$($base)/tickets?timezone=$encodedTimezone&limit=$($Limit)&orderBy=lastInteraction&order=DESC&key=$encodedKey"

try {
  $resp = Invoke-WebRequest -Method 'GET' -Uri $uri -ContentType 'application/json'
}
catch {
  $safeMessage = Protect-SensitiveText -Text $_.Exception.Message
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  throw "List failed (HTTP $code): $safeMessage"
}

$items = @(($resp.Content | ConvertFrom-Json).items)
if ($Status) {
  $items = @($items | Where-Object { $_.status -eq $Status })
}

$items |
  Select-Object -First $Top |
  ForEach-Object {
    [pscustomobject]@{
      TicketNo = $_.ticketNo
      Status   = $_.status
      Id       = $_.id
      Assignee = $_.assignee.email
      Title    = if ($_.title -and $_.title.Length -gt 40) { $_.title.Substring(0, 40) + '...' } else { $_.title }
    }
  } |
  Format-Table -AutoSize
