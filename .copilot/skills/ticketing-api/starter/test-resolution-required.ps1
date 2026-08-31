<#
.SYNOPSIS
  Diagnostic (WRITE): determine whether the API requires `resolution` when moving a ticket
  to a resolved-state status (Resolved/Closed). Settles whether the tool-schema if/then
  (resolution required for Resolved/Closed) reflects real API behavior or just an assumption.

.DESCRIPTION
  DESTRUCTIVE: this changes a real ticket's status. It is therefore:
    - DRY-RUN by default. It only performs writes when you pass -Confirm.
    - Self-restoring: it records the ticket's original status first and, if the no-resolution
      write unexpectedly SUCCEEDS, it puts the status back.
  Point it at a disposable/test ticket you are comfortable mutating.

  The test: PUT /tickets/{id}/status with { status = <TargetStatus>, user } and NO resolution.
    - HTTP 4xx  -> resolution IS required (no state change occurred). The if/then is correct.
    - HTTP 2xx  -> resolution is NOT required (ticket changed; script restores it). Relax the if/then.

  Read of the ticket uses the assignee as the acting user (status change requires user{id,name,email}).
  Auth is ?key= query param; the key is never printed and errors are redacted.

.EXAMPLE
  # Safe preview, no writes:
  .\test-resolution-required.ps1 -Region us -TicketId <guid>

  # Actually perform the test (will mutate then restore the ticket):
  .\test-resolution-required.ps1 -Region us -TicketId <guid> -Confirm
#>
[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet('us', 'eu', 'apac')]
  [string]$Region = 'us',

  [Parameter()]
  [string]$Timezone = '-5',

  [Parameter(Mandatory = $true)]
  [string]$TicketId,

  [Parameter()]
  [ValidateSet('Resolved', 'Closed')]
  [string]$TargetStatus = 'Resolved',

  # Resolution code used ONLY to restore the ticket if the no-resolution write succeeds
  # and the original status was itself a resolved state.
  [Parameter()]
  [string]$RestoreResolution = 'fixed',

  # Must be supplied to perform any write. Without it, the script only previews.
  [Parameter()]
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Protect-SensitiveText.ps1')

$apiKey = $env:ticketingAPIKey
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  $apiKey = $env:TICKETING_API_KEY
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'Set ticketingAPIKey (or TICKETING_API_KEY) in terminal before running test-resolution-required.ps1.'
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
$encodedId = [uri]::EscapeDataString($TicketId)

# Returns a result object (never throws on HTTP error) so we can inspect 4xx vs 2xx.
function Invoke-Call {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter()][string]$Body
  )
  try {
    $params = @{ Method = $Method; Uri = $Uri; ContentType = 'application/json' }
    if (-not [string]::IsNullOrWhiteSpace($Body)) { $params.Body = $Body }
    $resp = Invoke-WebRequest @params
    return [pscustomobject]@{ Success = $true; StatusCode = [int]$resp.StatusCode; Json = ($resp.Content | ConvertFrom-Json); Error = $null }
  }
  catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    # Prefer the API response body (carries the real validation message) over the generic
    # exception text. ErrorDetails.Message holds it in PowerShell 7 for Invoke-WebRequest.
    $rawMessage = if (-not [string]::IsNullOrWhiteSpace($_.ErrorDetails.Message)) {
      $_.ErrorDetails.Message
    }
    else {
      $_.Exception.Message
    }
    $safeMessage = Protect-SensitiveText -Text $rawMessage
    return [pscustomobject]@{ Success = $false; StatusCode = $status; Json = $null; Error = $safeMessage }
  }
}

# 1. Read the ticket: capture original status and the assignee (acting user).
$ticketResp = Invoke-Call -Method 'GET' -Uri "$($base)/tickets/$($encodedId)?timezone=$encodedTimezone&key=$encodedKey"
if (-not $ticketResp.Success) {
  throw "Could not read ticket $TicketId (HTTP $($ticketResp.StatusCode)): $($ticketResp.Error)"
}
$ticket = if ($null -ne $ticketResp.Json.item) { $ticketResp.Json.item } else { $ticketResp.Json }
$originalStatus = $ticket.status
$assignee = $ticket.assignee

if (-not ($assignee -and $assignee.id -and $assignee.name -and $assignee.email)) {
  throw 'Ticket has no assignee with id/name/email; a status change requires a user. Choose a ticket with an assignee.'
}

$user = @{ id = $assignee.id; name = $assignee.name; email = $assignee.email }

Write-Output ''
Write-Output ('TicketId       : {0}' -f $TicketId)
Write-Output ('OriginalStatus : {0}' -f $originalStatus)
Write-Output ('TargetStatus   : {0} (will be attempted WITHOUT resolution)' -f $TargetStatus)
Write-Output ('ActingUser     : {0}' -f $user.email)

if (-not $Confirm) {
  Write-Output ''
  Write-Output 'DRY RUN: no write performed. Re-run with -Confirm to execute the test (it will'
  Write-Output 'attempt the no-resolution status change and restore the original status afterward).'
  return
}

# 2. Attempt the status change WITHOUT a resolution field.
$noResolutionBody = @{ status = $TargetStatus; user = $user } | ConvertTo-Json -Depth 6
$attempt = Invoke-Call -Method 'PUT' -Uri "$($base)/tickets/$($encodedId)/status?timezone=$encodedTimezone&key=$encodedKey" -Body $noResolutionBody

Write-Output ''
Write-Output '== Result of status change WITHOUT resolution =='
Write-Output ('  HTTP {0}' -f $attempt.StatusCode)
if (-not $attempt.Success -and $attempt.Error) {
  Write-Output ('  Error: {0}' -f $attempt.Error)
}

$resolutionRequired = $null
$restoreOutcome = 'not needed'
$errorLower = if ($attempt.Error) { $attempt.Error.ToLowerInvariant() } else { '' }
$mentionsResolution = $errorLower -match 'resolution'

if ($attempt.Success) {
  $resolutionRequired = $false
  # The write succeeded and the ticket is now $TargetStatus. Restore the original status.
  $restoreBody = if ($originalStatus -in @('Resolved', 'Closed')) {
    @{ status = $originalStatus; resolution = $RestoreResolution; user = $user } | ConvertTo-Json -Depth 6
  }
  else {
    @{ status = $originalStatus; user = $user } | ConvertTo-Json -Depth 6
  }
  $restore = Invoke-Call -Method 'PUT' -Uri "$($base)/tickets/$($encodedId)/status?timezone=$encodedTimezone&key=$encodedKey" -Body $restoreBody
  $restoreOutcome = if ($restore.Success) { "restored to '$originalStatus'" } else { "RESTORE FAILED (HTTP $($restore.StatusCode)): $($restore.Error) -- ticket may still be '$TargetStatus'" }
}
elseif ($attempt.StatusCode -ge 400 -and $attempt.StatusCode -lt 500 -and $mentionsResolution) {
  # Only a 4xx whose message actually concerns resolution proves the requirement. A 4xx for
  # any other reason (e.g. timezone, bad status) is inconclusive for this question.
  $resolutionRequired = $true
}

Write-Output ''
Write-Output '== Verdict =='
if ($resolutionRequired -eq $true) {
  Write-Output '  resolution IS REQUIRED for this status (API rejected the no-resolution write,'
  Write-Output '  and the error message references resolution).'
  Write-Output '  -> The tool-schema if/then (require resolution for Resolved/Closed) is CORRECT.'
}
elseif ($resolutionRequired -eq $false) {
  Write-Output '  resolution is NOT required (API accepted the no-resolution write).'
  Write-Output ('  Restore: {0}' -f $restoreOutcome)
  Write-Output '  -> Relax the tool-schema if/then to description-only guidance.'
}
else {
  Write-Output ('  INCONCLUSIVE: HTTP {0} for a reason unrelated to resolution.' -f $attempt.StatusCode)
  Write-Output ('  API message: {0}' -f $attempt.Error)
  Write-Output '  The no-resolution write was rejected/failed for another reason, so this run does'
  Write-Output '  not prove whether resolution is required. Re-run after addressing the message above.'
}
