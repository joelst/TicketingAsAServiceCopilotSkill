[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet('us', 'eu', 'apac')]
  [string]$Region = 'us',

  [Parameter()]
  [string]$Timezone = '-5',

  [Parameter()]
  [int]$Limit = 3
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Protect-SensitiveText.ps1')

$apiKey = $env:ticketingAPIKey
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  $apiKey = $env:TICKETING_API_KEY
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'Set ticketingAPIKey (or TICKETING_API_KEY) in terminal before running smoke-test.ps1.'
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

$baseUrl = "https://$($hostName)/ticketing/v1"

function Invoke-ReadOnlyCall {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$Uri
  )

  Write-Output ([Environment]::NewLine + ('==> {0}' -f $Name))
  $safeUri = Protect-SensitiveText -Text $Uri
  Write-Output ('GET {0}' -f $safeUri)

  try {
    $response = Invoke-RestMethod -Method 'GET' -Uri $Uri -ContentType 'application/json'
    [pscustomobject]@{
      Name          = $Name
      Success       = $true
      Error         = $false
      Message       = $response.message
      ItemCount     = $response.itemCount
      ItemsReturned = @($response.items).Count
    }
  }
  catch {
    $httpResponse = $_.Exception.Response
    $statusCode = if ($httpResponse) { [int]$httpResponse.StatusCode } else { 0 }
    $errorBody = ''

    if (-not [string]::IsNullOrWhiteSpace($_.ErrorDetails.Message)) {
      $errorBody = $_.ErrorDetails.Message
    }

    if ($httpResponse) {
      if ($httpResponse -is [System.Net.Http.HttpResponseMessage]) {
        if ($httpResponse.Content) {
          $errorBody = $httpResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      }
      else {
        $responseStream = $httpResponse.GetResponseStream()
        if ($responseStream) {
          $reader = [System.IO.StreamReader]::new($responseStream)
          try {
            $errorBody = $reader.ReadToEnd()
          }
          finally {
            $reader.Dispose()
            $responseStream.Dispose()
          }
        }
      }
    }

    $safeMessage = Protect-SensitiveText -Text $_.Exception.Message
    $safeBody = Protect-SensitiveText -Text $errorBody

    [pscustomobject]@{
      Name       = $Name
      Success    = $false
      StatusCode = $statusCode
      Error      = $true
      Message    = $safeMessage
      Body       = $safeBody
    }
  }
}

$instanceUri = "$($baseUrl)/instance?key=$([uri]::EscapeDataString($apiKey))&timezone=$([uri]::EscapeDataString($Timezone))"
$listUri = "$($baseUrl)/tickets?key=$([uri]::EscapeDataString($apiKey))&timezone=$([uri]::EscapeDataString($Timezone))&limit=$($Limit)&orderBy=lastInteraction&order=DESC"

$instanceResult = Invoke-ReadOnlyCall -Name 'GetInstance' -Uri $instanceUri
$listResult = Invoke-ReadOnlyCall -Name 'ListTickets' -Uri $listUri

Write-Output ([Environment]::NewLine + '==> Summary')
$instanceResult | Format-List
$listResult | Format-List

if (-not $instanceResult.Success -or -not $listResult.Success) {
  throw 'Smoke test failed. Review output above.'
}

Write-Output "`nSmoke test passed for region '$($Region)' with timezone '$($Timezone)'."
