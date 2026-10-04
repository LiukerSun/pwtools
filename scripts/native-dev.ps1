. (Join-Path $PSScriptRoot 'native-common.ps1')
& (Join-Path $PSScriptRoot 'native-build.ps1')
$node = (Get-Command node.exe).Source
$vite = Join-Path $script:RepoRoot 'node_modules/vite/bin/vite.js'
$viteProcess = Start-Process -FilePath $node -ArgumentList @(('"' + $vite + '"'), '--config', 'vite.native.config.ts') -WorkingDirectory $script:DesktopRoot -WindowStyle Hidden -PassThru
$previousDevUrl = $env:PWTOOLS_DEV_URL
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($viteProcess.HasExited) { throw 'Vite exited before the development server became ready.' }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173/' -TimeoutSec 1
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $ready) { throw 'The renderer development server did not start at http://localhost:5173/.' }
  $env:PWTOOLS_DEV_URL = 'http://localhost:5173/'
  $app = Start-Process -FilePath (Join-Path $script:DeployRoot 'PWTools.exe') -WorkingDirectory $script:DeployRoot -PassThru
  Wait-Process -Id $app.Id
} finally {
  $env:PWTOOLS_DEV_URL = $previousDevUrl
  if (-not $viteProcess.HasExited) { Stop-Process -Id $viteProcess.Id -Force }
}
