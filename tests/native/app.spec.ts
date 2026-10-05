import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename, sep } from 'node:path';
import type { AppInfo } from '../../apps/desktop/src/shared/contracts';
import { NativeApplication } from './native-helpers';

test('WebView2 原生桥、安全边界、DPAPI 会话重启恢复与退出', async () => {
  test.setTimeout(150_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'pwtools-native-e2e-'));
  const email = `native-${randomUUID()}@example.test`;
  const password = `Test-${randomUUID()}!`;
  let desktop: NativeApplication | undefined;
  const launch = () => NativeApplication.launch(dataDir);
  try {
    desktop = await launch();
    let page = desktop.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const runtime = await page.evaluate(async () => {
      const host = window as Window & { require?: unknown; process?: unknown; chrome?: { webview?: unknown } };
      const info = await window.pwtools!.appInfo() as AppInfo & { runtime?: string };
      return { runtime: info.runtime, persistent: info.persistentSession, nativeMessages: Boolean(host.chrome?.webview), require: typeof host.require, process: typeof host.process, origin: location.origin };
    });
    expect(runtime).toEqual({ runtime: 'webview2', persistent: true, nativeMessages: true, require: 'undefined', process: 'undefined', origin: 'https://pwtools.local' });

    const response = await page.reload();
    const policy = response?.headers()['content-security-policy'] || await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content') || '';
    expect(policy).toMatch(/connect-src\s+'none'/);
    expect(policy).toMatch(/frame-src\s+'none'/);
    expect(policy).toMatch(/object-src\s+'none'/);
    const blockedConnection = await page.evaluate(async () => {
      const violation = new Promise<string>(resolve => document.addEventListener('securitypolicyviolation', event => resolve(event.violatedDirective), { once: true }));
      await fetch('http://127.0.0.1:1/native-csp-test').catch(() => {});
      return violation;
    });
    expect(blockedConnection).toBe('connect-src');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const popup = page.waitForEvent('popup', { timeout: 1000 }).then(() => true, () => false);
    await page.evaluate(() => { window.open('https://example.invalid/pwtools-native-popup-test', '_blank'); });
    expect(await popup).toBe(false);
    expect(page.url()).toBe('https://pwtools.local/index.html');
    expect(desktop.browser.contexts().flatMap(context => context.pages())).toHaveLength(1);

    const readAllowed = await page.evaluate(async () => {
      try { await navigator.clipboard.readText(); return true; }
      catch { return false; }
    });
    expect(readAllowed).toBe(false);

    await page.getByRole('button', { name: '注册账号', exact: true }).click();
    await page.getByLabel(/^邮箱/).fill(email);
    await page.getByLabel(/^密码/).fill(password);
    await page.getByLabel(/^确认密码/).fill(password);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    const rendererSecrets = await page.evaluate(async () => {
      const bridge = window.pwtools!;
      const user = await bridge.me();
      const values = [localStorage, sessionStorage].flatMap(storage => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!) || ''));
      return {
        bridgeHasToken: Object.keys(bridge).some(key => /token/i.test(key)),
        userKeys: Object.keys(user).sort(),
        storageHasToken: values.some(value => /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)),
      };
    });
    expect(rendererSecrets).toEqual({ bridgeHasToken: false, userKeys: ['created_at', 'email', 'id'], storageHasToken: false });
    const sessionFile = (await readdir(dataDir)).find(name => /^session-native-[a-f0-9]{16}\.bin$/.test(name));
    expect(Boolean(sessionFile)).toBe(true);
    const savedSession = await readFile(join(dataDir, sessionFile!));
    expect(savedSession.byteLength).toBeGreaterThan(32);
    expect(savedSession.includes(Buffer.from(email))).toBe(false);
    expect(savedSession.includes(Buffer.from(password))).toBe(false);
    await mkdir('.artifacts', { recursive: true });
    await page.screenshot({ path: '.artifacts/native-app.png' });

    await desktop.close();
    desktop = await launch();
    page = desktop.page;
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(3);
    await expect(page.getByRole('button', { name: '战绩记录', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(window.pwtools!))).not.toContain('updateProfile');
    expect(await page.evaluate(async () => (await window.pwtools!.me()).email)).toBe(email);
    await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect((await readdir(dataDir)).some(name => /^session-native-.*\.bin$/.test(name))).toBe(false);
    const unauthorized = await page.evaluate(async () => {
      try { await window.pwtools!.me(); return 'unexpected'; }
      catch (error) { return (error as { code?: string }).code; }
    });
    expect(unauthorized).toBe('UNAUTHORIZED');
    await desktop.close();
    desktop = await launch();
    await expect(desktop.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  } finally {
    await desktop?.close().catch(() => {});
    const target = resolve(dataDir).toLowerCase();
    if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith('pwtools-native-e2e-')) {
      throw new Error('临时目录范围校验失败，未删除任何目录');
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('WebView2 用户手势复制到专用测试剪贴板', async () => {
  test.skip(process.env.PWTOOLS_TEST_ALLOW_CLIPBOARD_WRITE !== '1', '需使用专用测试剪贴板；本测试会覆盖系统剪贴板，仅在明确设置 PWTOOLS_TEST_ALLOW_CLIPBOARD_WRITE=1 时执行。');
  test.setTimeout(90_000);
  const directoryPrefix = 'pwtools-native-clipboard-write-';
  const dataDir = await mkdtemp(join(tmpdir(), directoryPrefix));
  let desktop: NativeApplication | undefined;
  try {
    desktop = await NativeApplication.launch(dataDir, 'http://127.0.0.1:1/api');
    const page = desktop.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'native-clipboard-test';
      button.textContent = '测试安全复制';
      Object.assign(button.style, { position: 'fixed', bottom: '8px', left: '8px', zIndex: '10000' });
      button.addEventListener('click', () => {
        void navigator.clipboard.writeText('PWTools native test').then(() => { button.dataset.result = 'written'; }, () => { button.dataset.result = 'denied'; });
      });
      document.body.append(button);
    });
    const copyControl = page.getByRole('button', { name: '测试安全复制', exact: true });
    await copyControl.click();
    await expect(copyControl).toHaveAttribute('data-result', 'written');
    await copyControl.evaluate(button => button.remove());
  } finally {
    await desktop?.close().catch(() => {});
    const target = resolve(dataDir).toLowerCase();
    if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith(directoryPrefix)) {
      throw new Error('临时目录范围校验失败，未删除任何目录');
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
