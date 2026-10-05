param([switch]$SkipRenderer)
. (Join-Path $PSScriptRoot 'native-common.ps1')

Push-Location $script:RepoRoot
try {
  if (-not $SkipRenderer) {
    Invoke-Checked 'npm.cmd' @('run', 'typecheck', '--workspace', '@pwtools/desktop')
    Invoke-Checked 'npm.cmd' @('run', 'build:renderer', '--workspace', '@pwtools/desktop')
  }
  & (Join-Path $PSScriptRoot 'native-prepare.ps1')
  & (Join-Path $PSScriptRoot 'native-ocr-prepare.ps1')
  $cmake = Get-Command cmake.exe -ErrorAction SilentlyContinue
  if (-not $cmake) { throw 'CMake 3.24 or newer is required. Install https://cmake.org/download/.' }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio 2022 C++ Build Tools are required (Desktop development with C++).' }
  $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $visualStudio) { throw 'Install the Visual Studio 2022 Desktop development with C++ workload and Windows SDK.' }
  $buildRoot = Assert-WorkspacePath (Join-Path $script:NativeRoot '.build')
  $taskBuildApiUrl = [Environment]::GetEnvironmentVariable('PWTOOLS_API_URL', 'Process')
  if ([string]::IsNullOrWhiteSpace($taskBuildApiUrl)) { $taskBuildApiUrl = 'http://localhost:8080/api' }
  Invoke-Checked $cmake.Source @('-S', $script:NativeRoot, '-B', $buildRoot, '-G', 'Visual Studio 17 2022', '-A', 'x64', "-DCMAKE_GENERATOR_INSTANCE=$visualStudio", "-DPWTOOLS_API_URL=$taskBuildApiUrl")
  Invoke-Checked $cmake.Source @('--build', $buildRoot, '--config', 'Release', '--parallel')
  $rendererSource = Join-Path $script:DesktopRoot 'out/renderer'
  if (Test-Path -LiteralPath $rendererSource) {
    $rendererTarget = Assert-WorkspacePath (Join-Path $script:DeployRoot 'renderer')
    if (Test-Path -LiteralPath $rendererTarget) { Remove-Item -LiteralPath $rendererTarget -Recurse -Force }
    Copy-Item -LiteralPath $rendererSource -Destination $rendererTarget -Recurse
  } elseif (-not $SkipRenderer) { throw 'Renderer build is missing.' }
  $licenseTarget = Join-Path $script:DeployRoot 'licenses'
  New-Item -ItemType Directory -Force -Path $licenseTarget | Out-Null
  Copy-Item -LiteralPath (Join-Path $script:DepsRoot 'webview2-1.0.4191.47/LICENSE.txt') -Destination (Join-Path $licenseTarget 'WebView2-LICENSE.txt') -Force
  Copy-Item -LiteralPath (Join-Path $script:DepsRoot 'nlohmann-3.12.0/LICENSE.MIT') -Destination (Join-Path $licenseTarget 'nlohmann-json-LICENSE.txt') -Force
  & node (Join-Path $PSScriptRoot 'native-licenses.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate third-party notices.' }
  $pdb = Join-Path $script:DeployRoot 'PWTools.pdb'
  if (Test-Path -LiteralPath $pdb) { Remove-Item -LiteralPath (Assert-WorkspacePath $pdb) -Force }
  Write-Host "Native app: $(Join-Path $script:DeployRoot 'PWTools.exe')"
} finally { Pop-Location }
