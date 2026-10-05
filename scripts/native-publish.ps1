[CmdletBinding()]
param([string]$Server = 'root@39.106.63.14', [switch]$ConfigureServer)
. (Join-Path $PSScriptRoot 'native-common.ps1')
if ($Server -notmatch '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$') { throw 'Use an SSH host or user@host without shell arguments.' }
$taskVersion = (Get-Content -LiteralPath (Join-Path $script:DesktopRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$taskInstaller = Join-Path $script:DesktopRoot "release/PWTools-Setup-$taskVersion.exe"
$taskManifest = Join-Path $script:DesktopRoot 'release/updates/windows-x64/latest.json'
if (-not (Test-Path -LiteralPath $taskInstaller) -or -not (Test-Path -LiteralPath $taskManifest)) { throw 'Run npm run package:win before publishing.' }
$taskRelease = Get-Content -LiteralPath $taskManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskRelease.version -ne $taskVersion -or $taskRelease.sha256 -ne (Get-Sha256 $taskInstaller) -or $taskRelease.size -ne (Get-Item -LiteralPath $taskInstaller).Length -or (Get-Item -LiteralPath $taskInstaller).VersionInfo.ProductVersion -ne $taskVersion) { throw 'Installer, version and manifest must agree before publishing.' }
$taskStage = '/opt/pwtools/updates/staging-' + [Guid]::NewGuid().ToString('N')
Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', $Server, "umask 077; mkdir -p $taskStage")
# Deliberately stage only release files; no source tree or environment is sent.
Invoke-Checked 'scp.exe' @('-o', 'BatchMode=yes', $taskInstaller, $taskManifest, (Join-Path $script:RepoRoot 'deploy/publish-desktop-update.sh'), "${Server}:$taskStage/")
if ($ConfigureServer) { Invoke-Checked 'scp.exe' @('-o', 'BatchMode=yes', (Join-Path $script:RepoRoot 'deploy/pwtools.nginx.conf'), "${Server}:$taskStage/") }
$taskMode = if ($ConfigureServer) { 'configure' } else { 'publish' }
Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, "cd $taskStage && sh ./publish-desktop-update.sh $taskMode")
$taskPublicUrl = (Get-Content -LiteralPath (Join-Path $script:RepoRoot 'deploy/desktop-api-url.txt') -Raw -Encoding UTF8).Trim() + '/updates/windows-x64/latest.json'
$taskVerified = $false
# A graceful Openresty reload can briefly serve the previous route. Verify the
# public result after workers switch, with bounded retries and no assumed success.
for ($taskAttempt = 0; $taskAttempt -lt 6; $taskAttempt++) {
  try {
    $taskPublished = Invoke-RestMethod -Uri $taskPublicUrl -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 5
    if ($taskPublished.version -eq $taskVersion -and $taskPublished.sha256 -eq $taskRelease.sha256 -and $taskPublished.size -eq $taskRelease.size) { $taskVerified = $true; break }
  } catch { }
  if ($taskAttempt -lt 5) { Start-Sleep -Seconds 1 }
}
if (-not $taskVerified) { throw "Public update manifest verification failed; inspect deployment and retained staging directory $taskStage" }
# Remove only files this invocation uploaded, then the now-empty staging folder.
Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, "cd $taskStage && rm -f -- latest.json PWTools-Setup-$taskVersion.exe publish-desktop-update.sh pwtools.nginx.conf && rmdir $taskStage")
Write-Host "Published PWTools $taskVersion to $taskPublicUrl"
