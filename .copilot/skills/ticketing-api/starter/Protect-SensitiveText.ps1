function Protect-SensitiveText {
  [CmdletBinding()]
  [OutputType([string])]
  param(
    [Parameter()]
    [string]$Text
  )

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $Text
  }

  $redacted = $Text -replace '(?<=[?&]key=)[^&\s]+', '***REDACTED***'
  $redacted = $redacted -replace '(?<=[?&](?:sig|signature|token|access_token)=)[^&\s]+', '***REDACTED***'
  return $redacted
}
