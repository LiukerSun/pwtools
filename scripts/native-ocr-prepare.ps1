. (Join-Path $PSScriptRoot 'native-common.ps1')

# Build and runtime both use native binaries only. The wheel is a verified ZIP
# container for the existing model files; no Python code or environment is used.
$taskSdkArchive = Join-Path $script:DepsRoot 'onnxruntime-win-x64-1.23.2.zip'
Get-VerifiedDownload 'https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-1.23.2.zip' $taskSdkArchive '0B38DF9AF21834E41E73D602D90DB5CB06DBD1CA618948B8F1D66D607AC9F3CD'
$taskSdkRoot = Assert-WorkspacePath (Join-Path $script:DepsRoot 'onnxruntime-win-x64-1.23.2')
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not (Test-Path -LiteralPath (Join-Path $taskSdkRoot 'include/onnxruntime_cxx_api.h'))) {
  if (Test-Path -LiteralPath $taskSdkRoot) { Remove-Item -LiteralPath (Assert-WorkspacePath $taskSdkRoot) -Recurse -Force }
  [IO.Compression.ZipFile]::ExtractToDirectory($taskSdkArchive, $script:DepsRoot)
}
$taskModelsArchive = Join-Path $script:DepsRoot 'rapidocr-3.9.2-models.whl'
Get-VerifiedDownload 'https://files.pythonhosted.org/packages/55/ed/0ee9b9281986974be9d2406ae0134c8d7c91d2fc613f16ffda9701eeda6f/rapidocr-3.9.2-py3-none-any.whl' $taskModelsArchive '04D6B8D151F823D930BD91910555F57BEA897C0C44FA6794267B94CF9C1EF9A0'

$taskTarget = Assert-WorkspacePath (Join-Path $script:DeployRoot 'ocr')
if (Test-Path -LiteralPath $taskTarget) { Remove-Item -LiteralPath (Assert-WorkspacePath $taskTarget) -Recurse -Force }
New-Item -ItemType Directory -Force -Path $taskTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $taskSdkRoot 'lib/onnxruntime.dll') -Destination $taskTarget
$taskModelHashes = @{
  'PP-OCRv6_det_small.onnx' = '090F04ABCD9D9A7498BC4EBF677E4CB9BDCE1FE4197DDB7E529F1EF44E1FF94F'
  'PP-OCRv6_rec_small.onnx' = '6F327246B50388F3C176AE304BD95767EA6DC0C9AE92153EF8CBE210B3C14884'
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx' = 'E47ACEDF663230F8863FF1AB0E64DD2D82B838FCEB5957146DAB185A89D6215C'
}
$taskZip = [IO.Compression.ZipFile]::OpenRead($taskModelsArchive)
try {
  foreach ($taskName in $taskModelHashes.Keys) {
    $taskEntry = $taskZip.GetEntry('rapidocr/models/' + $taskName)
    if (-not $taskEntry) { throw "Missing OCR model: $taskName" }
    $taskModelPath = Join-Path $taskTarget $taskName
    [IO.Compression.ZipFileExtensions]::ExtractToFile($taskEntry, $taskModelPath)
    if ((Get-Sha256 $taskModelPath) -ne $taskModelHashes[$taskName]) { throw "OCR model integrity check failed: $taskName" }
  }
} finally { $taskZip.Dispose() }

# The native runtime depends on these four redistributable CRT DLLs. Place them
# next to it so the client does not require a separate runtime installation.
$taskVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$taskVsRoot = & $taskVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVsRoot) { throw 'Visual Studio 2022 C++ Build Tools and redistributable files are required.' }
$taskCrtDirectory = Get-ChildItem -LiteralPath (Join-Path $taskVsRoot 'VC/Redist/MSVC') -Directory |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [Version]$_.Name } -Descending | Select-Object -First 1
if (-not $taskCrtDirectory) { throw 'Visual C++ redistributable files are missing.' }
foreach ($taskDll in @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
  Copy-Item -LiteralPath (Join-Path $taskCrtDirectory.FullName ('x64/Microsoft.VC143.CRT/' + $taskDll)) -Destination $taskTarget
}

$taskLicenses = Assert-WorkspacePath (Join-Path $script:DeployRoot 'licenses')
New-Item -ItemType Directory -Force -Path $taskLicenses | Out-Null
foreach ($taskLegacy in @('Python-LICENSE.txt', 'OCR-THIRD-PARTY-NOTICES.txt')) {
  $taskLegacyPath = Join-Path $taskLicenses $taskLegacy
  if (Test-Path -LiteralPath $taskLegacyPath) { Remove-Item -LiteralPath (Assert-WorkspacePath $taskLegacyPath) -Force }
}
Copy-Item -LiteralPath (Join-Path $taskSdkRoot 'LICENSE') -Destination (Join-Path $taskLicenses 'ONNX-Runtime-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $taskSdkRoot 'ThirdPartyNotices.txt') -Destination (Join-Path $taskLicenses 'ONNX-Runtime-ThirdPartyNotices.txt') -Force
Get-VerifiedDownload 'https://raw.githubusercontent.com/RapidAI/RapidOCR/v3.9.2/LICENSE' (Join-Path $taskLicenses 'RapidOCR-models-LICENSE.txt') '3E0AF25FDD06AA9586AE97ADB00EA927EBE5A3805AC77D2D3A81CE5F55693333'
Write-Host 'Native OCR ready: ONNX Runtime CPU, PP-OCRv6 models and Windows image decoder; no Python runtime.'
