$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:DesktopRoot = Join-Path $script:RepoRoot 'apps/desktop'
$script:NativeRoot = Join-Path $script:DesktopRoot 'native'
$script:DepsRoot = Join-Path $script:NativeRoot '.deps'
$script:DeployRoot = Join-Path $script:DesktopRoot 'release/native-win-x64'

function Assert-WorkspacePath([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  $prefix = $script:RepoRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to change a path outside this repository: $resolved"
  }
  return $resolved
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  if ($Command -in @('npm.cmd', 'npx.cmd') -and -not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    $Command = [IO.Path]::ChangeExtension($Command, '.exe')
  }
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-VerifiedDownload([string]$Uri, [string]$Destination, [string]$Sha256) {
  $destinationPath = Assert-WorkspacePath $Destination
  New-Item -ItemType Directory -Force -Path (Split-Path $destinationPath -Parent) | Out-Null
  if (Test-Path -LiteralPath $destinationPath) {
    if ((Get-Sha256 $destinationPath) -eq $Sha256) { return }
    Remove-Item -LiteralPath $destinationPath -Force
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $destinationPath
  if ((Get-Sha256 $destinationPath) -ne $Sha256) {
    Remove-Item -LiteralPath $destinationPath -Force
    throw "Download integrity check failed: $Uri"
  }
}

function Find-MakeNsis {
  $command = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in @(
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS/makensis.exe'),
    (Join-Path $env:ProgramFiles 'NSIS/makensis.exe'),
    (Join-Path $script:DepsRoot 'nsis/makensis.exe')
  )) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
  $cache = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache'
  if (Test-Path -LiteralPath $cache) {
    $cached = Get-ChildItem -LiteralPath $cache -Filter makensis.exe -Recurse |
      Where-Object { $_.Directory.Name -ne 'Bin' } | Select-Object -First 1
    if ($cached) { return $cached.FullName }
  }
  throw 'NSIS is required to package PWTools. Install NSIS from https://nsis.sourceforge.io/Download or add makensis.exe to PATH.'
}
