import { expect, test, type Page } from '@playwright/test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { Boss, BossInput, User } from '../../apps/desktop/src/shared/contracts';
import { NativeApplication } from './native-helpers';

const DIRECTORY_PREFIX = 'pwtools-native-window-behavior-';
const CLOSE_BEHAVIOR_KEY = 'pwtools:close-behavior';
const UNREACHABLE_API = 'http://127.0.0.1:1/api';

async function cleanupDirectory(directory: string) {
  const target = resolve(directory).toLowerCase();
  if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith(DIRECTORY_PREFIX)) {
    throw new Error('临时目录范围校验失败，未删除任何目录');
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function clickWindowClose(page: Page) {
  // Closing an application window remains available even behind a ledger modal.
  await page.getByRole('button', { name: '关闭窗口', exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click()).catch(error => {
    if (!page.isClosed()) throw error;
  });
}

async function expectTaskbarMinimized(app: NativeApplication, restore = true) {
  await expect.poll(async () => (await app.windowState()).iconic, { timeout: 15_000 }).toBe(true);
  const state = await app.windowState();
  expect(state.trayIconRegistered).toBe(false);
  expect(state.visible).toBe(true);
  expect(state.appWindow).toBe(true);
  expect(state.toolWindow).toBe(false);
  expect(state.owner).toBe(0);
  expect(app.process.exitCode).toBeNull();
  expect(app.page.isClosed()).toBe(false);
  expect(await app.page.evaluate(() => Boolean(window.pwtools))).toBe(true);
  if (restore) {
    await app.restoreWindow();
    await expect.poll(async () => (await app.windowState()).visible, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await app.windowState()).iconic, { timeout: 15_000 }).toBe(false);
    const restored = await app.windowState();
    expect(restored.trayIconRegistered).toBe(false);
    expect(restored.appWindow).toBe(true);
    expect(restored.toolWindow).toBe(false);
    expect(restored.owner).toBe(0);
  }
}

test('原生窗口启动居中且完整位于显示器工作区', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    const state = await app.windowState();
    const path = testInfo.outputPath('window-placement.json');
    await writeFile(path, JSON.stringify(state, null, 2));
    await testInfo.attach('native-window-placement', { path, contentType: 'application/json' });
    expect(state.iconic).toBe(false);
    expect(state.visible).toBe(true);
    expect(state.trayIconRegistered).toBe(false);
    expect(state.appWindow).toBe(true);
    expect(state.toolWindow).toBe(false);
    expect(state.owner).toBe(0);
    expect(state.left).toBeGreaterThanOrEqual(state.workLeft);
    expect(state.top).toBeGreaterThanOrEqual(state.workTop);
    expect(state.left + state.width).toBeLessThanOrEqual(state.workLeft + state.workWidth);
    expect(state.top + state.height).toBeLessThanOrEqual(state.workTop + state.workHeight);
    expect(Math.abs(state.left + state.width / 2 - (state.workLeft + state.workWidth / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(state.top + state.height / 2 - (state.workTop + state.workHeight / 2))).toBeLessThanOrEqual(1);
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('最大化窗口最小化恢复保持布局，重复启动只唤回同一测试资料目录的实例', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    const page = app.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    await page.getByRole('button', { name: '最大化或还原窗口', exact: true }).click();
    await expect.poll(async () => (await app!.windowState()).maximized).toBe(true);
    const maximized = await app.windowState();
    await app.requestNativeClose();
    await page.getByRole('dialog', { name: '关闭窗口', exact: true }).getByRole('button', { name: '最小化到任务栏', exact: true }).click();
    await expectTaskbarMinimized(app, false);
    const minimized = await app.windowState();
    await app.restoreWindow();
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    const restored = await app.windowState();
    const restorePath = testInfo.outputPath('taskbar-maximized-restore.json');
    await writeFile(restorePath, JSON.stringify({ maximized, minimized, restored, capturedProcessId: app.process.pid }, null, 2));
    await testInfo.attach('taskbar-maximized-restore', { path: restorePath, contentType: 'application/json' });
    expect(restored.maximized).toBe(true);
    expect({ left: restored.left, top: restored.top, width: restored.width, height: restored.height }).toEqual({ left: maximized.left, top: maximized.top, width: maximized.width, height: maximized.height });
    await app.requestNativeClose();
    await expectTaskbarMinimized(app, false);
    expect(await app.activateExistingInstance()).toBe(0);
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    const activated = await app.windowState();
    expect(activated.maximized).toBe(true);
    expect(activated.trayIconRegistered).toBe(false);
    expect(activated.appWindow).toBe(true);
    expect(activated.toolWindow).toBe(false);
    expect(activated.owner).toBe(0);
    expect(app.process.exitCode).toBeNull();
    expect(page.isClosed()).toBe(false);
    const path = testInfo.outputPath('taskbar-maximized-activation.json');
    await writeFile(path, JSON.stringify({ maximized, restored, activated, capturedProcessId: app.process.pid }, null, 2));
    await testInfo.attach('taskbar-maximized-activation', { path, contentType: 'application/json' });
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('首次关闭可取消，最小化到任务栏可恢复且重启后记忆选择', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    let page = app.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await clickWindowClose(page);
    const firstClose = page.getByRole('dialog', { name: '关闭窗口', exact: true });
    await expect(firstClose).toBeVisible();
    await expect(firstClose).toContainText('任务栏');
    await page.keyboard.press('Escape');
    await expect(firstClose).toHaveCount(0);
    expect(await page.evaluate(key => localStorage.getItem(key), CLOSE_BEHAVIOR_KEY)).toBeNull();
    expect((await app.windowState()).iconic).toBe(false);

    await app.requestNativeClose();
    await expect(firstClose).toBeVisible();
    await firstClose.getByRole('button', { name: '最小化到任务栏', exact: true }).click();
    await expectTaskbarMinimized(app);
    expect(await page.evaluate(key => localStorage.getItem(key), CLOSE_BEHAVIOR_KEY)).toBe('minimize');
    await expect(firstClose).toHaveCount(0);

    await clickWindowClose(page);
    await expectTaskbarMinimized(app);
    await expect(firstClose).toHaveCount(0);
    await app.close();
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    page = app.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), CLOSE_BEHAVIOR_KEY)).toBe('minimize');
    await app.requestNativeClose();
    await expectTaskbarMinimized(app);
    await expect(page.getByRole('dialog', { name: '关闭窗口', exact: true })).toHaveCount(0);

    // The ordinary title-bar minimize button retains normal taskbar behavior.
    await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(true);
    expect((await app.windowState()).visible).toBe(true);
    expect((await app.windowState()).trayIconRegistered).toBe(false);
    await app.restoreWindow();
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);

    // Explicit exit bypasses the remembered background preference,
    // then a restart retains the same compatible 'minimize' preference value.
    await app.requestNativeClose();
    await expectTaskbarMinimized(app, false);
    await app.requestExplicitExit();
    await expect.poll(() => app!.process.exitCode, { timeout: 20_000 }).toBe(0);
    await app.close();
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    page = app.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), CLOSE_BEHAVIOR_KEY)).toBe('minimize');
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('首次选择退出应用会结束进程并记忆退出偏好', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await app.requestNativeClose();
    const firstClose = app.page.getByRole('dialog', { name: '关闭窗口', exact: true });
    await expect(firstClose).toBeVisible();
    // A successful native exit can close CDP before Playwright receives its
    // pointer-action reply. Accept that race only when this page really closed;
    // the process exit and persisted preference assertions below remain required.
    await firstClose.getByRole('button', { name: '退出应用', exact: true }).click().catch(error => {
      if (!app!.page.isClosed()) throw error;
    });
    await expect.poll(() => app!.process.exitCode, { timeout: 20_000 }).toBe(0);
    await app.close();
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(await app.page.evaluate(key => localStorage.getItem(key), CLOSE_BEHAVIOR_KEY)).toBe('exit');
    await clickWindowClose(app.page);
    await expect.poll(() => app!.process.exitCode, { timeout: 20_000 }).toBe(0);
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

async function startWindowFixture() {
  const timestamp = '2026-10-05T02:00:00Z';
  const user: User = { id: '11111111-1111-4111-8111-111111111111', email: 'window-fixture@example.test', created_at: timestamp };
  const bosses: Boss[] = [];
  const unexpected: string[] = [];
  let pendingSave: { response: ServerResponse; body: BossInput } | undefined;
  let saveRequests = 0;
  const respond = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && path === '/api/health') { respond(response, 200, { status: 'ok', database: 'connected' }); return; }
      if (request.method === 'POST' && path === '/api/auth/login') { request.resume(); respond(response, 200, { token: 'isolated-window-test-session', user }); return; }
      if (request.method === 'GET' && path === '/api/me') { respond(response, 200, user); return; }
      if (request.method === 'GET' && path === '/api/bosses') { respond(response, 200, { items: bosses }); return; }
      if (request.method === 'GET' && path === '/api/orders') { respond(response, 200, { items: [] }); return; }
      if (request.method === 'GET' && path === '/api/bosses/22222222-2222-4222-8222-222222222222') { respond(response, 200, bosses[0]); return; }
      if (request.method === 'POST' && path === '/api/bosses') {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
        const body: BossInput = JSON.parse(Buffer.concat(parts).toString('utf8'));
        saveRequests++;
        pendingSave = { response, body };
        return;
      }
      unexpected.push(`${request.method} ${path}`);
      respond(response, 404, { error: { code: 'FIXTURE_ROUTE_MISSING', message: '测试路由未配置。' } });
    })().catch(() => { unexpected.push('测试请求解析失败'); response.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务未监听 TCP 端口');
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api`, unexpected,
    get saveRequests() { return saveRequests; },
    get hasPendingSave() { return Boolean(pendingSave); },
    releaseSave() {
      if (!pendingSave) throw new Error('没有在途测试保存');
      const boss: Boss = { ...pendingSave.body, id: '22222222-2222-4222-8222-222222222222', active_order_count: 0, remaining_minutes: 0, remaining_amount: 0, pending_single_round_count: 0, created_at: timestamp, updated_at: timestamp };
      bosses.push(boss);
      respond(pendingSave.response, 201, boss);
      pendingSave = undefined;
    },
    async close() { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); },
  };
}

test('设置记忆关闭方式，草稿与在途保存最小化到任务栏后继续保留', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  const fixture = await startWindowFixture();
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, fixture.apiUrl);
    let page = app.page;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await page.getByLabel(/^邮箱/).fill('window-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Fixture-window-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await app.setSize(960, 760);
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 960, height: 760 });
    await mkdir('.artifacts/window-behavior', { recursive: true });
    for (const mode of ['dark', 'light'] as const) {
      if (mode === 'light') await page.getByRole('button', { name: '切换至浅色', exact: true }).click();
      await clickWindowClose(page);
      const firstClose = page.getByRole('dialog', { name: '关闭窗口', exact: true });
      await expect(firstClose).toBeVisible();
      await expect(firstClose).toBeInViewport({ ratio: 1 });
      await expect(firstClose.getByRole('button', { name: '最小化到任务栏', exact: true })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: `.artifacts/window-behavior/first-close-${mode}-960.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(firstClose).toHaveCount(0);
    }
    await page.getByRole('button', { name: '切换至深色', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
    const closeSwitch = page.getByRole('switch', { name: /^关闭窗口时最小化到任务栏/ });
    await expect(closeSwitch).toBeChecked();
    for (const mode of ['dark', 'light'] as const) {
      if (mode === 'light') await page.getByRole('button', { name: '切换至浅色', exact: true }).click();
      await expect(closeSwitch).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: `.artifacts/window-behavior/settings-${mode}-960.png`, animations: 'disabled' });
    }
    await closeSwitch.uncheck();
    expect(await page.evaluate(key => localStorage.getItem(key), CLOSE_BEHAVIOR_KEY)).toBe('exit');
    await clickWindowClose(page);
    await expect.poll(() => app!.process.exitCode, { timeout: 20_000 }).toBe(0);
    await app.close();

    app = await NativeApplication.launch(directory, fixture.apiUrl);
    page = app.page;
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
    const restoredSwitch = page.getByRole('switch', { name: /^关闭窗口时最小化到任务栏/ });
    await expect(restoredSwitch).not.toBeChecked();
    await restoredSwitch.check();
    expect(await page.evaluate(key => localStorage.getItem(key), CLOSE_BEHAVIOR_KEY)).toBe('minimize');
    await page.getByRole('navigation').getByRole('button', { name: '老板账本', exact: true }).click();
    await page.getByRole('button', { name: '添加老板', exact: true }).click();
    const form = page.getByRole('dialog', { name: '添加老板', exact: true });
    await form.getByLabel(/^老板称呼/).fill('后台保存测试老板');
    await form.getByLabel(/^老板备注/).fill('任务栏最小化保留草稿和在途保存');
    await clickWindowClose(page);
    await expectTaskbarMinimized(app);
    await expect(page.getByRole('dialog', { name: '尚有未保存修改', exact: true })).toHaveCount(0);
    await expect(form.getByLabel(/^老板称呼/)).toHaveValue('后台保存测试老板');
    await expect(form.getByLabel(/^老板备注/)).toHaveValue('任务栏最小化保留草稿和在途保存');

    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => fixture.hasPendingSave).toBe(true);
    await expect(form.getByLabel(/^老板称呼/)).toBeDisabled();
    await app.requestNativeClose();
    await expectTaskbarMinimized(app, false);
    await expect(page.getByText('当前操作尚未完成', { exact: true })).toHaveCount(0);
    fixture.releaseSave();
    await expect(form).toHaveCount(0);
    expect((await app.windowState()).visible).toBe(true);
    expect((await app.windowState()).iconic).toBe(true);
    expect((await app.windowState()).trayIconRegistered).toBe(false);
    await app.restoreWindow();
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    expect((await app.windowState()).trayIconRegistered).toBe(false);
    await expect(page.getByRole('region', { name: '老板详情与订单', exact: true })).toContainText('后台保存测试老板');
    expect(fixture.saveRequests).toBe(1);
    expect(fixture.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app?.close().catch(() => {});
    await fixture.close();
    await cleanupDirectory(directory);
  }
});

test('显式退出先恢复窗口，并保护草稿与在途保存，完成后可正常退出', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  const fixture = await startWindowFixture();
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, fixture.apiUrl);
    const page = app.page;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await page.getByLabel(/^邮箱/).fill('window-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Fixture-window-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await app.requestNativeClose();
    await page.getByRole('dialog', { name: '关闭窗口', exact: true }).getByRole('button', { name: '最小化到任务栏', exact: true }).click();
    await expectTaskbarMinimized(app);

    await page.getByRole('button', { name: '添加老板', exact: true }).click();
    const form = page.getByRole('dialog', { name: '添加老板', exact: true });
    await form.getByLabel(/^老板称呼/).fill('任务栏退出保护测试老板');
    await app.requestNativeClose();
    await expectTaskbarMinimized(app, false);
    const minimizedWithDraft = await app.windowState();
    await app.requestExplicitExit();
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    expect((await app.windowState()).trayIconRegistered).toBe(false);
    const guard = page.getByRole('dialog', { name: '尚有未保存修改', exact: true });
    await expect(guard).toBeVisible();
    expect(app.process.exitCode).toBeNull();
    await guard.getByRole('button', { name: '继续填写', exact: true }).click();
    await expect(guard).toHaveCount(0);
    await expect(form.getByLabel(/^老板称呼/)).toHaveValue('任务栏退出保护测试老板');

    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => fixture.hasPendingSave).toBe(true);
    await app.requestNativeClose();
    await expectTaskbarMinimized(app, false);
    const minimizedDuringSave = await app.windowState();
    await app.requestExplicitExit();
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    expect((await app.windowState()).trayIconRegistered).toBe(false);
    await expect(page.getByText('当前操作尚未完成', { exact: true })).toBeVisible();
    expect(app.process.exitCode).toBeNull();
    expect(fixture.hasPendingSave).toBe(true);
    await expect(form.getByLabel(/^老板称呼/)).toBeDisabled();
    fixture.releaseSave();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('region', { name: '老板详情与订单', exact: true })).toContainText('任务栏退出保护测试老板');
    await app.requestNativeClose();
    await expectTaskbarMinimized(app, false);
    await app.requestExplicitExit();
    await expect.poll(() => app!.process.exitCode, { timeout: 20_000 }).toBe(0);
    expect(fixture.saveRequests).toBe(1);
    expect(fixture.unexpected).toEqual([]);
    expect(errors).toEqual([]);
    const path = testInfo.outputPath('taskbar-exit-protection.json');
    await writeFile(path, JSON.stringify({ minimizedWithDraft, minimizedDuringSave, saveRequests: fixture.saveRequests, exitCode: app.process.exitCode }, null, 2));
    await testInfo.attach('taskbar-exit-protection', { path, contentType: 'application/json' });
  } finally {
    await app?.close().catch(() => {});
    await fixture.close();
    await cleanupDirectory(directory);
  }
});
