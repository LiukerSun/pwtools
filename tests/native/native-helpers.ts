import { chromium, type Browser, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NativeWindowState {
  left: number; top: number; width: number; height: number;
  workLeft: number; workTop: number; workWidth: number; workHeight: number;
  iconic: boolean; visible: boolean; maximized: boolean; toolWindow: boolean; owner: number;
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
  async restoreFromTray(): Promise<void> { await inspectCapturedWindow(this.process, 'tray-restore'); }
  async requestTrayExit(): Promise<void> { await inspectCapturedWindow(this.process, 'tray-exit'); }

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

async function inspectCapturedWindow(child: ChildProcess, action: 'inspect' | 'restore' | 'tray-restore' | 'tray-exit'): Promise<NativeWindowState> {
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
  [StructLayout(LayoutKind.Sequential)] public struct NotifyIconIdentifier { public uint Size; public IntPtr Window; public uint Id; public Guid Guid; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
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
${action === 'restore' ? '[void][PWToolsCapturedWindow]::ShowWindow($script:capturedWindow, 9)' : ''}
$trayIdentifier = [PWToolsCapturedWindow+NotifyIconIdentifier]::new()
$trayIdentifier.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($trayIdentifier)
$trayIdentifier.Window = $script:capturedWindow
$trayIdentifier.Id = 1
$trayBounds = [PWToolsCapturedWindow+Rect]::new()
$trayRegistered = [PWToolsCapturedWindow]::Shell_NotifyIconGetRect([ref]$trayIdentifier, [ref]$trayBounds) -eq 0
${action === 'tray-restore' || action === 'tray-exit' ? "if (-not $trayRegistered) { throw 'Captured application tray icon not registered' }" : ''}
$bounds = [PWToolsCapturedWindow+Rect]::new()
if (-not [PWToolsCapturedWindow]::GetWindowRect($script:capturedWindow, [ref]$bounds)) { throw 'Window bounds unavailable' }
$monitor = [PWToolsCapturedWindow+MonitorInfo]::new()
$monitor.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($monitor)
if (-not [PWToolsCapturedWindow]::GetMonitorInfo([PWToolsCapturedWindow]::MonitorFromWindow($script:capturedWindow, 2), [ref]$monitor)) { throw 'Monitor bounds unavailable' }
$extendedStyle = [PWToolsCapturedWindow]::GetWindowLongPtr($script:capturedWindow, -20).ToInt64()
$result = [ordered]@{
  left = $bounds.Left; top = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top
  workLeft = $monitor.Work.Left; workTop = $monitor.Work.Top; workWidth = $monitor.Work.Right - $monitor.Work.Left; workHeight = $monitor.Work.Bottom - $monitor.Work.Top
  iconic = [PWToolsCapturedWindow]::IsIconic($script:capturedWindow); visible = [PWToolsCapturedWindow]::IsWindowVisible($script:capturedWindow)
  maximized = [PWToolsCapturedWindow]::IsZoomed($script:capturedWindow)
  toolWindow = ($extendedStyle -band 0x80) -ne 0; owner = [PWToolsCapturedWindow]::GetWindow($script:capturedWindow, 4).ToInt64()
  trayIconRegistered = $trayRegistered
}
${action === 'tray-restore' ? "if (-not [PWToolsCapturedWindow]::PostMessage($script:capturedWindow, 0x8003, [UIntPtr]::Zero, [IntPtr]::new((1 -shl 16) -bor 0x203))) { throw 'Tray restore callback failed' }" : ''}
${action === 'tray-exit' ? "if (-not [PWToolsCapturedWindow]::PostMessage($script:capturedWindow, 0x111, [UIntPtr]::new(0x8002), [IntPtr]::Zero)) { throw 'Tray exit command failed' }" : ''}
$result | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 });
  return JSON.parse(stdout.trim()) as NativeWindowState;
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
