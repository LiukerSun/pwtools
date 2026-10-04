import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  private constructor(readonly process: ChildProcess, readonly browser: Browser, readonly page: Page) {}

  static async launch(dataDir: string, apiUrl: string | null = process.env.PWTOOLS_E2E_API_URL || 'http://localhost:8080/api'): Promise<NativeApplication> {
    const port = await availablePort();
    const executable = process.env.PWTOOLS_E2E_EXECUTABLE || resolve('apps/desktop/release/native-win-x64/PWTools.exe');
    const environment: NodeJS.ProcessEnv = { ...process.env, PWTOOLS_DATA_DIR: dataDir, PWTOOLS_DEBUG_PORT: String(port) };
    if (apiUrl === null) delete environment.PWTOOLS_API_URL;
    else environment.PWTOOLS_API_URL = apiUrl;
    const child = spawn(executable, [], {
      env: environment,
      windowsHide: true, stdio: 'ignore',
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
      return new NativeApplication(child, browser, page);
    } catch (error) {
      await stopCapturedProcess(child);
      throw error;
    }
  }

  async requestNativeClose(): Promise<void> { await nativeCommand(this.page, 'test:request-close', []); }
  async setSize(width: number, height: number): Promise<void> { await nativeCommand(this.page, 'test:window-size', [width, height]); }

  async close(): Promise<void> {
    if (!this.page.isClosed()) await this.page.evaluate(() => { void window.pwtools?.windowControl('close'); }).catch(() => {});
    if (this.process.exitCode === null) await Promise.race([once(this.process, 'exit').catch(() => {}), new Promise(done => setTimeout(done, 8000))]);
    await stopCapturedProcess(this.process);
    // Closing the CDP connection only happens after the app has exited.
    await this.browser.close().catch(() => {});
  }
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
