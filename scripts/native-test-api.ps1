. (Join-Path $PSScriptRoot 'native-common.ps1')
& (Join-Path $PSScriptRoot 'native-prepare.ps1')
& (Join-Path $PSScriptRoot 'native-ocr-prepare.ps1')
$cmake = Get-Command cmake.exe -ErrorAction Stop
$ctest = Join-Path (Split-Path $cmake.Source -Parent) 'ctest.exe'
$buildRoot = Assert-WorkspacePath (Join-Path $script:NativeRoot '.build')
Invoke-Checked $cmake.Source @('-S', $script:NativeRoot, '-B', $buildRoot, '-G', 'Visual Studio 17 2022', '-A', 'x64')
Invoke-Checked $cmake.Source @('--build', $buildRoot, '--config', 'Release', '--target', 'api_bridge_test', 'local_ocr_test', '--parallel')
Invoke-Checked $ctest @('--test-dir', $buildRoot, '-C', 'Release', '--output-on-failure', '-R', '^(api_bridge_fixtures|local_ocr_runtime)$')
