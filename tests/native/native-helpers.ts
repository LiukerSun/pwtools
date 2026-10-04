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

  static async launch(dataDir: string, apiUrl: string | null = process.env.PWTOOLS_E2E_API_URL || 'http://localhost:8080/api'): Promise<NativeApplication> {
    const port = await availablePort();
    const executable = process.env.PWTOOLS_E2E_EXECUTABLE || resolve('apps/desktop/release/native-win-x64/PWTools.exe');
    const environment: NodeJS.ProcessEnv = { ...process.env, PWTOOLS_DATA_DIR: dataDir, PWTOOLS_DEBUG_PORT: String(port) };
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

async function inspectCapturedWindow(child: ChildProcess, action: 'inspect' | 'restore' | 'explicit-exit'): Promise<NativeWindowState> {
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
    if ($className.ToString() -eq 'PWToolsWebView2') { $script:capturedWindow = $window; return $false }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:capturedWindow -eq [IntPtr]::Zero) { throw 'Captured application window not found' }
${action === 'restore' ? "if (-not [PWToolsCapturedWindow]::PostMessage($script:capturedWindow, 0x112, [UIntPtr]::new(0xF120), [IntPtr]::Zero)) { throw 'Captured taskbar restore command failed' }" : ''}
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
}
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

export async function nativeCommand(page: Page, method: string, args: unknown[]): Promise<unknown> {
  return page.evaluate(({ id, method, args }) => new Promise((resolve, reject) => {
    const webview = (window as unknown as { chrome: { webview: { postMessage(value: unknown): void; addEventListener(type: string, listener: (event: MessageEvent) => void): void; removeEventListener(type: string, listener: (event: MessageEvent) => void): void } } }).chrome.webview;
    const timer = setTimeout(() => { webview.removeEventListener('message', listener); reject(new Error('原生测试操作超时')); }, 10_000);
    const listener = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      clearTimeout(timer); webview.removeEventListener('message', listener);
      if (event.data.ok) resolve(event.data.data); else reject(new Error(event.data.error?.code || '原生操作失败'));
    };
    webview.addEventListener('message', listener);
    webview.postMessage({ id, method, args });
  }), { id: randomUUID(), method, args });
}
