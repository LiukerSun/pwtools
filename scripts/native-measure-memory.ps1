[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$RootProcessId,
  [ValidateRange(1, 3600)][int]$Samples = 15,
  [ValidateRange(1, 60)][int]$IntervalSeconds = 2,
  [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$taskRoot = Get-Process -Id $RootProcessId
if ($taskRoot.ProcessName -ne 'PWTools') { throw 'RootProcessId must identify a running PWTools process.' }
$taskStart = $taskRoot.StartTime
$taskSamples = @()
for ($taskIndex = 0; $taskIndex -lt $Samples; $taskIndex++) {
  $taskCurrent = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
  if (-not $taskCurrent -or $taskCurrent.StartTime -ne $taskStart) { break }
  $taskProcesses = @(Get-CimInstance Win32_Process)
  $taskIds = [Collections.Generic.HashSet[int]]::new()
  [void]$taskIds.Add($RootProcessId)
  do {
    $taskChanged = $false
    foreach ($taskProcess in $taskProcesses) {
      if ($taskIds.Contains([int]$taskProcess.ParentProcessId) -and $taskIds.Add([int]$taskProcess.ProcessId)) { $taskChanged = $true }
    }
  } while ($taskChanged)
  $taskLive = @(foreach ($taskProcessId in $taskIds) { Get-Process -Id $taskProcessId -ErrorAction SilentlyContinue })
  $taskSamples += [pscustomobject]@{
    timestamp = [DateTime]::UtcNow.ToString('o')
    processes = $taskLive.Count
    workingSetMiB = [math]::Round(($taskLive | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 2)
    privateBytesMiB = [math]::Round(($taskLive | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 2)
    handles = ($taskLive | Measure-Object HandleCount -Sum).Sum
  }
  if ($taskIndex -lt $Samples - 1) { Start-Sleep -Seconds $IntervalSeconds }
}
if (-not $taskSamples.Count) { throw 'No memory samples captured.' }
$taskReport = [pscustomobject]@{
  rootProcessId = $RootProcessId
  note = 'Includes PWTools and its WebView2 descendants. Summed working sets may double-count shared pages. Private bytes measure committed process memory.'
  samples = $taskSamples
  peakWorkingSetMiB = ($taskSamples | Measure-Object workingSetMiB -Maximum).Maximum
  peakPrivateBytesMiB = ($taskSamples | Measure-Object privateBytesMiB -Maximum).Maximum
}
$taskJson = $taskReport | ConvertTo-Json -Depth 5
if ($OutputPath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), $taskJson, [Text.UTF8Encoding]::new($false)) }
$taskJson
