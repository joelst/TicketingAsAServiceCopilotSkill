[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet('us', 'eu', 'apac')]
  [string]$Region = 'us',

  [Parameter()]
  [string]$Timezone = '-5',

  [Parameter(Mandatory = $true)]
  [string]$AssigneeEmail,

  [Parameter(Mandatory = $true)]
  [string]$RequestorEmail,

  [Parameter()]
  [ValidateRange(1, 1000)]
  [int]$Limit = 200,

  [Parameter()]
  [ValidateRange(1, 20)]
  [int]$MaxPages = 8,

  [Parameter()]
  [bool]$AllowResolvedFallback = $true
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Protect-SensitiveText.ps1')

$apiKey = $env:ticketingAPIKey
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  $apiKey = $env:TICKETING_API_KEY
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'Set ticketingAPIKey (or TICKETING_API_KEY) in terminal before running write-test-closed-ticket-comment.ps1.'
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
$all = @()
$token = $null

function Invoke-SafeWebRequest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [Parameter()]
    [hashtable]$Headers,

    [Parameter()]
    [string]$ContentType,

    [Parameter()]
    [string]$Body
  )

  try {
    $params = @{
      Method = $Method
      Uri    = $Uri
    }

    if ($Headers) {
      $params.Headers = $Headers
    }
    if (-not [string]::IsNullOrWhiteSpace($ContentType)) {
      $params.ContentType = $ContentType
    }
    if (-not [string]::IsNullOrWhiteSpace($Body)) {
      $params.Body = $Body
    }

    return Invoke-WebRequest @params
  }
  catch {
    $safeUri = Protect-SensitiveText -Text $Uri
    $safeMessage = Protect-SensitiveText -Text $_.Exception.Message
    throw "HTTP request failed. Method=$Method Uri=$safeUri Message=$safeMessage"
  }
}

function Invoke-SafeRestMethod {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [Parameter()]
    [hashtable]$Headers,

    [Parameter()]
    [string]$ContentType,

    [Parameter()]
    [string]$Body
  )

  try {
    $params = @{
      Method = $Method
      Uri    = $Uri
    }

    if ($Headers) {
      $params.Headers = $Headers
    }
    if (-not [string]::IsNullOrWhiteSpace($ContentType)) {
      $params.ContentType = $ContentType
    }
    if (-not [string]::IsNullOrWhiteSpace($Body)) {
      $params.Body = $Body
    }

    return Invoke-RestMethod @params
  }
  catch {
    $safeUri = Protect-SensitiveText -Text $Uri
    $safeMessage = Protect-SensitiveText -Text $_.Exception.Message
    throw "HTTP request failed. Method=$Method Uri=$safeUri Message=$safeMessage"
  }
}

for ($i = 0; $i -lt $MaxPages; $i++) {
  # Apply strict Closed filtering client-side because server-side status filtering can omit expected matches.
  $uri = "$($base)/tickets?timezone=$([uri]::EscapeDataString($Timezone))&limit=$($Limit)&orderBy=lastInteraction&order=DESC&key=$encodedKey"
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($token)) {
    $headers['continuationToken'] = $token
  }

  $resp = Invoke-SafeWebRequest -Method 'GET' -Uri $uri -Headers $headers -ContentType 'application/json'
  $json = $resp.Content | ConvertFrom-Json
  $all += @($json.items)
  # Response headers can surface as a string array; take the first value before the whitespace check
  # so pagination terminates correctly.
  $token = @($resp.Headers['continuationToken'])[0]

  if ([string]::IsNullOrWhiteSpace($token)) {
    break
  }
}

function Get-NormalizedEmail {
  param([object]$Value)
  if ($null -eq $Value) {
    return ''
  }
  # Invariant casing avoids locale-specific surprises (e.g. the Turkish dotless 'i').
  return ([string]$Value).Trim().ToLowerInvariant()
}

$normalizedRequestorEmail = Get-NormalizedEmail $RequestorEmail
$normalizedAssigneeEmail  = Get-NormalizedEmail $AssigneeEmail

$target = $all |
  Where-Object {
    $_.status -eq 'Closed' -and
    (Get-NormalizedEmail $_.requestor.email) -eq $normalizedRequestorEmail -and
    (Get-NormalizedEmail $_.assignee.email) -eq $normalizedAssigneeEmail
  } |
  Select-Object -First 1

$usedFallback = $false
if (-not $target -and $AllowResolvedFallback) {
  $target = $all |
    Where-Object {
      $_.status -in @('Resolved', 'Closed') -and
      (Get-NormalizedEmail $_.requestor.email) -eq $normalizedRequestorEmail -and
      (Get-NormalizedEmail $_.assignee.email) -eq $normalizedAssigneeEmail
    } |
    Select-Object -First 1
  $usedFallback = $null -ne $target
}

if (-not $target) {
  throw 'No qualifying ticket found for the requested criteria.'
}

$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss K')
$comment = @"
### Connector Validation Note
- Test type: live write-path validation
- Trigger: Copilot skill execution test
- Timestamp: $stamp
"@

$body = @{
  comment = $comment
  user    = @{
    id    = $target.assignee.id
    name  = $target.assignee.name
    email = $target.assignee.email
  }
} | ConvertTo-Json -Depth 6

$encodedTargetId = [uri]::EscapeDataString($target.id)

$writeUri = "$($base)/tickets/$($encodedTargetId)/activities?key=$encodedKey"
$writeResp = Invoke-SafeRestMethod -Method 'POST' -Uri $writeUri -ContentType 'application/json' -Body $body

$actUri = "$($base)/tickets/$($encodedTargetId)/activities?key=$encodedKey"
$activitiesResp = Invoke-SafeRestMethod -Method 'GET' -Uri $actUri -ContentType 'application/json'
$found = @($activitiesResp.items | Where-Object { $_.comment -eq $comment }).Count

Write-Output ('TargetTicketId={0}' -f $target.id)
Write-Output ('TargetStatus={0}' -f $target.status)
Write-Output ('TargetTitle={0}' -f $target.title)
Write-Output ('WriteMessage={0}' -f $writeResp.message)
Write-Output ('VerificationExactCommentMatches={0}' -f $found)
Write-Output ('UsedResolvedFallback={0}' -f $usedFallback)
