import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { Boss, DesktopBridge, ImportHotkey, MatchRecord, MatchUpdateInput, MatchUploadInput, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { nativeCommand, NativeApplication } from './native-helpers';

const DIRECTORY_PREFIX = 'pwtools-native-hotkey-';
const UNREACHABLE_API = 'http://127.0.0.1:1/api';
const shortcut = (code: string): ImportHotkey => ({ code, ctrl: true, alt: true, shift: true, win: false });
const PRIMARY = shortcut('F9');
const SECONDARY = shortcut('F10');
const timestamp = '2026-10-05T02:00:00Z';
const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqucAAAAASUVORK5CYII=', 'base64');

async function cleanupDirectory(directory: string) {
  const target = resolve(directory).toLowerCase();
  if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith(DIRECTORY_PREFIX)) throw new Error('临时目录范围校验失败，未删除任何目录');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function captureImports(app: NativeApplication) {
  await app.page.evaluate(() => {
    const state = { count: 0 };
    (window as Window & { hotkeyEvents?: typeof state }).hotkeyEvents = state;
    window.pwtools!.onImportRequested!(() => state.count++);
  });
}

async function importCount(app: NativeApplication) {
  return app.page.evaluate(() => (window as Window & { hotkeyEvents?: { count: number } }).hotkeyEvents?.count);
}

test('原生快捷键通知路径从最小化恢复任务栏窗口并且每次仅触发一次导入事件', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await captureImports(app);
    await nativeCommand(app.page, 'setImportHotkey', [PRIMARY]);
    await nativeCommand(app.page, 'setImportHotkey', [PRIMARY]);
    await app.page.evaluate(() => window.pwtools!.windowControl('maximize'));
    await expect.poll(async () => (await app!.windowState()).maximized).toBe(true);
    const maximized = await app.windowState();
    await app.page.evaluate(() => window.pwtools!.windowControl('minimize'));
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(true);
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(() => importCount(app!)).toBe(1);
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    const restored = await app.windowState();
    expect(restored.visible).toBe(true);
    expect(restored.appWindow).toBe(true);
    expect(restored.toolWindow).toBe(false);
    expect(restored.owner).toBe(0);
    expect(restored.trayIconRegistered).toBe(false);
    expect(restored.maximized).toBe(true);
    expect({ left: restored.left, top: restored.top, width: restored.width, height: restored.height }).toEqual({ left: maximized.left, top: maximized.top, width: maximized.width, height: maximized.height });
    await expect(app.page.getByText('请先登录', { exact: true })).toBeVisible();
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(() => importCount(app!)).toBe(2);
    await nativeCommand(app.page, 'setImportHotkey', [null]);
    await testInfo.attach('registered-hotkey-recovery', { body: JSON.stringify({ events: 2, shortcut: PRIMARY, trigger: 'captured PID WM_HOTKEY test notification; no global keyboard input', maximized, restored, processId: app.process.pid }), contentType: 'application/json' });
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('快捷键冲突保留原绑定，禁用与退出均释放测试快捷键', async () => {
  test.setTimeout(120_000);
  const firstDirectory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  const secondDirectory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let first: NativeApplication | undefined;
  let second: NativeApplication | undefined;
  try {
    first = await NativeApplication.launch(firstDirectory, UNREACHABLE_API);
    second = await NativeApplication.launch(secondDirectory, UNREACHABLE_API);
    await expect(first.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect(second.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await captureImports(first);
    await captureImports(second);
    await nativeCommand(first.page, 'setImportHotkey', [PRIMARY]);
    await nativeCommand(second.page, 'setImportHotkey', [SECONDARY]);
    await expect(nativeCommand(second.page, 'setImportHotkey', [PRIMARY])).rejects.toThrow('HOTKEY_CONFLICT');
    await expect(nativeCommand(second.page, 'setImportHotkey', [{ ...SECONDARY, ctrl: false, alt: false, shift: true }])).rejects.toThrow('INVALID_INPUT');
    await expect(nativeCommand(second.page, 'setImportHotkey', [shortcut('F12')])).rejects.toThrow('INVALID_INPUT');
    await second.notifyRegisteredHotkey(SECONDARY);
    await expect.poll(() => importCount(second!)).toBe(1);
    await first.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(() => importCount(first!)).toBe(1);
    expect(await importCount(second)).toBe(1);

    await nativeCommand(first.page, 'setImportHotkey', [null]);
    await nativeCommand(second.page, 'setImportHotkey', [PRIMARY]);
    await second.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(() => importCount(second!)).toBe(2);
    expect(await importCount(first)).toBe(1);

    await second.close();
    await nativeCommand(first.page, 'setImportHotkey', [PRIMARY]);
    await first.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(() => importCount(first!)).toBe(2);
    await nativeCommand(first.page, 'setImportHotkey', [null]);
  } finally {
    await second?.close().catch(() => {});
    await first?.close().catch(() => {});
    await cleanupDirectory(secondDirectory);
    await cleanupDirectory(firstDirectory);
  }
});

interface ImportFixtureState {
  unexpected: string[];
  captureCalls: number;
  uploads: { name: string; order_id?: string; data: number[] }[];
  updates: { id: string; input: MatchUpdateInput }[];
}

async function installImportFixture(app: NativeApplication) {
  const boss = (name: string): Boss => ({
    id: randomUUID(), display_name: name, game_id: '', game_name: `${name}昵称`, notes: '', active_order_count: 1,
    remaining_minutes: 60, remaining_amount: 5000000, pending_single_round_count: 1, created_at: timestamp, updated_at: timestamp,
  });
  const firstBoss = boss('快捷导入老板甲');
  const secondBoss = boss('快捷导入老板乙');
  const order = (owner: Boss, title: string, kind: ServiceOrder['kind']): ServiceOrder => ({
    id: randomUUID(), boss_id: owner.id, boss_name: owner.display_name, boss_game_name: owner.game_name, title, kind,
    target_quantity: kind === 'hourly' ? 60 : 5000000, failure_default_quantity: 0, failure_trigger: 'failed',
    failure_standard_quantity: 0, failure_mode: 'manual', note: '', configuration_locked: false, best_round_quantity: 0,
    completed_quantity: 0, failure_quantity: 0, adjustment_quantity: 0, total_quantity: kind === 'hourly' ? 60 : 5000000,
    remaining_quantity: kind === 'hourly' ? 60 : 5000000, excess_quantity: 0, status: 'active', record_count: 0, created_at: timestamp, updated_at: timestamp,
  });
  const hourly = order(firstBoss, '仅时长手工订单', 'hourly');
  const escort = order(firstBoss, '甲护航订单', 'escort');
  const single = order(secondBoss, '乙单局订单', 'single_round');
  const record: MatchRecord = {
    id: randomUUID(), order_id: single.id, boss_id: secondBoss.id, boss_player_name: secondBoss.game_name,
    original_name: 'screenshot.png', image_content_type: 'image/png', image_sha256: 'a'.repeat(64), image_width: 1, image_height: 1,
    image_size: screenshot.length, players: [{ player_name: secondBoss.game_name, outcome: 'success', amount: 1867449, confidence: 0.98 }],
    raw_text: `${secondBoss.game_name} 撤离成功 1,867,449`, warnings: [], ocr_status: 'completed', player_name: secondBoss.game_name,
    outcome: 'success', amount: 1867449, fake_amount: null, net_amount: null, credited_amount: null, failure_extra_amount: 0,
    confirmed: false, played_at: null, note: '', created_at: timestamp, updated_at: timestamp,
  };
  await app.page.evaluate(({ bosses, orders, record, bytes, timestamp }) => {
    const bridge = window.pwtools!;
    const state: ImportFixtureState = { unexpected: [], captureCalls: 0, uploads: [], updates: [] };
    (window as Window & { importFixture?: typeof state }).importFixture = state;
    const preserve = new Set(['windowControl', 'setImportHotkey', 'onCloseRequested', 'onExitRequested', 'onImportRequested', 'appInfo', 'getUpdateState']);
    for (const method of Object.keys(bridge)) {
      if (preserve.has(method)) continue;
      (bridge as unknown as Record<string, unknown>)[method] = async () => {
        state.unexpected.push(method); throw new Error(`未配置的原生测试请求：${method}`);
      };
    }
    const user = { id: '11111111-1111-4111-8111-111111111111', email: 'hotkey-fixture@example.test', created_at: timestamp };
    Object.assign(bridge, {
      health: async () => ({ status: 'ok', database: 'connected' }), me: async () => user, login: async () => user,
      listBosses: async () => ({ items: bosses }), getBoss: async (id: string) => bosses.find(item => item.id === id)!,
      listOrders: async (id?: string) => ({ items: id ? orders.filter(item => item.boss_id === id) : orders }),
      getOrder: async (id: string) => orders.find(item => item.id === id)!,
      listLedgerEntries: async () => ({ items: [], total: 0, page: 1, page_size: 8 }),
      listMatches: async () => ({ items: [], total: 0, page: 1, page_size: 8 }),
      captureScreen: async () => { state.captureCalls++; await bridge.windowControl('restore'); return { name: 'screenshot.png', content_type: 'image/png', data: new Uint8Array(bytes) }; },
      uploadMatch: async (input: MatchUploadInput) => { state.uploads.push({ name: input.name, order_id: input.order_id, data: Array.from(input.data) }); return { record, duplicate: false }; },
      matchImage: async () => ({ content_type: 'image/png', data: new Uint8Array(bytes) }),
      updateMatch: async (id: string, input: MatchUpdateInput) => { state.updates.push({ id, input }); return { ...record, ...input }; },
    } satisfies Partial<DesktopBridge>);
  }, { bosses: [firstBoss, secondBoss], orders: [hourly, escort, single], record, bytes: Array.from(screenshot), timestamp });
  return { firstBoss, secondBoss, hourly, escort, single, record };
}

async function fixtureState(app: NativeApplication) {
  return app.page.evaluate(() => (window as Window & { importFixture?: ImportFixtureState }).importFixture!);
}

test('自定义快捷键持久化，后台截图后选择订单并只上传一次截图', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    let page = app.page;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    let fixture = await installImportFixture(app);
    await page.getByLabel(/^邮箱/).fill('hotkey-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Isolated-hotkey-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
    const input = page.getByLabel('导入战绩快捷键', { exact: true });
    await input.press('Control+Alt+Shift+F9');
    await expect(input).toHaveValue('Ctrl + Alt + Shift + F9');
    await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
    await expect(page.getByText('当前：Ctrl + Alt + Shift + F9', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pwtools:import-hotkey')!))).toEqual(PRIMARY);
    const settingsImage = testInfo.outputPath('hotkey-settings-native.png');
    await page.screenshot({ path: settingsImage, animations: 'disabled' });
    await testInfo.attach('native-shortcut-settings', { path: settingsImage, contentType: 'image/png' });
    await app.close();
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    page = app.page;
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    fixture = await installImportFixture(app);
    await page.getByLabel(/^邮箱/).fill('hotkey-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Isolated-hotkey-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pwtools:import-hotkey')!))).toEqual(PRIMARY);
    await expect(page.getByRole('row', { name: `${fixture.firstBoss.display_name}老板汇总`, exact: true })).toBeVisible();
    await captureImports(app);
    await app.page.evaluate(() => window.pwtools!.windowControl('minimize'));
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(true);
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(() => importCount(app!)).toBe(1);
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    const picker = page.getByRole('dialog', { name: '导入战绩', exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('img', { name: '待导入战绩截图', exact: true })).toHaveJSProperty('naturalWidth', 1);
    expect((await fixtureState(app)).captureCalls).toBe(1);
    expect((await fixtureState(app)).uploads).toEqual([]);
    await picker.getByLabel('目标订单', { exact: true }).click();
    await expect(page.getByRole('option', { name: /仅时长手工订单/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: `${fixture.firstBoss.display_name} / ${fixture.escort.title} · 护航单`, exact: true })).toBeVisible();
    await page.getByRole('option', { name: `${fixture.secondBoss.display_name} / ${fixture.single.title} · 单局单`, exact: true }).click();
    await picker.getByRole('button', { name: '继续导入', exact: true }).click();
    const round = page.getByRole('dialog', { name: '记一场', exact: true });
    await expect(round).toBeVisible();
    await expect(round.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
    await expect(round.getByRole('img', { name: '本场原始战绩截图', exact: true })).toHaveJSProperty('naturalWidth', 1);
    const importedImage = testInfo.outputPath('hotkey-order-import-native.png');
    await page.screenshot({ path: importedImage, animations: 'disabled' });
    await testInfo.attach('native-shortcut-order-import', { path: importedImage, contentType: 'image/png' });
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect(round).toBeVisible();
    await expect(picker).toHaveCount(0);
    const uploaded = await fixtureState(app);
    expect(uploaded.captureCalls).toBe(1);
    expect(uploaded.uploads).toEqual([{ name: 'screenshot.png', order_id: fixture.single.id, data: Array.from(screenshot) }]);
    expect(uploaded.updates).toEqual([]);
    await round.getByRole('button', { name: '无假账，填 0', exact: true }).click();
    await round.getByRole('button', { name: '确认入账', exact: true }).click();
    await expect(round).toHaveCount(0);
    const saved = await fixtureState(app);
    expect(saved.updates).toHaveLength(1);
    expect(saved.updates[0]).toMatchObject({ id: fixture.record.id, input: { order_id: fixture.single.id, confirmed: true, amount: 1867449, fake_amount: 0 } });
    expect(saved.unexpected).toEqual([]);
    await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '清除快捷键', exact: true }).click();
    await expect(page.getByText('当前：已禁用', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pwtools:import-hotkey'))).toBe('null');
    await app.close();
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    page = app.page;
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await installImportFixture(app);
    await page.getByLabel(/^邮箱/).fill('hotkey-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Isolated-hotkey-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByText('当前：已禁用', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '清除快捷键', exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
    await testInfo.attach('hotkey-order-import', { body: JSON.stringify({ shortcut: PRIMARY, selectedOrderId: fixture.single.id, requests: saved, errors }), contentType: 'application/json' });
  } finally {
    if (app && !app.page.isClosed()) {
      const diagnostic = { events: await importCount(app).catch(() => undefined), state: await fixtureState(app).catch(() => undefined), window: await app.windowState().catch(() => undefined) };
      await testInfo.attach('shortcut-import-final-state', { body: JSON.stringify(diagnostic), contentType: 'application/json' }).catch(() => {});
    }
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('截图快捷键保护已有草稿，取消截图不打开导入且识别中不会重复截图或上传', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    const page = app.page;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const fixture = await installImportFixture(app);
    await page.evaluate(({ record, order }) => {
      const state = (window as Window & { importFixture?: ImportFixtureState }).importFixture!;
      window.pwtools!.captureScreen = async () => { state.captureCalls++; return null; };
      window.pwtools!.uploadMatch = (input: MatchUploadInput) => {
        state.uploads.push({ name: input.name, order_id: input.order_id, data: Array.from(input.data) });
        return new Promise(resolveUpload => {
          (window as Window & { releaseHotkeyUpload?: () => void }).releaseHotkeyUpload = () => resolveUpload({ record: { ...record, order_id: order.id, boss_id: order.boss_id, boss_player_name: order.boss_game_name, player_name: order.boss_game_name }, duplicate: false });
        });
      };
    }, { record: fixture.record, order: fixture.escort });
    await page.getByLabel(/^邮箱/).fill('hotkey-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Isolated-hotkey-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await nativeCommand(page, 'setImportHotkey', [PRIMARY]);
    await page.getByRole('button', { name: '添加老板', exact: true }).click();
    const draft = page.getByRole('dialog', { name: '添加老板', exact: true });
    await draft.getByLabel(/^老板称呼/).fill('不能被快捷键覆盖的草稿');
    await app.notifyRegisteredHotkey(PRIMARY);
    const guard = page.getByRole('dialog', { name: '尚有未保存修改', exact: true });
    await expect(guard).toBeVisible();
    expect((await fixtureState(app)).captureCalls).toBe(0);
    await guard.getByRole('button', { name: '继续填写', exact: true }).click();
    await expect(draft.getByLabel(/^老板称呼/)).toHaveValue('不能被快捷键覆盖的草稿');
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: '放弃修改并切换', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '导入战绩', exact: true });
    await expect.poll(async () => (await fixtureState(app!)).captureCalls).toBe(1);
    await expect(picker).toHaveCount(0);
    await expect(draft.getByLabel(/^老板称呼/)).toHaveValue('不能被快捷键覆盖的草稿');
    expect((await fixtureState(app)).uploads).toEqual([]);
    await page.evaluate(bytes => {
      const bridge = window.pwtools!;
      const state = (window as Window & { importFixture?: ImportFixtureState }).importFixture!;
      bridge.captureScreen = async () => {
        state.captureCalls++;
        await bridge.windowControl('restore');
        return { name: 'screenshot.png', content_type: 'image/png', data: new Uint8Array(bytes) };
      };
    }, Array.from(screenshot));
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: '放弃修改并切换', exact: true }).click();
    await expect(picker).toBeVisible();
    await expect(draft).toHaveCount(0);
    await expect(picker.getByRole('img', { name: '待导入战绩截图', exact: true })).toHaveJSProperty('naturalWidth', 1);
    expect((await fixtureState(app)).uploads).toEqual([]);
    await picker.getByLabel('目标订单', { exact: true }).click();
    await page.getByRole('option', { name: `${fixture.firstBoss.display_name} / ${fixture.escort.title} · 护航单`, exact: true }).click();
    await picker.getByRole('button', { name: '继续导入', exact: true }).click();
    const round = page.getByRole('dialog', { name: '记一场', exact: true });
    await expect(round).toBeVisible();
    await expect.poll(async () => (await fixtureState(app!)).uploads.length).toBe(1);
    await expect(round.getByRole('button', { name: '确认入账', exact: true })).toBeDisabled();
    await expect(round.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect(picker).toHaveCount(0);
    expect((await fixtureState(app)).uploads).toEqual([{ name: 'screenshot.png', order_id: fixture.escort.id, data: Array.from(screenshot) }]);
    expect((await fixtureState(app)).captureCalls).toBe(2);
    await page.evaluate(() => (window as Window & { releaseHotkeyUpload?: () => void }).releaseHotkeyUpload!());
    await expect(round.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
    await expect(round.getByLabel(/^带出金额/)).toBeEnabled();
    expect((await fixtureState(app)).unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await nativeCommand(page, 'setImportHotkey', [null]);
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('截图等待期间重复快捷键不会重拍，取消后可重试且截图错误会恢复提示', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    const page = app.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await installImportFixture(app);
    await page.evaluate(() => {
      const state = (window as Window & { importFixture?: ImportFixtureState }).importFixture!;
      window.pwtools!.captureScreen = () => {
        state.captureCalls++;
        return new Promise(resolveCapture => {
          (window as Window & { cancelPendingCapture?: () => void }).cancelPendingCapture = () => resolveCapture(null);
        });
      };
    });
    await page.getByLabel(/^邮箱/).fill('hotkey-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Isolated-hotkey-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await nativeCommand(page, 'setImportHotkey', [PRIMARY]);
    await page.evaluate(() => window.pwtools!.windowControl('minimize'));
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(true);
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(async () => (await fixtureState(app!)).captureCalls).toBe(1);
    await app.notifyRegisteredHotkey(PRIMARY);
    expect((await fixtureState(app)).captureCalls).toBe(1);
    expect((await app.windowState()).iconic).toBe(true);
    await expect(page.getByRole('dialog', { name: '导入战绩', exact: true })).toHaveCount(0);
    expect((await fixtureState(app)).uploads).toEqual([]);
    await page.evaluate(() => (window as Window & { cancelPendingCapture?: () => void }).cancelPendingCapture!());
    await expect(page.getByRole('dialog', { name: '导入战绩', exact: true })).toHaveCount(0);
    expect((await app.windowState()).iconic).toBe(true);
    await page.evaluate(() => {
      const state = (window as Window & { importFixture?: ImportFixtureState }).importFixture!;
      window.pwtools!.captureScreen = async () => { state.captureCalls++; throw { code: 'CAPTURE_FAILED', message: '隔离测试截图失败' }; };
    });
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(async () => (await fixtureState(app!)).captureCalls).toBe(2);
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    await expect(page.getByText('截图未完成', { exact: true })).toBeVisible();
    await expect(page.getByText('隔离测试截图失败', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '导入战绩', exact: true })).toHaveCount(0);
    expect((await fixtureState(app)).uploads).toEqual([]);
    expect((await fixtureState(app)).unexpected).toEqual([]);
  } finally {
    if (app && !app.page.isClosed()) await app.page.evaluate(() => (window as Window & { cancelPendingCapture?: () => void }).cancelPendingCapture?.()).catch(() => {});
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('刚登录且订单尚未载入时，快捷键通知仍打开导入并等待订单', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await nativeCommand(app.page, 'setImportHotkey', [PRIMARY]);
    await app.page.evaluate(value => localStorage.setItem('pwtools:import-hotkey', JSON.stringify(value)), PRIMARY);
    await app.close();
    app = await NativeApplication.launch(directory, UNREACHABLE_API);
    const page = app.page;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const fixture = await installImportFixture(app);
    await captureImports(app);
    await page.evaluate(() => {
      const bridge = window.pwtools!;
      const listBosses = bridge.listBosses;
      const listOrders = bridge.listOrders;
      const state = { bossReads: 0, orderReads: 0, released: false };
      (window as Window & { delayedImportLists?: typeof state }).delayedImportLists = state;
      let release!: () => void;
      const gate = new Promise<void>(resolveGate => { release = resolveGate; });
      (window as Window & { releaseImportLists?: () => void }).releaseImportLists = () => { state.released = true; release(); };
      bridge.listBosses = async (search?: string) => { state.bossReads++; await gate; return listBosses(search); };
      bridge.listOrders = async (bossId?: string) => { state.orderReads++; await gate; return listOrders(bossId); };
      const notices: string[] = [];
      (window as Window & { importNotifications?: string[] }).importNotifications = notices;
      new MutationObserver(() => {
        for (const element of document.querySelectorAll('.mantine-Notification-root')) {
          const text = element.textContent?.trim();
          if (text && !notices.includes(text)) notices.push(text);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByLabel(/^邮箱/).fill('hotkey-fixture@example.test');
    await page.getByLabel(/^密码/).fill('Isolated-hotkey-password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    // The account is signed in, while both real UI list promises remain blocked.
    await app.notifyRegisteredHotkey(PRIMARY);
    await expect.poll(() => importCount(app!)).toBe(1);
    const picker = page.getByRole('dialog', { name: '导入战绩', exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.getByText('读取订单…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('hotkey-fixture@example.test');
    expect((await fixtureState(app)).captureCalls).toBe(1);
    const delayed = await page.evaluate(() => (window as Window & { delayedImportLists?: { bossReads: number; orderReads: number; released: boolean } }).delayedImportLists!);
    expect(delayed.released).toBe(false);
    expect(delayed.orderReads).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => (window as Window & { releaseImportLists?: () => void }).releaseImportLists!());
    await picker.getByLabel('目标订单', { exact: true }).click();
    await page.getByRole('option', { name: `${fixture.secondBoss.display_name} / ${fixture.single.title} · 单局单`, exact: true }).click();
    await picker.getByRole('button', { name: '继续导入', exact: true }).click();
    const round = page.getByRole('dialog', { name: '记一场', exact: true });
    await expect(round.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
    const saved = await fixtureState(app);
    expect(saved.uploads).toEqual([{ name: 'screenshot.png', order_id: fixture.single.id, data: Array.from(screenshot) }]);
    expect(saved.unexpected).toEqual([]);
    expect(errors).toEqual([]);
    const evidencePath = testInfo.outputPath('first-login-hotkey-pending-lists.json');
    await writeFile(evidencePath, JSON.stringify({ events: await importCount(app), delayed, requests: saved, errors, notifications: await page.evaluate(() => (window as Window & { importNotifications?: string[] }).importNotifications) }, null, 2));
    await testInfo.attach('first-login-hotkey-pending-lists', { path: evidencePath, contentType: 'application/json' });
  } finally {
    if (app && !app.page.isClosed()) {
      await app.page.evaluate(() => (window as Window & { releaseImportLists?: () => void }).releaseImportLists?.()).catch(() => {});
      const diagnostic = { events: await importCount(app).catch(() => undefined), state: await fixtureState(app).catch(() => undefined), notifications: await app.page.locator('.mantine-Notification-root').allTextContents().catch(() => []), window: await app.windowState().catch(() => undefined) };
      await testInfo.attach('first-login-shortcut-final-state', { body: JSON.stringify(diagnostic), contentType: 'application/json' }).catch(() => {});
    }
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});
