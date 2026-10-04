[CmdletBinding()]
param([string]$ExecutablePath = '', [ValidateRange(1, 20)][int]$Attempts = 1, [switch]$ExerciseRestore)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StartupWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
}
'@
$startupDpiContext = [StartupWindowProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$startupRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $startupRepo 'apps/desktop/release/native-win-x64/PWTools.exe' }
$startupArtifacts = Join-Path $startupRepo '.artifacts'
[IO.Directory]::CreateDirectory($startupArtifacts) | Out-Null
$startupOldEnvironment = @{}
foreach ($name in @('PWTOOLS_DATA_DIR', 'PWTOOLS_API_URL', 'PWTOOLS_DEBUG_PORT', 'PWTOOLS_DEV_URL')) {
  $startupOldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$startupFailed = $false
try {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $startupProfile = Join-Path ([IO.Path]::GetTempPath()) ('pwtools-startup-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($startupProfile) | Out-Null
    $app = $null
    try {
      [Environment]::SetEnvironmentVariable('PWTOOLS_DATA_DIR', $startupProfile, 'Process')
      [Environment]::SetEnvironmentVariable('PWTOOLS_API_URL', 'http://127.0.0.1:1/api', 'Process')
      [Environment]::SetEnvironmentVariable('PWTOOLS_DEBUG_PORT', $null, 'Process')
      [Environment]::SetEnvironmentVariable('PWTOOLS_DEV_URL', $null, 'Process')
      $app = Start-Process -FilePath $ExecutablePath -WindowStyle Normal -PassThru
      $visible = $false
      for ($tick = 0; $tick -lt 75; $tick++) {
        $app.Refresh()
        if ($app.HasExited) { throw 'Startup process exited before showing its window.' }
        if ($app.MainWindowHandle -ne [IntPtr]::Zero -and [StartupWindowProbe]::IsWindowVisible($app.MainWindowHandle)) { $visible = $true; break }
        Start-Sleep -Milliseconds 200
      }
      if (-not $visible) { throw 'Startup window was not shown.' }
      # Do not resize, activate, invalidate, or connect CDP: each can mask the bug.
      Start-Sleep -Milliseconds 1500
      $startupWindow = $app.MainWindowHandle
      $stages = @('startup')
      if ($ExerciseRestore) { $stages += 'restored' }
      foreach ($stage in $stages) {
        if ($stage -eq 'restored') {
          [StartupWindowProbe]::ShowWindow($startupWindow, 6) | Out-Null
          Start-Sleep -Milliseconds 200
          [StartupWindowProbe]::ShowWindow($startupWindow, 9) | Out-Null
          Start-Sleep -Milliseconds 500
        }
        $visible = [StartupWindowProbe]::IsWindowVisible($startupWindow) -and -not [StartupWindowProbe]::IsIconic($startupWindow)
        if (-not $visible) { throw 'Startup or restored window is not visible.' }
        $rect = New-Object StartupWindowProbe+Rect
        [StartupWindowProbe]::GetWindowRect($app.MainWindowHandle, [ref]$rect) | Out-Null
        $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
        $bitmap = New-Object Drawing.Bitmap($width, $height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
          # Capture only this process's window surface, never the desktop behind it.
          $dc = $graphics.GetHdc()
          try { if (-not [StartupWindowProbe]::PrintWindow($app.MainWindowHandle, $dc, 2)) { throw 'Native window capture failed.' } }
          finally { $graphics.ReleaseHdc($dc) }
          $bitmap.Save((Join-Path $startupArtifacts "native-startup-$attempt-$stage.png"), [Drawing.Imaging.ImageFormat]::Png)
          $dark = 0; $accent = 0; $samples = 0
          for ($y = 40; $y -lt $height - 40; $y += 4) {
            for ($x = 40; $x -lt $width - 40; $x += 4) {
              $pixel = $bitmap.GetPixel($x, $y); $samples++
              if ($pixel.R -lt 60 -and $pixel.G -lt 80 -and $pixel.B -lt 100) { $dark++ }
              if ($pixel.B -gt 90 -and $pixel.B -gt $pixel.R + 25 -and $pixel.G -gt $pixel.R + 20) { $accent++ }
            }
          }
          # Fresh profiles use the dark theme. Check the edges separately so a
          # correctly rendered page cannot hide the reported white native frame.
          $whiteEdges = 0; $edgeSamples = 0
          for ($y = 40; $y -lt $height - 40; $y += 8) {
            foreach ($x in @(2, ($width - 3))) {
              $pixel = $bitmap.GetPixel($x, $y); $edgeSamples++
              if ($pixel.R -gt 200 -and $pixel.G -gt 200 -and $pixel.B -gt 200) { $whiteEdges++ }
            }
          }
          for ($x = 40; $x -lt $width - 40; $x += 8) {
            foreach ($y in @(2, ($height - 3))) {
              $pixel = $bitmap.GetPixel($x, $y); $edgeSamples++
              if ($pixel.R -gt 200 -and $pixel.G -gt 200 -and $pixel.B -gt 200) { $whiteEdges++ }
            }
          }
          $passed = ($dark / $samples -gt 0.5 -and $accent -gt 250 -and $whiteEdges / $edgeSamples -lt 0.05)
          [pscustomobject]@{ attempt = $attempt; stage = $stage; visible = $visible; debug = $false; dark_fraction = [Math]::Round($dark / $samples, 3); accent_samples = $accent; white_edge_fraction = [Math]::Round($whiteEdges / $edgeSamples, 3); passed = $passed } | ConvertTo-Json -Compress
          if (-not $passed) { $startupFailed = $true }
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
      }
    } finally {
      if ($app -and -not $app.HasExited) {
        [StartupWindowProbe]::PostMessage($app.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        if (-not $app.WaitForExit(5000)) { Stop-Process -Id $app.Id -Force }
      }
      $startupResolved = [IO.Path]::GetFullPath($startupProfile)
      $startupTempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
      if (-not $startupResolved.StartsWith($startupTempPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($startupResolved) -notmatch '^pwtools-startup-[a-f0-9]{32}$') { throw 'Unsafe temporary profile path.' }
      for ($retry = 0; $retry -lt 60; $retry++) {
        try { Remove-Item -LiteralPath $startupResolved -Recurse -Force; break }
        catch { if ($retry -eq 59) { throw }; Start-Sleep -Milliseconds 200 }
      }
    }
  }
} finally {
  foreach ($name in $startupOldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $startupOldEnvironment[$name], 'Process') }
  if ($startupDpiContext -ne [IntPtr]::Zero) { [StartupWindowProbe]::SetThreadDpiAwarenessContext($startupDpiContext) | Out-Null }
}
if ($startupFailed) { throw 'Actual native window is blank or transparent.' }
