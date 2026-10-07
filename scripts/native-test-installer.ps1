# Installs only into a unique workspace stage, tests that executable, and restores
# the current user's existing uninstall registration and three shortcut files.
# Run from Windows PowerShell 5.1 after building the installer and starting the API.
# NSIS /D= and _?= must be last and unquoted: https://nsis.sourceforge.io/Docs/Chapter3.html
[CmdletBinding()]
param([string]$InstallerPath = '', [switch]$ExerciseUpdate)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) {
  throw '此验收脚本仅支持 64 位 Windows。'
}

$taskRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$taskArtifactsRoot = Join-Path $taskRepoRoot '.artifacts'
$taskPayloadRoot = Join-Path $taskRepoRoot 'apps/desktop/release/native-win-x64'
$taskStageName = 'native-installer-qa-' + [Guid]::NewGuid().ToString('N')
$taskStageRoot = Join-Path $taskArtifactsRoot $taskStageName
$taskRegistryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\PWToolsNative'
$taskRegistryViews = @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)

function Assert-NoReparsePoint([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw '验收路径包含重解析点，已停止。'
    }
  }
}

function Assert-StagePath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $stage = [IO.Path]::GetFullPath($taskStageRoot).TrimEnd('\')
  $artifactsPrefix = [IO.Path]::GetFullPath($taskArtifactsRoot).TrimEnd('\') + '\'
  if (-not $stage.StartsWith($artifactsPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($stage) -notmatch '^native-installer-qa-[a-f0-9]{32}$' -or
      ($full -ne $stage -and -not $full.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase))) {
    throw '测试目录范围校验失败，未执行文件操作。'
  }
  Assert-NoReparsePoint $taskRepoRoot
  Assert-NoReparsePoint $taskArtifactsRoot
  Assert-NoReparsePoint $stage
  return $full
}

function Get-RegularFiles([string]$Root) {
  Assert-NoReparsePoint $Root
  $directories = New-Object 'System.Collections.Generic.Stack[string]'
  $directories.Push($Root)
  while ($directories.Count -gt 0) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directories.Pop())) {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '文件树包含重解析点，已停止。' }
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $directories.Push($entry) }
      else { $entry }
    }
  }
}

function Get-FileHashValue([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Test-ExistingWebView2Runtime {
  $client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($view in $taskRegistryViews) {
      $root = $null; $key = $null
      try {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $key = $root.OpenSubKey($client)
        if ($key) {
          $version = $key.GetValue('pv', '')
          if ($version -and ([Version]$version -gt [Version]'0.0.0.0')) { return $true }
        }
      } catch { } finally {
        if ($key) { $key.Dispose() }
        if ($root) { $root.Dispose() }
      }
    }
  }
  return $false
}

function Get-RegistryNodeSnapshot([Microsoft.Win32.RegistryKey]$Key) {
  $values = @()
  foreach ($name in $Key.GetValueNames()) {
    $values += [pscustomobject]@{
      Name = $name
      Kind = $Key.GetValueKind($name)
      Data = $Key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
  }
  $children = @{}
  foreach ($name in $Key.GetSubKeyNames()) {
    $child = $Key.OpenSubKey($name)
    try { $children[$name] = Get-RegistryNodeSnapshot $child } finally { $child.Dispose() }
  }
  return [pscustomobject]@{ Values = $values; Children = $children; Security = $Key.GetAccessControl() }
}

function Get-UninstallSnapshot([Microsoft.Win32.RegistryView]$View) {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $View)
  $key = $null
  try {
    $key = $root.OpenSubKey($taskRegistryPath)
    $node = $null
    if ($key) { $node = Get-RegistryNodeSnapshot $key }
    return [pscustomobject]@{ View = $View; Exists = ($null -ne $key); Node = $node }
  } finally { if ($key) { $key.Dispose() }; $root.Dispose() }
}

function Restore-RegistryNode([Microsoft.Win32.RegistryKey]$Key, $Snapshot) {
  $names = @($Snapshot.Values | ForEach-Object { $_.Name })
  foreach ($name in $Key.GetValueNames()) {
    if ($names -notcontains $name) { $Key.DeleteValue($name, $false) }
  }
  foreach ($value in $Snapshot.Values) { $Key.SetValue($value.Name, $value.Data, $value.Kind) }
  foreach ($name in $Key.GetSubKeyNames()) {
    if (-not $Snapshot.Children.ContainsKey($name)) { $Key.DeleteSubKeyTree($name, $false) }
  }
  foreach ($name in $Snapshot.Children.Keys) {
    $child = $Key.CreateSubKey($name)
    try { Restore-RegistryNode $child $Snapshot.Children[$name] } finally { $child.Dispose() }
  }
  $Key.SetAccessControl($Snapshot.Security)
}

function Restore-UninstallSnapshot($Snapshot) {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $Snapshot.View)
  try {
    if ($Snapshot.Exists) {
      $key = $root.CreateSubKey($taskRegistryPath)
      try { Restore-RegistryNode $key $Snapshot.Node } finally { $key.Dispose() }
    } else { $root.DeleteSubKeyTree($taskRegistryPath, $false) }
  } finally { $root.Dispose() }
}

function Test-RegistryNodeRestored([Microsoft.Win32.RegistryKey]$Key, $Snapshot) {
  if ($Key.GetValueNames().Length -ne $Snapshot.Values.Count -or $Key.GetSubKeyNames().Length -ne $Snapshot.Children.Count) { return $false }
  foreach ($value in $Snapshot.Values) {
    if ($Key.GetValueNames() -notcontains $value.Name -or $Key.GetValueKind($value.Name) -ne $value.Kind) { return $false }
    $data = $Key.GetValue($value.Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ([Management.Automation.PSSerializer]::Serialize($data) -cne [Management.Automation.PSSerializer]::Serialize($value.Data)) { return $false }
  }
  foreach ($name in $Snapshot.Children.Keys) {
    $child = $Key.OpenSubKey($name)
    try { if (-not $child -or -not (Test-RegistryNodeRestored $child $Snapshot.Children[$name])) { return $false } }
    finally { if ($child) { $child.Dispose() } }
  }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
  return $Key.GetAccessControl().GetSecurityDescriptorSddlForm($sections) -ceq $Snapshot.Security.GetSecurityDescriptorSddlForm($sections)
}

function Assert-UninstallRestored($Snapshot) {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $Snapshot.View)
  $key = $null
  try {
    $key = $root.OpenSubKey($taskRegistryPath)
    if ($Snapshot.Exists) {
      if (-not $key -or -not (Test-RegistryNodeRestored $key $Snapshot.Node)) { throw '卸载项恢复校验失败。' }
    } elseif ($key) { throw '测试卸载项未移除。' }
  } finally { if ($key) { $key.Dispose() }; $root.Dispose() }
}

function Get-PathSnapshot([string]$Path, [bool]$Directory) {
  Assert-NoReparsePoint $Path
  $exists = Test-Path -LiteralPath $Path
  if (-not $exists) { return [pscustomobject]@{ Path = $Path; Exists = $false; Directory = $Directory } }
  $item = Get-Item -LiteralPath $Path -Force
  if ([bool]$item.PSIsContainer -ne $Directory) { throw '快捷方式路径类型不正确，已停止。' }
  $bytes = $null
  if (-not $Directory) { $bytes = [IO.File]::ReadAllBytes($Path) }
  # npm can inherit a PowerShell 7 module path into Windows PowerShell 5.1;
  # use the .NET ACL APIs so snapshots do not depend on module auto-loading.
  $security = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  return [pscustomobject]@{
    Path = $Path; Exists = $true; Directory = $Directory; Bytes = $bytes
    Attributes = $item.Attributes; Creation = $item.CreationTimeUtc; LastWrite = $item.LastWriteTimeUtc; LastAccess = $item.LastAccessTimeUtc
    Security = $security
  }
}

function Restore-PathMetadata($Snapshot) {
  if ($Snapshot.Directory) { [IO.Directory]::SetAccessControl($Snapshot.Path, $Snapshot.Security) }
  else { [IO.File]::SetAccessControl($Snapshot.Path, $Snapshot.Security) }
  [IO.File]::SetAttributes($Snapshot.Path, $Snapshot.Attributes)
  if ($Snapshot.Directory) {
    [IO.Directory]::SetCreationTimeUtc($Snapshot.Path, $Snapshot.Creation)
    [IO.Directory]::SetLastWriteTimeUtc($Snapshot.Path, $Snapshot.LastWrite)
    [IO.Directory]::SetLastAccessTimeUtc($Snapshot.Path, $Snapshot.LastAccess)
  } else {
    [IO.File]::SetCreationTimeUtc($Snapshot.Path, $Snapshot.Creation)
    [IO.File]::SetLastWriteTimeUtc($Snapshot.Path, $Snapshot.LastWrite)
    [IO.File]::SetLastAccessTimeUtc($Snapshot.Path, $Snapshot.LastAccess)
  }
}

function Restore-Shortcut($Snapshot) {
  Assert-NoReparsePoint (Split-Path $Snapshot.Path -Parent)
  Assert-NoReparsePoint $Snapshot.Path
  if ($Snapshot.Exists) {
    if ([IO.File]::Exists($Snapshot.Path)) { [IO.File]::SetAttributes($Snapshot.Path, [IO.FileAttributes]::Normal) }
    [IO.File]::WriteAllBytes($Snapshot.Path, $Snapshot.Bytes)
    Restore-PathMetadata $Snapshot
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Snapshot.Path)) -cne [Convert]::ToBase64String($Snapshot.Bytes)) { throw '快捷方式恢复校验失败。' }
    # Reading for verification may update the access time.
    [IO.File]::SetLastAccessTimeUtc($Snapshot.Path, $Snapshot.LastAccess)
  } elseif (Test-Path -LiteralPath $Snapshot.Path) {
    if ([IO.Directory]::Exists($Snapshot.Path)) { throw '测试快捷方式路径发生变化，未删除。' }
    Remove-Item -LiteralPath $Snapshot.Path -Force
  }
}

function Remove-OwnedStage {
  $stage = Assert-StagePath $taskStageRoot
  if (-not (Test-Path -LiteralPath $stage)) { return }
  # Check every descendant before the only recursive filesystem removal.
  foreach ($file in @(Get-RegularFiles $stage)) { $null = Assert-StagePath $file }
  Remove-Item -LiteralPath $stage -Recurse -Force
}

if (-not (Test-ExistingWebView2Runtime)) { throw '请先准备 WebView2 运行时；验收脚本不会安装或修改共享运行时。' }
if (-not [IO.Directory]::Exists($taskPayloadRoot)) { throw '原生发布文件尚未构建。' }
Assert-NoReparsePoint $taskRepoRoot
Assert-NoReparsePoint $taskArtifactsRoot
Assert-NoReparsePoint $taskPayloadRoot
$version = (Get-Content -LiteralPath (Join-Path $taskRepoRoot 'apps/desktop/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$expectedInstaller = [IO.Path]::GetFullPath((Join-Path $taskRepoRoot ('apps/desktop/release/PWTools-Setup-' + $version + '.exe')))
if (-not $InstallerPath) { $InstallerPath = $expectedInstaller }
$taskInstaller = [IO.Path]::GetFullPath($InstallerPath)
if (-not [string]::Equals($taskInstaller, $expectedInstaller, [StringComparison]::OrdinalIgnoreCase)) { throw '仅允许验收当前版本的原生发布安装包。' }
if (-not [IO.File]::Exists($taskInstaller)) { throw '安装包不存在。' }
Assert-NoReparsePoint $taskInstaller
$taskInstallerHash = Get-FileHashValue $taskInstaller
$taskPayloadHashes = @{}
foreach ($file in @(Get-RegularFiles $taskPayloadRoot)) {
  $relative = $file.Substring($taskPayloadRoot.TrimEnd('\').Length + 1)
  $taskPayloadHashes[$relative] = Get-FileHashValue $file
}
if (-not $taskPayloadHashes.ContainsKey('PWTools.exe') -or -not $taskPayloadHashes.ContainsKey('renderer\index.html')) { throw '原生发布文件不完整。' }
$taskNpx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $taskNpx) { $taskNpx = Get-Command npx.exe -ErrorAction Stop }
$taskDesktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$taskPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
if (-not $taskDesktop -or -not $taskPrograms -or -not [IO.Directory]::Exists($taskDesktop) -or -not [IO.Directory]::Exists($taskPrograms)) { throw '当前用户的快捷方式目录不可用。' }
$taskMenuFolder = Join-Path $taskPrograms 'PWTools'
$taskShortcutPaths = @((Join-Path $taskDesktop 'PWTools.lnk'), (Join-Path $taskMenuFolder 'PWTools.lnk'), (Join-Path $taskMenuFolder '卸载 PWTools.lnk'))

$taskMutex = New-Object Threading.Mutex($false, 'Local\PWToolsNativeInstallerQa')
$taskHasMutex = $false
$taskInstallAttempted = $false
$taskStageCreated = $false
$taskArtifactsCreated = $false
$taskSnapshotsReady = $false
$taskFailed = $false
$taskPhase = '准备'
$taskCleanupErrors = New-Object 'System.Collections.Generic.List[string]'
$taskEnvironment = @{}
$taskLocationChanged = $false
$taskUninstallerHash = $null
try {
  try { $taskHasMutex = $taskMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taskHasMutex = $true }
  if (-not $taskHasMutex) { throw '另一个安装包验收正在运行。' }
  $taskRegistrySnapshots = @($taskRegistryViews | ForEach-Object { Get-UninstallSnapshot $_ })
  $taskMenuSnapshot = Get-PathSnapshot $taskMenuFolder $true
  $taskShortcutSnapshots = @($taskShortcutPaths | ForEach-Object { Get-PathSnapshot $_ $false })
  $taskSnapshotsReady = $true
  foreach ($name in @('PWTOOLS_E2E_EXECUTABLE', 'PWTOOLS_DEV_URL', 'PWTOOLS_DATA_DIR', 'PWTOOLS_API_URL', 'PWTOOLS_DEBUG_PORT')) {
    $taskEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  if (-not [IO.Directory]::Exists($taskArtifactsRoot)) {
    New-Item -ItemType Directory -Path $taskArtifactsRoot | Out-Null
    $taskArtifactsCreated = $true
  }
  $stage = Assert-StagePath $taskStageRoot
  if (Test-Path -LiteralPath $stage) { throw '唯一测试目录已存在。' }
  New-Item -ItemType Directory -Path $stage | Out-Null
  $taskStageCreated = $true
  if ((Get-FileHashValue $taskInstaller) -ne $taskInstallerHash) { throw '安装包在验收准备期间发生变化。' }

  $taskPhase = '静默安装'
  $taskInstallAttempted = $true
  $installation = Start-Process -FilePath $taskInstaller -ArgumentList ('/S /D=' + $stage) -WindowStyle Hidden -Wait -PassThru
  $uninstaller = Assert-StagePath (Join-Path $stage 'Uninstall-PWTools.exe')
  if ([IO.File]::Exists($uninstaller)) { Assert-NoReparsePoint $uninstaller; $taskUninstallerHash = Get-FileHashValue $uninstaller }
  if ($installation.ExitCode -ne 0) { throw '安装包返回失败。' }
  if (-not $taskUninstallerHash) { throw '安装包未生成卸载程序。' }

  $taskPhase = '文件哈希'
  $installedFiles = @(Get-RegularFiles $stage | Where-Object { $_ -ne $uninstaller })
  if ($installedFiles.Count -ne $taskPayloadHashes.Count) { throw '安装文件数量与发布文件不一致。' }
  foreach ($file in $installedFiles) {
    $relative = $file.Substring($stage.Length + 1)
    if (-not $taskPayloadHashes.ContainsKey($relative) -or (Get-FileHashValue $file) -ne $taskPayloadHashes[$relative]) { throw '安装文件哈希与发布文件不一致。' }
  }
  Write-Host ('已核对安装文件：' + $installedFiles.Count)

  if ($ExerciseUpdate) {
    $taskPhase = '自动更新安装与重启'
    $taskUpdateProbe = Join-Path $taskRepoRoot 'apps/desktop/native/.build/tests/updater_test.exe'
    if (-not [IO.File]::Exists($taskUpdateProbe)) { throw 'Run npm run test:updater before exercising an update.' }
    $taskReleaseNotes = Get-Content -LiteralPath (Join-Path $taskRepoRoot 'apps/desktop/release-notes.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $taskUpdateChannelPath = if ($taskReleaseNotes.PSObject.Properties['channel'] -and $taskReleaseNotes.channel -eq 'beta') { 'beta/' } else { '' }
    $taskUpdateManifest = Join-Path $taskRepoRoot "apps/desktop/release/updates/windows-x64/${taskUpdateChannelPath}latest.json"
    $taskUpdateProfile = Assert-StagePath (Join-Path $stage 'update-qa-profile')
    New-Item -ItemType Directory -Path $taskUpdateProfile | Out-Null
    $taskSentinel = Join-Path $taskUpdateProfile 'preserve-during-update.txt'
    [IO.File]::WriteAllText($taskSentinel, $taskStageName)
    $taskStaleAsset = Assert-StagePath (Join-Path $stage 'renderer/stale-update-qa.js')
    [IO.File]::WriteAllText($taskStaleAsset, 'obsolete renderer asset')
    [Environment]::SetEnvironmentVariable('PWTOOLS_DATA_DIR', $taskUpdateProfile, 'Process')
    [Environment]::SetEnvironmentVariable('PWTOOLS_API_URL', 'http://127.0.0.1:1/api', 'Process')
    [Environment]::SetEnvironmentVariable('PWTOOLS_DEV_URL', $null, 'Process')
    [Environment]::SetEnvironmentVariable('PWTOOLS_DEBUG_PORT', $null, 'Process')
    & $taskUpdateProbe --install-local-probe $taskInstaller $taskUpdateManifest $stage $taskUpdateProfile
    if ($LASTEXITCODE -ne 0) { throw 'Update download/handoff failed.' }
    $taskRestarted = @()
    for ($taskAttempt = 0; $taskAttempt -lt 150; $taskAttempt++) {
      $taskRestarted = @(Get-CimInstance Win32_Process -Filter "Name = 'PWTools.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $stage 'PWTools.exe') })
      if ($taskRestarted.Count -eq 1) { break }
      Start-Sleep -Milliseconds 400
    }
    if ($taskRestarted.Count -ne 1) { throw 'Updated application did not restart.' }
    & taskkill.exe /PID $taskRestarted[0].ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not close the restarted QA application.' }
    for ($taskAttempt = 0; $taskAttempt -lt 50; $taskAttempt++) {
      $taskInstallerProcesses = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'PWTools-Setup-%'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskUpdateProfile + '\', [StringComparison]::OrdinalIgnoreCase) })
      if ($taskInstallerProcesses.Count -eq 0) { break }
      Start-Sleep -Milliseconds 200
    }
    if ($taskInstallerProcesses.Count -ne 0) { throw 'Update installer did not exit.' }
    if ([IO.File]::ReadAllText($taskSentinel) -cne $taskStageName) { throw 'Update changed the existing profile.' }
    if ([IO.File]::Exists($taskStaleAsset)) { throw 'Update retained stale renderer assets.' }
    foreach ($relative in $taskPayloadHashes.Keys) {
      if ((Get-FileHashValue (Assert-StagePath (Join-Path $stage $relative))) -ne $taskPayloadHashes[$relative]) { throw 'Updated payload differs from release files.' }
    }
    foreach ($name in @('PWTOOLS_DATA_DIR', 'PWTOOLS_API_URL', 'PWTOOLS_DEV_URL', 'PWTOOLS_DEBUG_PORT')) { [Environment]::SetEnvironmentVariable($name, $taskEnvironment[$name], 'Process') }
    Write-Host '自动下载、校验、等待调用进程退出、升级、自动重启、旧资源清理和本地数据保留均通过。'
  }

  $taskPhase = '普通启动与窗口呈现'
  & (Join-Path $PSHOME 'powershell.exe') -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskRepoRoot 'scripts/native-test-startup.ps1') -ExecutablePath (Join-Path $stage 'PWTools.exe') -Attempts 3 -ExerciseRestore
  if ($LASTEXITCODE -ne 0) { throw '已安装程序的普通启动或窗口恢复失败。' }

  $taskPhase = '原生窗口边缘缩放'
  & (Join-Path $PSHOME 'powershell.exe') -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskRepoRoot 'scripts/native-test-resize.ps1') -ExecutablePath (Join-Path $stage 'PWTools.exe')
  if ($LASTEXITCODE -ne 0) { throw '已安装程序的窗口拖拽缩放失败。' }

  $taskPhase = '原生登录与转单验收'
  [Environment]::SetEnvironmentVariable('PWTOOLS_E2E_EXECUTABLE', (Join-Path $stage 'PWTools.exe'), 'Process')
  [Environment]::SetEnvironmentVariable('PWTOOLS_DEV_URL', $null, 'Process')
  Push-Location $taskRepoRoot
  $taskLocationChanged = $true
  & $taskNpx.Source playwright test --config playwright.native.config.ts tests/native/app.spec.ts tests/native/order-transfer.spec.ts
  if ($LASTEXITCODE -ne 0) { throw '已安装程序的原生验收失败。' }
} catch {
  $taskFailed = $true
  Write-Warning ('验收失败位置：行 ' + $_.InvocationInfo.ScriptLineNumber + '，' + $_.FullyQualifiedErrorId + '（' + $_.Exception.GetType().Name + '）。')
  Write-Warning ('验收未完成（' + $taskPhase + '），正在恢复原状。')
} finally {
  if ($taskLocationChanged) { Pop-Location }
  foreach ($name in $taskEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $taskEnvironment[$name], 'Process') }
  if ($ExerciseUpdate -and $taskStageCreated) {
    try {
      $stage = Assert-StagePath $taskStageRoot
      foreach ($process in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase) })) {
        & taskkill.exe /PID $process.ProcessId /T /F 2>$null | Out-Null
      }
    } catch { $taskCleanupErrors.Add('更新验收进程清理未完成') }
  }
  if ($taskInstallAttempted -and $taskStageCreated) {
    try {
      $uninstaller = Assert-StagePath (Join-Path $taskStageRoot 'Uninstall-PWTools.exe')
      if ([IO.File]::Exists($uninstaller)) {
        $null = @(Get-RegularFiles (Assert-StagePath $taskStageRoot))
        if ($taskUninstallerHash -and (Get-FileHashValue $uninstaller) -ne $taskUninstallerHash) { throw '测试卸载程序发生变化。' }
        $uninstallation = Start-Process -FilePath $uninstaller -ArgumentList ('/S _?=' + (Assert-StagePath $taskStageRoot)) -WindowStyle Hidden -Wait -PassThru
        if ($uninstallation.ExitCode -ne 0) { throw '测试卸载程序返回失败。' }
      }
    } catch { $taskCleanupErrors.Add('测试安装卸载未完成') }
  }
  if ($taskInstallAttempted -and $taskSnapshotsReady) {
    # Restore independently so failure in one area does not skip the other.
    foreach ($snapshot in $taskRegistrySnapshots) {
      try { Restore-UninstallSnapshot $snapshot; Assert-UninstallRestored $snapshot }
      catch { $taskCleanupErrors.Add('卸载项恢复未完成') }
    }
    try {
      Assert-NoReparsePoint $taskMenuFolder
      if ($taskMenuSnapshot.Exists -and -not [IO.Directory]::Exists($taskMenuFolder)) { New-Item -ItemType Directory -Path $taskMenuFolder | Out-Null }
    } catch { $taskCleanupErrors.Add('开始菜单目录恢复未完成') }
    foreach ($snapshot in $taskShortcutSnapshots) {
      try { Restore-Shortcut $snapshot } catch { $taskCleanupErrors.Add('快捷方式恢复未完成') }
    }
    try {
      if ($taskMenuSnapshot.Exists) { Restore-PathMetadata $taskMenuSnapshot }
      elseif ([IO.Directory]::Exists($taskMenuFolder)) {
        Assert-NoReparsePoint $taskMenuFolder
        # Non-recursive: never remove unrelated files in the start-menu directory.
        if (@([IO.Directory]::EnumerateFileSystemEntries($taskMenuFolder)).Count -ne 0) { throw '测试菜单目录仍有其他文件。' }
        Remove-Item -LiteralPath $taskMenuFolder -Force
      }
    } catch { $taskCleanupErrors.Add('开始菜单目录恢复未完成') }
  }
  if ($taskStageCreated) {
    try { Remove-OwnedStage } catch { $taskCleanupErrors.Add('测试临时目录清理未完成') }
  }
  if ($taskArtifactsCreated) {
    try {
      Assert-NoReparsePoint $taskArtifactsRoot
      if (@([IO.Directory]::EnumerateFileSystemEntries($taskArtifactsRoot)).Count -eq 0) { Remove-Item -LiteralPath $taskArtifactsRoot -Force }
    } catch { $taskCleanupErrors.Add('测试产物目录清理未完成') }
  }
  if ($taskHasMutex) { $taskMutex.ReleaseMutex() }
  $taskMutex.Dispose()
}

if ($taskCleanupErrors.Count -gt 0) { throw ('验收恢复未完成：' + (($taskCleanupErrors | Select-Object -Unique) -join '；') + '。') }
if ($taskFailed) { throw ('安装包验收失败（' + $taskPhase + '），原有注册表和快捷方式已恢复。') }
Write-Host '安装包验收通过；原有卸载项与快捷方式已恢复，测试安装已移除。'
