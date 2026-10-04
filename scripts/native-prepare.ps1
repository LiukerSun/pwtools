. (Join-Path $PSScriptRoot 'native-common.ps1')

$webViewArchive = Join-Path $script:DepsRoot 'webview2-1.0.4191.47.nupkg'
Get-VerifiedDownload 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4191.47/microsoft.web.webview2.1.0.4191.47.nupkg' $webViewArchive 'F492BBF547D0DA329553B6727435B677579B1E9F91CC9E4A1AD029366D5F23D0'
$webViewRoot = Assert-WorkspacePath (Join-Path $script:DepsRoot 'webview2-1.0.4191.47')
if (-not (Test-Path -LiteralPath (Join-Path $webViewRoot 'build/native/include/WebView2.h'))) {
  if (Test-Path -LiteralPath $webViewRoot) { Remove-Item -LiteralPath $webViewRoot -Recurse -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($webViewArchive, $webViewRoot)
}

$jsonHeader = Join-Path $script:DepsRoot 'nlohmann-3.12.0/include/nlohmann/json.hpp'
Get-VerifiedDownload 'https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp' $jsonHeader 'AAF127C04CB31C406E5B04A63F1AE89369FCCDE6D8FA7CDDA1ED4F32DFC5DE63'
$jsonLicense = Join-Path $script:DepsRoot 'nlohmann-3.12.0/LICENSE.MIT'
Get-VerifiedDownload 'https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT' $jsonLicense '46A65CFFD1EA955132D95A8DD921640714A8D6B537D2E4E482D31145AE95B603'
Write-Host 'Native SDKs ready: WebView2 1.0.4191.47, nlohmann/json 3.12.0.'
