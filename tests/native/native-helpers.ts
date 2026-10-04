import { chromium, type Browser, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { ImportHotkey } from '../../apps/desktop/src/shared/contracts';

const execFileAsync = promisify(execFile);

export interface NativeWindowState {
  left: number; top: number; width: number; height: number;
  workLeft: number; workTop: number; workWidth: number; workHeight: number;
  iconic: boolean; visible: boolean; maximized: boolean; toolWindow: boolean; appWindow: boolean; owner: number;
  restoreToMaximized: boolean; showCommand: number;
  trayIconRegistered: boolean;
  patternWindowRgb?: number[]; patternDesktopRgb?: number[]; patternCloaked?: number; topMost?: boolean;
}

export interface NativeCaptureState {
  active: boolean; overlay: string; originalIconic: boolean; pattern: boolean;
  parentWindowVisible: boolean; parentWindowIconic: boolean; shown: boolean; ready: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配测试端口');
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

export class NativeApplication {
  private constructor(readonly process: ChildProcess, readonly browser: Browser, readonly page: Page, private readonly launchEnvironment: NodeJS.ProcessEnv) {}

  static async launch(dataDir: string, apiUrl: string | null = process.env.PWTOOLS_E2E_API_URL || 'http://localhost:8080/api', extraEnvironment: NodeJS.ProcessEnv = {}): Promise<NativeApplication> {
    const port = await availablePort();
    const executable = process.env.PWTOOLS_E2E_EXECUTABLE || resolve('apps/desktop/release/native-win-x64/PWTools.exe');
    const environment: NodeJS.ProcessEnv = { ...process.env, ...extraEnvironment, PWTOOLS_DATA_DIR: dataDir, PWTOOLS_DEBUG_PORT: String(port) };
    if (apiUrl === null) delete environment.PWTOOLS_API_URL;
    else environment.PWTOOLS_API_URL = apiUrl;
    const child = spawn(executable, [], {
      env: environment,
      windowsHide: false, stdio: 'ignore',
    });
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (spawnFailed || child.exitCode !== null) throw new Error('原生测试程序未能启动');
        const ready = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(500) }).then(response => response.ok).catch(() => false);
        if (ready) break;
        if (attempt === 149) throw new Error('WebView2 调试接口未就绪');
        await new Promise(done => setTimeout(done, 200));
      }
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
      let page: Page | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('https://pwtools.local/'));
        if (page) break;
        await new Promise(done => setTimeout(done, 100));
      }
      if (!page) throw new Error('原生页面未载入');
      page.setDefaultTimeout(20_000);
      await page.waitForFunction(() => Boolean(window.pwtools), undefined, { timeout: 30_000 });
      return new NativeApplication(child, browser, page, environment);
    } catch (error) {
      await stopCapturedProcess(child);
      throw error;
    }
  }

  async requestNativeClose(): Promise<void> { await nativeCommand(this.page, 'test:request-close', []); }
  async setSize(width: number, height: number): Promise<void> { await nativeCommand(this.page, 'test:window-size', [width, height]); }
  async windowState(): Promise<NativeWindowState> { return inspectCapturedWindow(this.process, 'inspect'); }
  async restoreWindow(): Promise<void> { await inspectCapturedWindow(this.process, 'restore'); }
  async requestExplicitExit(): Promise<void> { await inspectCapturedWindow(this.process, 'explicit-exit'); }
  async sendRegisteredHotkey(shortcut: ImportHotkey): Promise<void> { await sendCapturedHotkey(this.process, shortcut); }
  async notifyRegisteredHotkey(shortcut: ImportHotkey): Promise<void> {
    if (!/^F(?:8|9|10|11)$/.test(shortcut.code) || !shortcut.ctrl || !shortcut.alt || !shortcut.shift || shortcut.win) throw new Error('测试通知只允许独立实例持有的 Ctrl+Alt+Shift+F8–F11');
    await inspectCapturedWindow(this.process, 'hotkey-notification', shortcut);
  }
  async captureState(): Promise<NativeCaptureState> { return nativeCommand(this.page, 'test:capture-state', []) as Promise<NativeCaptureState>; }
  async capturePage(): Promise<Page> {
    for (let attempt = 0; attempt < 150; attempt++) {
      const overlay = this.browser.contexts().flatMap(context => context.pages()).filter(item => !item.isClosed() && item.url() === 'https://pwtools.local/capture.html').at(-1);
      if (overlay) { overlay.setDefaultTimeout(20_000); return overlay; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error('独立截图 WebView 未载入');
  }

  async activateExistingInstance(): Promise<number | null> {
    // A duplicate launch uses only this captured test executable and profile.
    // It must forward activation to this profile, then exit without a WebView.
    const duplicate = spawn(this.process.spawnfile, [], {
      env: { ...this.launchEnvironment, PWTOOLS_DEBUG_PORT: '0' },
      windowsHide: false, stdio: 'ignore',
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [code] = await Promise.race([
        once(duplicate, 'exit'),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('重复启动未能唤回捕获的测试实例')), 15_000); }),
      ]);
      return code;
    } finally {
      clearTimeout(timer);
      await stopCapturedProcess(duplicate);
    }
  }

  async close(): Promise<void> {
    if (!this.page.isClosed()) await this.page.evaluate(() => { void window.pwtools?.windowControl('close'); }).catch(() => {});
    if (this.process.exitCode === null) await Promise.race([once(this.process, 'exit').catch(() => {}), new Promise(done => setTimeout(done, 8000))]);
    await stopCapturedProcess(this.process);
    // Closing the CDP connection only happens after the app has exited.
    await this.browser.close().catch(() => {});
  }
}

async function inspectCapturedWindow(child: ChildProcess, action: 'inspect' | 'restore' | 'explicit-exit' | 'hotkey-notification' | 'present-pattern', shortcut?: ImportHotkey, patternWindow = false): Promise<NativeWindowState> {
  if (process.platform !== 'win32' || !child.pid || child.exitCode !== null) throw new Error('测试原生窗口进程不存在');
  // Enumerate only the captured child PID and expected application class. Never
  // inspect, restore, or close a normal user profile or another application's HWND.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PWToolsCapturedWindow {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WindowPlacement { public uint Size, Flags, ShowCommand; public Point MinPosition, MaxPosition; public Rect NormalPosition; }
  [StructLayout(LayoutKind.Sequential)] public struct NotifyIconIdentifier { public uint Size; public IntPtr Window; public uint Id; public Guid Guid; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr window, ref WindowPlacement placement);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr window, IntPtr rect, IntPtr region, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out uint value, uint size);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  [DllImport("shell32.dll")] public static extern int Shell_NotifyIconGetRect(ref NotifyIconIdentifier identifier, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
[void][PWToolsCapturedWindow]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$script:capturedWindow = [IntPtr]::Zero
$targetProcess = [uint32]${child.pid}
[PWToolsCapturedWindow]::EnumWindows({ param($window, $data)
  $windowProcess = [uint32]0
  [void][PWToolsCapturedWindow]::GetWindowThreadProcessId($window, [ref]$windowProcess)
  if ($windowProcess -eq $targetProcess) {
    $className = [System.Text.StringBuilder]::new(128)
    [void][PWToolsCapturedWindow]::GetClassName($window, $className, $className.Capacity)
    if (${patternWindow ? "$className.ToString() -eq 'PWToolsCapturePatternWindow'" : "$className.ToString() -eq 'PWToolsWebView2'"}) { $script:capturedWindow = $window; return $false }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:capturedWindow -eq [IntPtr]::Zero) { throw 'Captured application window not found' }
${action === 'present-pattern' && patternWindow ? "if (-not [PWToolsCapturedWindow]::SetWindowPos($script:capturedWindow, [IntPtr]::new(-1), 0, 0, 0, 0, 0x43)) { throw 'Owned pattern presentation failed' }; [void][PWToolsCapturedWindow]::RedrawWindow($script:capturedWindow, [IntPtr]::Zero, [IntPtr]::Zero, 0x105)" : ''}
${action === 'restore' ? "if (-not [PWToolsCapturedWindow]::PostMessage($script:capturedWindow, 0x112, [UIntPtr]::new(0xF120), [IntPtr]::Zero)) { throw 'Captured taskbar restore command failed' }" : ''}
${action === 'hotkey-notification' ? `[void][PWToolsCapturedWindow]::PostMessage($script:capturedWindow, 0x312, [UIntPtr]::new(0x7001), [IntPtr]::new(${((0x70 + Number(shortcut!.code.slice(1)) - 1) << 16) | 7}))
if (-not [PWToolsCapturedWindow]::PostMessage($script:capturedWindow, 0x312, [UIntPtr]::new(0x7002), [IntPtr]::new(${((0x70 + Number(shortcut!.code.slice(1)) - 1) << 16) | 7}))) { throw 'Captured hotkey notification failed' }` : ''}
$trayIdentifier = [PWToolsCapturedWindow+NotifyIconIdentifier]::new()
$trayIdentifier.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($trayIdentifier)
$trayIdentifier.Window = $script:capturedWindow
$trayIdentifier.Id = 1
$trayBounds = [PWToolsCapturedWindow+Rect]::new()
$trayRegistered = [PWToolsCapturedWindow]::Shell_NotifyIconGetRect([ref]$trayIdentifier, [ref]$trayBounds) -eq 0
$bounds = [PWToolsCapturedWindow+Rect]::new()
if (-not [PWToolsCapturedWindow]::GetWindowRect($script:capturedWindow, [ref]$bounds)) { throw 'Window bounds unavailable' }
$monitor = [PWToolsCapturedWindow+MonitorInfo]::new()
$monitor.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($monitor)
if (-not [PWToolsCapturedWindow]::GetMonitorInfo([PWToolsCapturedWindow]::MonitorFromWindow($script:capturedWindow, 2), [ref]$monitor)) { throw 'Monitor bounds unavailable' }
$extendedStyle = [PWToolsCapturedWindow]::GetWindowLongPtr($script:capturedWindow, -20).ToInt64()
$placement = [PWToolsCapturedWindow+WindowPlacement]::new()
$placement.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($placement)
if (-not [PWToolsCapturedWindow]::GetWindowPlacement($script:capturedWindow, [ref]$placement)) { throw 'Captured window placement unavailable' }
$result = [ordered]@{
  left = $bounds.Left; top = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top
  workLeft = $monitor.Work.Left; workTop = $monitor.Work.Top; workWidth = $monitor.Work.Right - $monitor.Work.Left; workHeight = $monitor.Work.Bottom - $monitor.Work.Top
  iconic = [PWToolsCapturedWindow]::IsIconic($script:capturedWindow); visible = [PWToolsCapturedWindow]::IsWindowVisible($script:capturedWindow)
  maximized = [PWToolsCapturedWindow]::IsZoomed($script:capturedWindow)
  restoreToMaximized = ($placement.Flags -band 2) -ne 0; showCommand = $placement.ShowCommand
  toolWindow = ($extendedStyle -band 0x80) -ne 0; appWindow = ($extendedStyle -band 0x40000) -ne 0; owner = [PWToolsCapturedWindow]::GetWindow($script:capturedWindow, 4).ToInt64()
  trayIconRegistered = $trayRegistered
  topMost = ($extendedStyle -band 8) -ne 0
}
${patternWindow ? `[void][PWToolsCapturedWindow]::DwmFlush()
$cloaked = [uint32]0
[void][PWToolsCapturedWindow]::DwmGetWindowAttribute($script:capturedWindow, 14, [ref]$cloaked, 4)
$result.patternCloaked = $cloaked
$patternDc = [PWToolsCapturedWindow]::GetDC($script:capturedWindow)
$desktopDc = [PWToolsCapturedWindow]::GetDC([IntPtr]::Zero)
try {
  $patternColor = [PWToolsCapturedWindow]::GetPixel($patternDc, 48, 40)
  $desktopColor = [PWToolsCapturedWindow]::GetPixel($desktopDc, $bounds.Left + 48, $bounds.Top + 40)
  $result.patternWindowRgb = @([int]($patternColor -band 255), [int](($patternColor -shr 8) -band 255), [int](($patternColor -shr 16) -band 255))
  $result.patternDesktopRgb = @([int]($desktopColor -band 255), [int](($desktopColor -shr 8) -band 255), [int](($desktopColor -shr 16) -band 255))
} finally {
  [void][PWToolsCapturedWindow]::ReleaseDC($script:capturedWindow, $patternDc)
  [void][PWToolsCapturedWindow]::ReleaseDC([IntPtr]::Zero, $desktopDc)
}` : ''}
${action === 'explicit-exit' ? "if (-not [PWToolsCapturedWindow]::PostMessage($script:capturedWindow, 0x111, [UIntPtr]::new(0x8002), [IntPtr]::Zero)) { throw 'Captured application exit command failed' }" : ''}
$result | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 });
  return JSON.parse(stdout.trim()) as NativeWindowState;
}

async function sendCapturedHotkey(child: ChildProcess, shortcut: ImportHotkey): Promise<void> {
  if (process.platform !== 'win32' || !child.pid || child.exitCode !== null) throw new Error('测试原生窗口进程不存在');
  // These rare combinations are registered only by isolated test profiles. This
  // helper never sends a default user shortcut, changes focus or writes clipboard.
  if (!/^F(?:8|9|10|11)$/.test(shortcut.code) || !shortcut.ctrl || !shortcut.alt || !shortcut.shift || shortcut.win) {
    throw new Error('全局输入只允许独立测试实例持有的 Ctrl+Alt+Shift+F8–F11');
  }
  const key = 0x70 + Number(shortcut.code.slice(1)) - 1;
  const script = `
$ErrorActionPreference = 'Stop'
if (-not (Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue)) { throw 'Captured test process exited' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PWToolsTestHotkey {
  [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] public struct InputData { [FieldOffset(0)] public KeyboardInput Keyboard; [FieldOffset(0)] public MouseInput Mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public InputData Data; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  private static bool ModifiersReleased() {
    foreach (int modifier in new int[] { 0x11, 0x12, 0x10, 0x5B, 0x5C }) {
      if ((GetAsyncKeyState(modifier) & 0x8000) != 0) return false;
    }
    return true;
  }
  public static void Press(ushort key) {
    for (int attempt = 0; !ModifiersReleased() && attempt < 10; attempt++) System.Threading.Thread.Sleep(50);
    if (!ModifiersReleased()) throw new InvalidOperationException("User modifier key is held; test shortcut input was not sent");
    ushort[] keys = { 0x11, 0x12, 0x10, key };
    Input[] inputs = new Input[keys.Length * 2];
    for (int index = 0; index < keys.Length; index++) {
      inputs[index].Type = 1; inputs[index].Data.Keyboard.Key = keys[index];
      inputs[keys.Length + index].Type = 1;
      inputs[keys.Length + index].Data.Keyboard.Key = keys[keys.Length - index - 1];
      inputs[keys.Length + index].Data.Keyboard.Flags = 2;
    }
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
[PWToolsTestHotkey]::Press([uint16]${key})
`;
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 });
}

async function stopCapturedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'exit').catch(() => {});
  } else child.kill('SIGKILL');
  if (child.exitCode === null) await Promise.race([once(child, 'exit').catch(() => {}), new Promise(done => setTimeout(done, 4000))]);
}

export async function createCapturePatternWindow(): Promise<{ left: number; top: number; width: number; height: number; diagnostic: NativeWindowState; close: () => Promise<void> }> {
  if (process.platform !== 'win32') throw new Error('截图 pattern 窗口测试仅限 Windows');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PWToolsNativeCapturePattern {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct WindowClass {
    public uint Size, Style; public IntPtr Procedure; public int ClassExtra, WindowExtra;
    public IntPtr Instance, Icon, Cursor, Background; public string MenuName, ClassName; public IntPtr SmallIcon;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PaintStruct {
    public IntPtr Dc; public int Erase; public Rect Bounds; public int Restore, Update;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=32)] public byte[] Reserved;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Position; public uint Private; }
  public delegate IntPtr WindowProcedure(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  private static readonly WindowProcedure Procedure = WindowProc;
  private static IntPtr background, accent;
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string module);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(Point point, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern ushort RegisterClassEx(ref WindowClass definition);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateWindowEx(uint extended, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr BeginPaint(IntPtr window, out PaintStruct paint);
  [DllImport("user32.dll")] public static extern bool EndPaint(IntPtr window, ref PaintStruct paint);
  [DllImport("user32.dll")] public static extern int FillRect(IntPtr dc, ref Rect rect, IntPtr brush);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateSolidBrush(uint color);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
  [DllImport("user32.dll")] public static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] public static extern IntPtr DefWindowProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern void PostQuitMessage(int code);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  private static IntPtr WindowProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam) {
    if (message == 0xF) {
      PaintStruct paint; var dc = BeginPaint(window, out paint); Rect client; GetClientRect(window, out client);
      FillRect(dc, ref client, background);
      var square = new Rect { Left=0, Top=0, Right=24, Bottom=24 }; FillRect(dc, ref square, accent);
      EndPaint(window, ref paint); return IntPtr.Zero;
    }
    if (message == 0x2) { PostQuitMessage(0); return IntPtr.Zero; }
    return DefWindowProc(window, message, wParam, lParam);
  }
  public static void Run() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    background = CreateSolidBrush(0xA06030); accent = CreateSolidBrush(0x6030A0);
    var instance = GetModuleHandle(null);
    var definition = new WindowClass { Size=(uint)Marshal.SizeOf(typeof(WindowClass)), Style=3, Procedure=Marshal.GetFunctionPointerForDelegate(Procedure), Instance=instance, Background=background, ClassName="PWToolsCapturePatternWindow" };
    if (RegisterClassEx(ref definition) == 0) throw new InvalidOperationException("Owned pattern class registration failed");
    var monitor = new MonitorInfo { Size=(uint)Marshal.SizeOf(typeof(MonitorInfo)) };
    if (!GetMonitorInfo(MonitorFromPoint(new Point(), 1), ref monitor)) throw new InvalidOperationException("Primary monitor unavailable");
    var window = CreateWindowEx(0x88, definition.ClassName, "PWTools capture test pattern", 0x80000000, monitor.Work.Left+64, monitor.Work.Top+64, 320, 240, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
    if (window == IntPtr.Zero) throw new InvalidOperationException("Owned pattern window creation failed");
    ShowWindow(window, 5); SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x43); UpdateWindow(window); DwmFlush();
    Rect bounds; GetWindowRect(window, out bounds);
    Console.WriteLine(bounds.Left+","+bounds.Top+","+(bounds.Right-bounds.Left)+","+(bounds.Bottom-bounds.Top)); Console.Out.Flush();
    Message message;
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
    DeleteObject(background); DeleteObject(accent);
  }
}
'@
[PWToolsNativeCapturePattern]::Run()
`;

  const pattern = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<{ left: number; top: number; width: number; height: number }>((resolveReady, reject) => {
      let output = '', error = '';
      timer = setTimeout(() => reject(new Error('测试 pattern 窗口未完成绘制')), 15_000);
      pattern.on('error', reject);
      pattern.stderr?.on('data', data => { error += String(data); });
      pattern.on('exit', code => reject(new Error(`测试 pattern 窗口提前退出 (${code}): ${error}`)));
      pattern.stdout?.on('data', data => {
        output += String(data);
        const line = output.split(/\r?\n/).find(item => /^-?\d+,-?\d+,\d+,\d+$/.test(item));
        if (line) {
          const [left, top, width, height] = line.split(',').map(Number);
          resolveReady({ left, top, width, height });
        }
      });
    });
    // Inspect the exact owned class from a separate PMv2 thread to obtain
    // physical desktop coordinates, matching the native capture's pixel space.
    let bounds = await inspectCapturedWindow(pattern, 'present-pattern', undefined, true);
    for (let attempt = 0; attempt < 4 && JSON.stringify(bounds.patternDesktopRgb) !== '[48,96,160]'; attempt++) {
      await new Promise(done => setTimeout(done, 100));
      bounds = await inspectCapturedWindow(pattern, 'inspect', undefined, true);
    }
    return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, diagnostic: bounds, close: () => stopCapturedProcess(pattern) };
  } catch (failure) {
    await stopCapturedProcess(pattern);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

export async function nativeCommand(page: Page, method: string, args: unknown[], timeoutMillis = 10_000): Promise<unknown> {
  return page.evaluate(({ id, method, args, timeoutMillis }) => new Promise((resolve, reject) => {
    const webview = (window as unknown as { chrome: { webview: { postMessage(value: unknown): void; addEventListener(type: string, listener: (event: MessageEvent) => void): void; removeEventListener(type: string, listener: (event: MessageEvent) => void): void } } }).chrome.webview;
    const timer = setTimeout(() => { webview.removeEventListener('message', listener); reject(new Error('原生测试操作超时')); }, timeoutMillis);
    const listener = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      clearTimeout(timer); webview.removeEventListener('message', listener);
      if (event.data.ok) resolve(event.data.data); else reject(new Error(event.data.error?.code || '原生操作失败'));
    };
    webview.addEventListener('message', listener);
    webview.postMessage({ id, method, args });
  }), { id: randomUUID(), method, args, timeoutMillis });
}
