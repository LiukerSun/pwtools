import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { AppInfo, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { NativeApplication } from './native-helpers';

const PROFILE_PREFIX = 'pwtools-native-transfer-';
type NativeTransferFixture = { app: NativeApplication; page: Page; errors: string[]; runtime: AppInfo & { runtime?: string } };

function assertTemporaryProfile(directory: string) {
  const target = resolve(directory).toLowerCase();
  if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith(PROFILE_PREFIX)) {
    throw new Error('转单测试临时目录范围校验失败，未删除任何目录');
  }
}

const test = base.extend<{ native: NativeTransferFixture }>({
  native: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
    assertTemporaryProfile(directory);
    let app: NativeApplication | undefined;
    try {
      const apiUrl = (process.env.PWTOOLS_E2E_API_URL || 'http://localhost:8080/api').replace(/\/$/, '');
      // An empty dev URL explicitly exercises the assets shipped beside this executable.
      app = await NativeApplication.launch(directory, apiUrl, { PWTOOLS_DEV_URL: '' });
      const page = app.page;
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
      const runtime = await page.evaluate(() => window.pwtools!.appInfo()) as NativeTransferFixture['runtime'];
      const expectedVersion = JSON.parse(await readFile(resolve('apps/desktop/package.json'), 'utf8')).version;
      expect(runtime).toMatchObject({ version: expectedVersion, apiUrl, persistentSession: true, runtime: 'webview2' });
      expect(await page.evaluate(() => ({
        origin: location.origin,
        nativeMessages: Boolean((window as Window & { chrome?: { webview?: unknown } }).chrome?.webview),
        hasDevelopmentClient: [...document.scripts].some(script => /@vite\/client|localhost:5173/.test(script.src)),
      }))).toEqual({ origin: 'https://pwtools.local', nativeMessages: true, hasDevelopmentClient: false });

      const id = randomUUID();
      await page.getByRole('button', { name: '注册账号', exact: true }).click();
      await page.getByLabel(/^邮箱/).fill(`native-transfer-${id}@example.test`);
      await page.getByLabel(/^密码/).fill(`Test-${id}!`);
      await page.getByLabel(/^确认密码/).fill(`Test-${id}!`);
      await page.getByRole('button', { name: '注册', exact: true }).click();
      await expect(page.getByRole('main', { name: '老板账本', exact: true })).toBeVisible();
      // Hidden WebView2 parents suspend the animation frames needed for real UI
      // interaction. Keep this isolated instance visible, with its hotkey disabled;
      // the test never sends system input or accesses the user's clipboard.
      await page.evaluate(() => window.pwtools!.setImportHotkey(null));
      expect((await app.windowState()).visible).toBe(true);
      await use({ app, page, errors, runtime });
    } finally {
      await app?.close().catch(() => {});
      assertTemporaryProfile(directory);
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  },
});

const article = (page: Page, order: ServiceOrder) => page.getByRole('article', { name: `${order.title}订单`, exact: true });
const current = (page: Page, order: ServiceOrder) => page.evaluate(id => window.pwtools!.getOrder(id), order.id);
const transfer = (order: ServiceOrder) => {
  expect(order.transfer_history?.length).toBeGreaterThan(0);
  return order.transfer_history!.at(-1)!;
};

async function seed(page: Page, kind: 'escort' | 'hourly', title: string) {
  const created = await page.evaluate(async ({ kind, title }) => {
    const bridge = window.pwtools!;
    const boss = await bridge.createBoss({ display_name: `${title}老板`, game_id: '', game_name: `${title}老板`, notes: '安装包转单验收' });
    const account = await bridge.createRentalAccount({ id: crypto.randomUUID(), name: `${title}账号`, note: '' });
    const rental = await bridge.createRentalSession({
      id: crypto.randomUUID(), account_id: account.id, coin_per_yuan: 500000,
      aw_price: 1000, helmet_price: 1000, armor_price: 1000, initial_coins: 10000000,
      deposit_cents: 20000, started_at: new Date(Date.now() - 3600000).toISOString(), note: '',
    });
    const order = await bridge.createOrder(boss.id, {
      title, kind, target_quantity: kind === 'hourly' ? 120 : 1000000,
      failure_default_quantity: 0, failure_mode: 'manual', note: '',
      price_cents: 99800, participant_count: 2, commission_bps: 2000, default_rental_session_id: rental.id,
    });
    if (kind === 'escort') await bridge.addLedgerEntry(order.id, {
      kind: 'failure', quantity: 200000, amount: 0, fake_amount: 0, outcome: 'failed', failure_extra_amount: 200000,
      occurred_at: null, note: '炸单追加，使总约定为一百二十万', idempotency_key: crypto.randomUUID(), rental_session_id: rental.id,
    });
    await bridge.addLedgerEntry(order.id, {
      kind: 'progress', quantity: kind === 'hourly' ? 60 : 600000,
      ...(kind === 'hourly' ? {} : { amount: 600000, fake_amount: 0, outcome: 'success' as const, failure_extra_amount: 0 }),
      occurred_at: null, note: '原生桥真实打单记录', idempotency_key: crypto.randomUUID(), rental_session_id: rental.id,
    });
    return { boss, rental, order: await bridge.getOrder(order.id) };
  }, { kind, title });
  await page.getByRole('button', { name: '刷新老板账本', exact: true }).click();
  await page.getByRole('button', { name: `查看${created.boss.display_name}订单`, exact: true }).click();
  await expect(article(page, created.order)).toBeVisible();
  const analysis = () => page.evaluate(id => window.pwtools!.rentalAnalysis(id), created.rental.id);
  return { ...created, analysis };
}

async function openAction(page: Page, order: ServiceOrder, action: string, dialogName = action) {
  await article(page, order).getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function submit(page: Page, order: ServiceOrder, dialog: Locator, button: string) {
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return current(page, order);
}

test('安装包原生桥：含炸单转出199.60，收款结账后部分退款和免单分开确认现金', async ({ native }, testInfo) => {
  const { app, page, errors, runtime } = native;
  const fixture = await seed(page, 'escort', '安装包未预收转单');
  const { order } = fixture;
  expect(order).toMatchObject({ completed_quantity: 600000, failure_quantity: 200000, total_quantity: 1200000 });
  const form = await openAction(page, order, '转单');
  await expect(form.getByRole('region', { name: '转单金额预览', exact: true })).toContainText('199.60');
  const pending = await submit(page, order, form, '确认转单');
  expect(transfer(pending)).toMatchObject({ original_income_cents: 39920, expected_income_cents: 19960,
    amount_due_cents: 19960, final_income_cents: null, status: 'pending', cash_events: [] });
  expect((await fixture.analysis()).income_cents).toBe(0);
  await expect(page.getByRole('region', { name: '进行中订单', exact: true }).getByRole('article')).toHaveCount(0);

  const settle = await openAction(page, order, '确认结账');
  await settle.getByLabel('实际收到金额（元）').fill('199.60');
  const settled = await submit(page, order, settle, '确认收款并结账');
  expect(transfer(settled)).toMatchObject({ final_income_cents: 19960, status: 'settled' });
  expect(transfer(settled).cash_events).toEqual([expect.objectContaining({ kind: 'settlement', direction: 'receipt', amount_cents: 19960 })]);
  expect((await fixture.analysis()).income_cents).toBe(19960);

  const partial = await openAction(page, order, '部分退款', '转单部分退款');
  await partial.getByLabel('最终保留本人收入（元）').fill('150');
  const reduced = await submit(page, order, partial, '确认退款方案');
  expect(transfer(reduced)).toMatchObject({ final_income_cents: 15000, pending_refund_cents: 4960 });
  expect(transfer(reduced).cash_events).toHaveLength(1);
  expect((await fixture.analysis()).income_cents).toBe(15000);
  const firstRefund = await submit(page, order, await openAction(page, order, '确认退款'), '确认已退款');
  expect(transfer(firstRefund).cash_events.at(-1)).toMatchObject({ kind: 'refund', direction: 'payment', amount_cents: 4960 });

  const waiver = await submit(page, order, await openAction(page, order, '免单', '转单免单'), '确认退款方案');
  expect(transfer(waiver)).toMatchObject({ final_income_cents: 0, pending_refund_cents: 15000 });
  expect(transfer(waiver).cash_events).toHaveLength(2);
  expect((await fixture.analysis()).income_cents).toBe(0);
  const refunded = await submit(page, order, await openAction(page, order, '确认退款'), '确认已退款');
  expect(transfer(refunded)).toMatchObject({ final_income_cents: 0, pending_refund_cents: 0 });
  expect(transfer(refunded).cash_events).toEqual([
    expect.objectContaining({ kind: 'settlement', direction: 'receipt', amount_cents: 19960 }),
    expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 4960 }),
    expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 15000 }),
  ]);
  await expect(article(page, order).getByRole('button', { name: '撤销转单', exact: true })).toHaveCount(0);
  expect((await app.windowState()).visible).toBe(true);
  expect(errors).toEqual([]);
  const report = testInfo.outputPath('native-transfer-receipt.json');
  await writeFile(report, JSON.stringify({ runtime, executable: app.process.spawnfile, orderId: order.id,
    expectedIncomeCents: 19960, cashEvents: transfer(refunded).cash_events, finalIncomeCents: 0, pageErrors: errors }, null, 2));
  await testInfo.attach('native-transfer-receipt', { path: report, contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('native-transfer-receipt.png'), animations: 'disabled' });
});

test('安装包原生桥：预收先退49.60再付下家199.60，本人只计150且重载保留记录', async ({ native }, testInfo) => {
  const { app, page, errors, runtime } = native;
  const fixture = await seed(page, 'hourly', '安装包预收先退后付');
  const { order } = fixture;
  const form = await openAction(page, order, '转单');
  await form.getByRole('switch', { name: /^已预收本人整份款项/ }).check();
  await expect(form.getByRole('region', { name: '转单金额预览', exact: true })).toContainText('待付下家');
  await submit(page, order, form, '确认转单');
  const partial = await openAction(page, order, '部分退款', '转单部分退款');
  await partial.getByLabel('最终保留本人收入（元）').fill('150');
  const reduced = await submit(page, order, partial, '确认退款方案');
  expect(transfer(reduced)).toMatchObject({ amount_due_cents: 19960, agreed_income_cents: 15000,
    final_income_cents: null, pending_refund_cents: 4960, status: 'pending', cash_events: [] });
  const returned = await submit(page, order, await openAction(page, order, '确认退款'), '确认已退款');
  expect(transfer(returned)).toMatchObject({ amount_due_cents: 19960, final_income_cents: null, pending_refund_cents: 0 });
  expect(transfer(returned).cash_events).toEqual([expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 4960 })]);
  const pendingAnalysis = await fixture.analysis();
  expect(pendingAnalysis.income_cents).toBe(0);
  expect(pendingAnalysis.orders).toEqual([expect.objectContaining({ income_status: 'pending', income_cents: null })]);

  const settle = await openAction(page, order, '确认结账');
  await settle.getByLabel('实际付给下家（元）').fill('199.60');
  const settled = await submit(page, order, settle, '确认付款并结账');
  expect(transfer(settled)).toMatchObject({ final_income_cents: 15000, amount_due_cents: 0, status: 'settled' });
  expect(transfer(settled).cash_events).toEqual([
    expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 4960 }),
    expect.objectContaining({ kind: 'settlement', direction: 'payment', amount_cents: 19960 }),
  ]);
  expect((await fixture.analysis()).income_cents).toBe(15000);
  await page.reload();
  await expect(page.getByRole('main', { name: '老板账本', exact: true })).toBeVisible();
  const reloaded = await current(page, order);
  expect(reloaded.transfer_history).toEqual(settled.transfer_history);
  expect((await fixture.analysis()).income_cents).toBe(15000);
  await page.getByRole('button', { name: `查看${fixture.boss.display_name}订单`, exact: true }).click();
  await expect(article(page, order)).toContainText('150.00');
  expect((await app.windowState()).visible).toBe(true);
  expect(errors).toEqual([]);
  const report = testInfo.outputPath('native-transfer-payment.json');
  await writeFile(report, JSON.stringify({ runtime, executable: app.process.spawnfile, orderId: order.id,
    cashEvents: transfer(reloaded).cash_events, finalIncomeCents: 15000, persistedAfterReload: true, pageErrors: errors }, null, 2));
  await testInfo.attach('native-transfer-payment', { path: report, contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('native-transfer-payment.png'), animations: 'disabled' });
});
