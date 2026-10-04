. (Join-Path $PSScriptRoot 'native-common.ps1')
$taskPreviousApiUrl = [Environment]::GetEnvironmentVariable('PWTOOLS_API_URL', 'Process')
try {
  if ([string]::IsNullOrWhiteSpace($taskPreviousApiUrl)) {
    $taskReleaseApiUrl = (Get-Content -LiteralPath (Join-Path $script:RepoRoot 'deploy/desktop-api-url.txt') -Raw -Encoding UTF8).Trim()
    $taskReleaseUri = [Uri]$taskReleaseApiUrl
    if (-not $taskReleaseUri.IsAbsoluteUri -or $taskReleaseUri.Scheme -ne 'https' -or $taskReleaseUri.AbsolutePath.TrimEnd('/') -ne '/api') {
      throw 'The default release endpoint must be an absolute HTTPS URL ending in /api.'
    }
    [Environment]::SetEnvironmentVariable('PWTOOLS_API_URL', $taskReleaseApiUrl, 'Process')
  }
  & (Join-Path $PSScriptRoot 'native-build.ps1')
  $taskConfiguredApiUrl = [Environment]::GetEnvironmentVariable('PWTOOLS_API_URL', 'Process')
  $taskGeneratedConfig = Get-Content -LiteralPath (Join-Path $script:NativeRoot '.build/generated/config.hpp') -Raw -Encoding UTF8
  if (-not $taskGeneratedConfig.Contains('#define PWTOOLS_DEFAULT_API_URL "' + $taskConfiguredApiUrl + '"')) {
    throw 'The generated API endpoint does not match the selected release endpoint.'
  }
  $makeNsis = Find-MakeNsis
  Invoke-Checked $makeNsis @('/INPUTCHARSET', 'UTF8', (Join-Path $script:NativeRoot 'installer.nsi'))
  $desktopVersion = (Get-Content -LiteralPath (Join-Path $script:DesktopRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  Write-Host "Installer: $(Join-Path $script:DesktopRoot "release/PWTools-Setup-$desktopVersion.exe")"
} finally {
  if ($null -eq $taskPreviousApiUrl) {
    [Environment]::SetEnvironmentVariable('PWTOOLS_API_URL', [NullString]::Value, 'Process')
  } else {
    [Environment]::SetEnvironmentVariable('PWTOOLS_API_URL', $taskPreviousApiUrl, 'Process')
  }
}
