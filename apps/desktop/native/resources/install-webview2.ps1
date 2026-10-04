# The Evergreen runtime is shared by all WebView2 applications and stays updated by Microsoft.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-WebView2Runtime {
  $client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $rootKey = $null
      $clientKey = $null
      try {
        $rootKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $clientKey = $rootKey.OpenSubKey($client)
        if ($clientKey) {
          $version = $clientKey.GetValue('pv', '')
          if ($version -and ([Version]$version -gt [Version]'0.0.0.0')) { return $true }
        }
      } catch { } finally {
        if ($clientKey) { $clientKey.Dispose() }
        if ($rootKey) { $rootKey.Dispose() }
      }
    }
  }
  return $false
}

if (Test-WebView2Runtime) { exit 0 }
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('PWTools-WebView2-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$bootstrapper = Join-Path $temporaryDirectory 'MicrosoftEdgeWebview2Setup.exe'
try {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrapper -TimeoutSec 120
  } catch { Write-Output 'WebView2 下载失败，请检查网络后重试。'; exit 10 }
  $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
    Write-Output 'WebView2 安装程序的 Microsoft 数字签名验证失败。'
    exit 11
  }
  $installation = Start-Process -FilePath $bootstrapper -ArgumentList '/silent', '/install' -WindowStyle Hidden -Wait -PassThru
  if ($installation.ExitCode -notin @(0, 3010) -or -not (Test-WebView2Runtime)) {
    Write-Output 'WebView2 安装未完成，请检查网络或系统安装策略后重试。'
    exit 12
  }
  exit 0
} catch { Write-Output '无法准备 WebView2 运行时。'; exit 12 } finally {
  # Delete only the one downloaded file and the unique directory created above.
  if (Test-Path -LiteralPath $bootstrapper) { Remove-Item -LiteralPath $bootstrapper -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $temporaryDirectory -ErrorAction SilentlyContinue
}
