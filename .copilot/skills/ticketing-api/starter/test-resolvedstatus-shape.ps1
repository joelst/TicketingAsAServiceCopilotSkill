<#
.SYNOPSIS
  Diagnostic (READ-ONLY): determine the live shape of ITicket.resolvedStatus and whether
  it is present on NON-resolved tickets (not just Resolved/Closed ones).

.DESCRIPTION
  Verified earlier that resolvedStatus comes back as an array (e.g. ["Resolved","Closed"])
  on Closed tickets. Two open questions this script answers against the live API:
    1. Shape: string vs array vs object (confirms the array finding).
    2. Presence by resolution state: if NON-resolved (e.g. Open) tickets also carry a
       populated resolvedStatus, then presence is a workflow property and does NOT imply
       the ticket is resolved. If only resolved tickets carry it, presence implies resolved.

  Also probes which list query params the gateway accepts (selecting resolvedStatus 500s).
  Read-only. Auth is ?key= query param; the key is never printed and errors are redacted.

.EXAMPLE
  $env:TICKETING_API_KEY = '...'
  .\test-resolvedstatus-shape.ps1 -Region us -Timezone -5
#>
[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet('us', 'eu', 'apac')]
  [string]$Region = 'us',

  [Parameter()]
  [string]$Timezone = '-5',

  [Parameter()]
  [ValidateRange(1, 1000)]
  [int]$Limit = 200,

  [Parameter()]
  [ValidateRange(1, 20)]
  [int]$MaxPages = 8,

  # How many tickets to fetch in full per bucket (resolved / non-resolved).
  [Parameter()]
  [ValidateRange(1, 100)]
  [int]$DetailSamples = 15
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Protect-SensitiveText.ps1')

$apiKey = $env:ticketingAPIKey
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  $apiKey = $env:TICKETING_API_KEY
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'Set ticketingAPIKey (or TICKETING_API_KEY) in terminal before running test-resolvedstatus-shape.ps1.'
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

function Get-ValueShape {
  param([object]$Value)

  if ($null -eq $Value) { return 'null' }
  if ($Value -is [string]) { return 'string' }
  # Concrete array / dictionary checks BEFORE the broad IEnumerable test, which would
  # otherwise misclassify hashtables and wrapper types as 'array'.
  if ($Value -is [array] -or $Value -is [object[]]) { return 'array' }
  if ($Value -is [System.Collections.IDictionary]) { return 'object' }
  if ($Value -is [pscustomobject] -or $Value -is [psobject]) { return 'object' }
  if ($Value -is [System.Collections.IEnumerable]) { return 'array' }
  return $Value.GetType().Name
}

function Format-SampleValue {
  param([object]$Value)

  switch (Get-ValueShape $Value) {
    'null'   { return '<null>' }
    'string' { return "'$Value'" }
    'array'  { return '[' + (($Value | ForEach-Object { "'$_'" }) -join ', ') + ']' }
    'object' { return ($Value | ConvertTo-Json -Compress -Depth 4) }
    default  { return [string]$Value }
  }
}

# Returns a result object instead of throwing, so probes can continue past a failure.
function Invoke-Probe {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter()][hashtable]$Headers
  )

  try {
    $params = @{ Method = 'GET'; Uri = $Uri; ContentType = 'application/json' }
    if ($Headers) { $params.Headers = $Headers }
    $resp = Invoke-WebRequest @params
    return [pscustomobject]@{
      Success    = $true
      StatusCode = [int]$resp.StatusCode
      Response   = $resp
      Json       = ($resp.Content | ConvertFrom-Json)
      Error      = $null
    }
  }
  catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    $safeMessage = Protect-SensitiveText -Text $_.Exception.Message
    return [pscustomobject]@{
      Success = $false; StatusCode = $status; Response = $null; Json = $null; Error = $safeMessage
    }
  }
}

$listBase = "$($base)/tickets?timezone=$encodedTimezone&limit=$($Limit)&orderBy=lastInteraction&order=DESC&key=$encodedKey"
$selectField = [uri]::EscapeDataString('id,ticketNo,status,resolvedStatus,firstResolutionOn,lastResolutionOn')

Write-Output ''
Write-Output ('Region={0}  Timezone={1}' -f $Region, $Timezone)
Write-Output '== Step 1: probe which list query params the gateway accepts =='
$probes = [ordered]@{
  'baseline (no select, no isResolved)' = $listBase
  'select includes resolvedStatus'      = "$listBase&select=$selectField"
  'isResolved=true'                     = "$listBase&isResolved=true"
}
foreach ($entry in $probes.GetEnumerator()) {
  $r = Invoke-Probe -Uri $entry.Value
  if ($r.Success) {
    Write-Output ('  [OK  {0}] {1}' -f $r.StatusCode, $entry.Key)
  }
  else {
    Write-Output ('  [FAIL {0}] {1} {2}' -f $r.StatusCode, $entry.Key, $r.Error)
  }
}

# Collect ids into two buckets from the baseline (known-good) list.
Write-Output ''
Write-Output '== Step 2: bucket tickets by resolution state, then inspect full payloads =='
$resolvedIds = [System.Collections.Generic.List[string]]::new()
$openIds = [System.Collections.Generic.List[string]]::new()
$token = $null
for ($page = 0; $page -lt $MaxPages; $page++) {
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($token)) { $headers['continuationToken'] = $token }
  $r = Invoke-Probe -Uri $listBase -Headers $headers
  if (-not $r.Success) { Write-Output ('  list page {0} failed ({1})' -f $page, $r.StatusCode); break }

  foreach ($t in @($r.Json.items)) {
    if (-not $t.id) { continue }
    if ($t.status -in @('Resolved', 'Closed')) {
      if ($resolvedIds.Count -lt $DetailSamples) { $resolvedIds.Add([string]$t.id) }
    }
    elseif ($openIds.Count -lt $DetailSamples) {
      $openIds.Add([string]$t.id)
    }
  }

  if ($resolvedIds.Count -ge $DetailSamples -and $openIds.Count -ge $DetailSamples) { break }
  $token = @($r.Response.Headers['continuationToken'])[0]
  if ([string]::IsNullOrWhiteSpace($token)) { break }
}
Write-Output ('  Resolved/Closed sampled: {0}   Non-resolved sampled: {1}' -f $resolvedIds.Count, $openIds.Count)

function Inspect-Bucket {
  param([string]$Label, [System.Collections.Generic.List[string]]$Ids)

  $shapes = @{}
  $populated = 0
  $samples = [System.Collections.Generic.List[object]]::new()

  foreach ($id in $Ids) {
    $detailUri = "$($base)/tickets/$([uri]::EscapeDataString($id))?timezone=$encodedTimezone&key=$encodedKey"
    $r = Invoke-Probe -Uri $detailUri
    if (-not $r.Success) { continue }
    $ticket = if ($null -ne $r.Json.item) { $r.Json.item } else { $r.Json }

    $hasProperty = $ticket.PSObject.Properties.Name -contains 'resolvedStatus'
    $shape = if (-not $hasProperty) { 'property-absent' } else { Get-ValueShape $ticket.resolvedStatus }
    if (-not $shapes.ContainsKey($shape)) { $shapes[$shape] = 0 }
    $shapes[$shape]++
    if ($hasProperty -and $null -ne $ticket.resolvedStatus) {
      $populated++
      if ($samples.Count -lt 5) {
        $samples.Add([pscustomobject]@{ Status = $ticket.status; Shape = $shape; ResolvedStatus = Format-SampleValue $ticket.resolvedStatus })
      }
    }
  }

  Write-Output ''
  Write-Output ("-- {0} (populated resolvedStatus: {1}/{2}) --" -f $Label, $populated, $Ids.Count)
  $shapes.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Write-Output ('   {0,-16} {1}' -f $_.Key, $_.Value) }
  if ($samples.Count -gt 0) { $samples | Format-Table -AutoSize | Out-String | Write-Output }
  return [pscustomobject]@{ Populated = $populated; Total = $Ids.Count; Shapes = $shapes }
}

$resolvedResult = Inspect-Bucket -Label 'RESOLVED / CLOSED tickets' -Ids $resolvedIds
$openResult = Inspect-Bucket -Label 'NON-RESOLVED (Open/other) tickets' -Ids $openIds

Write-Output ''
Write-Output '== Verdict =='
if ($openResult.Populated -gt 0) {
  Write-Output '  Non-resolved tickets ALSO carry a populated resolvedStatus -> it is a workflow'
  Write-Output '  property (the set of resolved-state labels), NOT a per-ticket resolved signal.'
  Write-Output '  Conclusion: classify by "status is a member of resolvedStatus", never by mere presence.'
}
elseif ($resolvedResult.Populated -gt 0) {
  Write-Output '  Only resolved/closed tickets carry a populated resolvedStatus in this sample.'
  Write-Output '  Presence MAY imply resolved, but membership (status in resolvedStatus) remains the safe test.'
}
else {
  Write-Output '  No populated resolvedStatus observed; inconclusive (try higher -MaxPages/-DetailSamples).'
}
