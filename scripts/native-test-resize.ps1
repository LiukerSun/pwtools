[CmdletBinding()]
param([string]$ExecutablePath = '', [switch]$FrameProbe)
$ErrorActionPreference = 'Stop'

# Exercise Windows' real pointer routing and size loop, not SetWindowPos alone.
# All HWND operations are limited to the process launched with this test profile.
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ResizeWindowProbe {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] public struct InputData { [FieldOffset(0)] public MouseInput Mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public InputData Data; }
  public sealed class Result {
    public string Edge, Stage, TargetClass;
    public int ParentHit, PointerHit, WidthBefore, HeightBefore, WidthAfter, HeightAfter;
    public bool Passed;
    public int BadFramePixels, FrameSamples;
    public string FrameExample;
  }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static string ClassName(IntPtr window) {
    var name = new StringBuilder(128); GetClassName(window, name, name.Capacity); return name.ToString();
  }
  public static IntPtr Find(uint process) {
    IntPtr result = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == process && ClassName(window) == "PWToolsWebView2") { result = window; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
  public static bool Ready(IntPtr window) {
    if (window == IntPtr.Zero || !IsWindowVisible(window)) return false;
    bool ready = false;
    EnumChildWindows(window, delegate(IntPtr child, IntPtr data) {
      if (ClassName(child) == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(child)) ready = true;
      return true;
    }, IntPtr.Zero);
    return ready;
  }
  static Rect Bounds(IntPtr window) {
    Rect result; if (!GetWindowRect(window, out result)) throw new InvalidOperationException("Owned window bounds unavailable"); return result;
  }
  static void MeasureFrame(IntPtr window, Result result) {
    // Do not use PrintWindow or invalidate here: either can repaint the defect
    // before measurement. Sample the actual visible native border after input.
    DwmFlush();
    Rect bounds = Bounds(window);
    int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
    IntPtr dc = GetDC(window);
    try {
      var points = new List<Point>();
      for (int x = 30; x < width - 30; x += 16) {
        points.Add(new Point { X = x, Y = 3 }); points.Add(new Point { X = x, Y = height - 4 });
      }
      for (int y = 30; y < height - 30; y += 16) {
        points.Add(new Point { X = 3, Y = y }); points.Add(new Point { X = width - 4, Y = y });
      }
      foreach (Point point in points) {
        uint color = GetPixel(dc, point.X, point.Y);
        result.FrameSamples++;
        if (color != 0x221711) {
          result.BadFramePixels++;
          if (result.FrameExample == null) result.FrameExample = point.X + "," + point.Y + ":" + (color & 255) + "," + ((color >> 8) & 255) + "," + ((color >> 16) & 255);
        }
      }
    } finally { ReleaseDC(window, dc); }
  }
  static int Hit(IntPtr window, Point point) {
    UIntPtr result;
    var position = new IntPtr(unchecked((int)(((uint)(ushort)point.Y << 16) | (ushort)point.X)));
    if (SendMessageTimeout(window, 0x84, UIntPtr.Zero, position, 2, 2000, out result) == IntPtr.Zero) throw new InvalidOperationException("Owned window hit test timed out");
    return unchecked((int)result.ToUInt64());
  }
  static void Mouse(Point point, uint flags) {
    var input = new Input();
    input.Data.Mouse.X = (int)Math.Round((point.X - GetSystemMetrics(76)) * 65535.0 / (GetSystemMetrics(78) - 1));
    input.Data.Mouse.Y = (int)Math.Round((point.Y - GetSystemMetrics(77)) * 65535.0 / (GetSystemMetrics(79) - 1));
    input.Data.Mouse.Flags = flags | 0xC001; // Absolute movement across the virtual desktop.
    if (SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new InvalidOperationException("Test pointer input failed");
  }
  public static Result[] ProbeActivation(IntPtr window) {
    var results = new List<Result>();
    SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x13);
    try {
      foreach (int active in new int[] { 0, 1, 0, 1 }) {
        UIntPtr ignored;
        if (SendMessageTimeout(window, 0x86, new UIntPtr((uint)active), IntPtr.Zero, 2, 2000, out ignored) == IntPtr.Zero) throw new InvalidOperationException("Owned window activation timed out");
        Thread.Sleep(80);
        var result = new Result { Edge = "all", Stage = active == 0 ? "inactive" : "active" };
        MeasureFrame(window, result);
        result.Passed = result.BadFramePixels == 0;
        results.Add(result);
      }
    } finally { SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x13); }
    return results.ToArray();
  }
  public static Result[] Run(IntPtr window) {
    foreach (int key in new int[] { 1, 2, 4, 16, 17, 18, 91, 92 }) {
      if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new InvalidOperationException("User is holding an input key; no test pointer input sent");
    }
    var monitor = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
    if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)) throw new InvalidOperationException("Owned window monitor unavailable");
    int dpi = (int)GetDpiForWindow(window);
    int width = Math.Min(1120 * dpi / 96, monitor.Work.Right - monitor.Work.Left - 40);
    int height = Math.Min(800 * dpi / 96, monitor.Work.Bottom - monitor.Work.Top - 40);
    int delta = 32 * dpi / 96, inset = Math.Max(3, 4 * dpi / 96);
    int frame = 2 * (int)Math.Round(7.0 * dpi / 96, MidpointRounding.AwayFromZero);
    if (width - delta < 960 * dpi / 96 + frame || height - delta < 640 * dpi / 96 + frame) throw new InvalidOperationException("Monitor work area too small for an unconstrained edge drag test");
    int left = monitor.Work.Left + (monitor.Work.Right - monitor.Work.Left - width) / 2;
    int top = monitor.Work.Top + (monitor.Work.Bottom - monitor.Work.Top - height) / 2;
    Point originalPointer; GetCursorPos(out originalPointer);
    var results = new List<Result>();
    string[] names = { "right", "left", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right", "minimum" };
    int[] expected = { 11, 10, 12, 15, 13, 14, 16, 17, 17 };
    try {
      for (int attempt = 0; attempt < names.Length * 2; attempt++) {
        int index = attempt % names.Length;
        if (attempt == names.Length) {
          ShowWindow(window, 3); Thread.Sleep(150);
          if (!IsZoomed(window)) throw new InvalidOperationException("Owned window did not maximize");
          Rect maximized = Bounds(window);
          Point edge = new Point { X = maximized.Right - inset - 1, Y = (maximized.Top + maximized.Bottom) / 2 };
          IntPtr maximizedTarget = WindowFromPoint(edge);
          if (GetAncestor(maximizedTarget, 2) != window || maximizedTarget == window || Hit(maximizedTarget, edge) != 1) throw new InvalidOperationException("Maximized WebView does not fill the frame");
          ShowWindow(window, 9); Thread.Sleep(150);
          if (IsZoomed(window)) throw new InvalidOperationException("Owned window did not restore");
        }
        // Position only establishes a repeatable starting size. The assertion
        // below measures a real input drag through Windows' window procedure.
        if (!SetWindowPos(window, new IntPtr(-1), left, top, width, height, 0x40)) throw new InvalidOperationException("Owned window positioning failed");
        SetForegroundWindow(window); Thread.Sleep(100);
        Rect before = Bounds(window);
        bool minimum = names[index] == "minimum";
        int distance = minimum ? 176 * dpi / 96 : delta;
        bool useLeft = names[index].Contains("left"), useRight = names[index].Contains("right") || minimum;
        bool useTop = names[index].Contains("top"), useBottom = names[index].Contains("bottom") || minimum;
        Point start = new Point {
          X = useLeft ? before.Left + inset : useRight ? before.Right - inset - 1 : (before.Left + before.Right) / 2,
          Y = useTop ? before.Top + inset : useBottom ? before.Bottom - inset - 1 : (before.Top + before.Bottom) / 2
        };
        IntPtr target = WindowFromPoint(start);
        if (GetAncestor(target, 2) != window) throw new InvalidOperationException("Test window is not the pointer target at " + names[index] + "; no input sent");
        var result = new Result { Edge = names[index], Stage = attempt < names.Length ? "normal" : "restored", TargetClass = ClassName(target), ParentHit = Hit(window, start), PointerHit = Hit(target, start), WidthBefore = before.Right - before.Left, HeightBefore = before.Bottom - before.Top };
        Point end = new Point { X = start.X + (useLeft ? distance : useRight ? -distance : 0), Y = start.Y + (useTop ? distance : useBottom ? -distance : 0) };
        Mouse(start, 0); Thread.Sleep(50);
        bool pressed = false;
        try {
          Mouse(start, 2); pressed = true; Thread.Sleep(100);
          for (int step = 1; step <= 4; step++) {
            Mouse(new Point { X = start.X + (end.X - start.X) * step / 4, Y = start.Y + (end.Y - start.Y) * step / 4 }, 0);
            Thread.Sleep(50);
          }
        } finally { if (pressed) Mouse(end, 4); }
        Thread.Sleep(100);
        Rect after = Bounds(window);
        result.WidthAfter = after.Right - after.Left; result.HeightAfter = after.Bottom - after.Top;
        int expectedWidth = minimum ? 960 * dpi / 96 + frame : result.WidthBefore - (useLeft || useRight ? distance : 0);
        int expectedHeight = minimum ? 640 * dpi / 96 + frame : result.HeightBefore - (useTop || useBottom ? distance : 0);
        result.Passed = result.ParentHit == expected[index] && result.PointerHit == expected[index] && result.WidthAfter == expectedWidth && result.HeightAfter == expectedHeight;
        MeasureFrame(window, result);
        result.Passed = result.Passed && result.BadFramePixels == 0;
        results.Add(result);
      }
    } finally {
      SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x13);
      SetCursorPos(originalPointer.X, originalPointer.Y);
    }
    return results.ToArray();
  }
}
'@

$resizeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $resizeRoot 'apps/desktop/release/native-win-x64/PWTools.exe' }
$ExecutablePath = (Resolve-Path -LiteralPath $ExecutablePath).Path
$resizeProfile = Join-Path ([IO.Path]::GetTempPath()) ('pwtools-resize-' + [Guid]::NewGuid().ToString('N'))
$resizeEnvironment = @{}
foreach ($name in @('PWTOOLS_DATA_DIR', 'PWTOOLS_API_URL', 'PWTOOLS_DEV_URL', 'PWTOOLS_DEBUG_PORT')) { $resizeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$resizeDpi = [ResizeWindowProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$resizeApp = $null
$resizeWindow = [IntPtr]::Zero
try {
  $env:PWTOOLS_DATA_DIR = $resizeProfile
  $env:PWTOOLS_API_URL = 'http://127.0.0.1:1/api'
  [Environment]::SetEnvironmentVariable('PWTOOLS_DEV_URL', $null, 'Process')
  [Environment]::SetEnvironmentVariable('PWTOOLS_DEBUG_PORT', $null, 'Process')
  # Intentionally visible: this QA checks the real window under the pointer.
  $resizeApp = Start-Process -FilePath $ExecutablePath -WindowStyle Normal -PassThru
  for ($tick = 0; $tick -lt 150; $tick++) {
    if ($resizeApp.HasExited) { throw 'Resize test application exited before WebView2 was ready.' }
    $resizeWindow = [ResizeWindowProbe]::Find([uint32]$resizeApp.Id)
    if ([ResizeWindowProbe]::Ready($resizeWindow)) { break }
    Start-Sleep -Milliseconds 100
  }
  if (-not [ResizeWindowProbe]::Ready($resizeWindow)) { throw 'Resize test WebView2 was not ready.' }
  Start-Sleep -Milliseconds 500
  $resizeResults = if ($FrameProbe) { [ResizeWindowProbe]::ProbeActivation($resizeWindow) } else {
    [ResizeWindowProbe]::ProbeActivation($resizeWindow)
    [ResizeWindowProbe]::Run($resizeWindow)
  }
  foreach ($result in $resizeResults) { $result | ConvertTo-Json -Compress }
  if (@($resizeResults | Where-Object { -not $_.Passed }).Count -gt 0) { throw 'Window edge resize or visible frame rendering failed.' }
} finally {
  if ($resizeApp -and -not $resizeApp.HasExited) {
    [void][ResizeWindowProbe]::PostMessage($resizeWindow, 0x111, [UIntPtr]::new(0x8002), [IntPtr]::Zero)
    if (-not $resizeApp.WaitForExit(5000)) { Stop-Process -Id $resizeApp.Id -Force }
  }
  foreach ($name in $resizeEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $resizeEnvironment[$name], 'Process') }
  if ($resizeDpi -ne [IntPtr]::Zero) { [void][ResizeWindowProbe]::SetThreadDpiAwarenessContext($resizeDpi) }
  $resizeResolved = [IO.Path]::GetFullPath($resizeProfile)
  $resizeTempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resizeResolved.StartsWith($resizeTempPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resizeResolved) -notmatch '^pwtools-resize-[a-f0-9]{32}$') { throw 'Unsafe temporary resize profile path.' }
  if (Test-Path -LiteralPath $resizeResolved) {
    for ($retry = 0; $retry -lt 40; $retry++) {
      try { Remove-Item -LiteralPath $resizeResolved -Recurse -Force; break }
      catch { if ($retry -eq 39) { throw }; Start-Sleep -Milliseconds 200 }
    }
  }
}
