import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Boss, MatchRecord, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { openRound, orderArticle } from './ledger-helpers';

const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqucAAAAASUVORK5CYII=', 'base64');
const timestamp = '2026-10-04T02:00:00Z';

async function openClipboardLedger(page: Page, options: { failUploadOnce?: boolean } = {}) {
  const accountId = randomUUID();
  const bossId = randomUUID();
  const orderId = randomUUID();
  const boss: Boss = {
    id: bossId, display_name: '粘贴截图老板', game_id: 'clipboard-boss', game_name: '粘贴截图昵称', notes: '',
    active_order_count: 1, remaining_minutes: 0, remaining_amount: 5000000,
    pending_single_round_count: 0, created_at: timestamp, updated_at: timestamp,
  };
  const order: ServiceOrder = {
    id: orderId, boss_id: bossId, boss_name: boss.display_name, boss_game_name: boss.game_name,
    title: '粘贴截图护航单', kind: 'escort', target_quantity: 5000000, failure_default_quantity: 0,
    failure_trigger: 'failed', failure_standard_quantity: 0, failure_mode: 'manual',
    note: '', configuration_locked: false, best_round_quantity: 0,
    completed_quantity: 0, failure_quantity: 0, adjustment_quantity: 0, total_quantity: 5000000,
    remaining_quantity: 5000000, excess_quantity: 0, status: 'active', record_count: 0,
    created_at: timestamp, updated_at: timestamp,
  };
  const record: MatchRecord = {
    id: randomUUID(), order_id: orderId, boss_id: bossId, boss_player_name: boss.game_name,
    original_name: '粘贴战绩.png', image_content_type: 'image/png', image_sha256: 'a'.repeat(64),
    image_width: 1, image_height: 1, image_size: screenshot.length,
    players: [{ player_name: boss.game_name, amount: 1867449, outcome: 'success', confidence: 0.98 }],
    raw_text: `${boss.game_name} 撤离成功 1,867,449`, warnings: [], ocr_status: 'completed',
    player_name: boss.game_name, outcome: 'success', amount: 1867449, fake_amount: null,
    net_amount: null, credited_amount: null, failure_extra_amount: 0,
    confirmed: false, played_at: null, note: '', created_at: timestamp, updated_at: timestamp,
  };
  const errors: string[] = [];
  const unexpectedRequests: string[] = [];
  const uploads: { data: Buffer | null; contentType: string; orderId: string; name: string }[] = [];
  let releaseUpload = () => {};
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  let uploadRequested = () => {};
  const requested = new Promise<void>(resolve => { uploadRequested = resolve; });
  let uploaded = false;
  let imageRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const fulfill = (json: unknown) => route.fulfill({ json, headers });
    if (pathname === '/api/health') return fulfill({ status: 'ok', database: 'connected' });
    if (pathname === '/api/auth/login') return fulfill({
      token: `mock-clipboard-${accountId}`, user: { id: accountId, email: 'clipboard@example.test', created_at: timestamp },
    });
    if (pathname === '/api/bosses') return fulfill({ items: [boss] });
    if (pathname === `/api/bosses/${bossId}`) return fulfill(boss);
    if (pathname === '/api/orders') return fulfill({ items: [order] });
    if (pathname === `/api/orders/${orderId}`) return fulfill(order);
    if (pathname === `/api/orders/${orderId}/entries`) return fulfill({ items: [], total: 0, page: 1, page_size: 8 });
    if (pathname === '/api/matches' && request.method() === 'GET') {
      const items = uploaded ? [record] : [];
      return fulfill({ items, total: items.length, page: 1, page_size: 8 });
    }
    if (pathname === '/api/matches' && request.method() === 'POST') {
      const sentHeaders = request.headers();
      uploads.push({ data: request.postDataBuffer(), contentType: sentHeaders['content-type'],
        orderId: sentHeaders['x-order-id'], name: decodeURIComponent(sentHeaders['x-file-name']) });
      uploadRequested();
      await uploadGate;
      if (options.failUploadOnce && uploads.length === 1) return route.fulfill({
        status: 503, headers, json: { error: { code: 'HTTP_503', message: '上传暂时中断，请重试同一张截图。' } },
      });
      uploaded = true;
      return fulfill({ record, duplicate: false });
    }
    if (pathname === `/api/matches/${record.id}/image`) {
      imageRequests += 1;
      return route.fulfill({ headers, contentType: 'image/png', body: screenshot });
    }
    if (pathname === `/api/matches/${record.id}`) return fulfill(record);
    unexpectedRequests.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 500, headers, json: { error: { code: 'UNEXPECTED_REQUEST', message: '未配置的测试请求' } } });
  });
  await page.goto('/');
  await page.getByLabel(/^邮箱/).fill('clipboard@example.test');
  await page.getByLabel(/^密码/).fill('Clipboard-test-2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '查看粘贴截图老板订单', exact: true }).click();
  await expect(orderArticle(page, order.title)).toBeVisible();
  return { order, record, uploads, requested, releaseUpload, errors, unexpectedRequests, imageRequests: () => imageRequests };
}

async function pasteScreenshot(target: Locator, name = '粘贴战绩.png', repetitions = 1, bytes = screenshot) {
  return target.evaluate((element, input) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(input.bytes)], input.name, { type: 'image/png' }));
    const results: boolean[] = [];
    for (let index = 0; index < input.repetitions; index += 1) {
      const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      results.push(event.defaultPrevented);
    }
    return results;
  }, { bytes: Array.from(bytes), name, repetitions });
}

async function finishBrowserTasks(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('粘贴原图上传并沿用识别和预览，上传期间及已有原图时不会重复创建场次', async ({ page }) => {
  const ledger = await openClipboardLedger(page);
  const dialog = await openRound(page, ledger.order.title, false);
  await expect(dialog.getByRole('radio', { name: '截图录入', exact: true })).toBeChecked();
  await expect(dialog.getByText('也可 Ctrl+V 粘贴截图', { exact: true })).toBeVisible();
  const uploadArea = dialog.getByLabel('截图上传区域', { exact: true });
  await uploadArea.focus();
  await expect(uploadArea).toBeFocused();
  try {
    await pasteScreenshot(uploadArea, '粘贴战绩.png', 2);
    await ledger.requested;
    await expect(dialog.getByRole('status')).toContainText('识别中');
    expect(ledger.uploads).toHaveLength(1);
    expect(ledger.uploads[0]).toEqual({ data: screenshot, contentType: 'image/png', orderId: ledger.order.id, name: '粘贴战绩.png' });
    await pasteScreenshot(dialog, '上传期间的另一张.png');
    await dialog.getByLabel(/^假账扣除/).fill('100000');
    await finishBrowserTasks(page);
    expect(ledger.uploads).toHaveLength(1);
    ledger.releaseUpload();
    await expect(dialog.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
    await expect(dialog.getByRole('combobox', { name: '撤离结果', exact: true })).toHaveValue('撤离成功');
    await expect(dialog.getByLabel(/^假账扣除/)).toHaveValue('100,000');
    await expect(dialog.getByRole('region', { name: '本场净值', exact: true }).locator('strong').last()).toHaveText('1,767,449');
    await expect(dialog.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
    const preview = dialog.getByRole('img', { name: '本场原始战绩截图', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveJSProperty('naturalWidth', 1);
    await expect(dialog.getByText('粘贴战绩.png · 草稿', { exact: true })).toBeVisible();
    expect(ledger.imageRequests()).toBe(1);
    const originalPreview = await preview.getAttribute('src');
    await pasteScreenshot(dialog.getByRole('region', { name: '本场原图', exact: true }), '试图替换的原图.png');
    await finishBrowserTasks(page);
    expect(ledger.uploads).toHaveLength(1);
    expect(ledger.imageRequests()).toBe(1);
    await expect(preview).toHaveAttribute('src', originalPreview!);
    await expect(dialog.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
    await expect(dialog.getByText('粘贴战绩.png · 草稿', { exact: true })).toBeVisible();
    expect(ledger.errors).toEqual([]);
    expect(ledger.unexpectedRequests).toEqual([]);
  } finally { ledger.releaseUpload(); }
});

test('普通文字粘贴及手工填写时的图片粘贴不触发截图上传', async ({ page }) => {
  const ledger = await openClipboardLedger(page);
  const dialog = await openRound(page, ledger.order.title, false);
  const prevented = await dialog.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '普通文字备注');
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await finishBrowserTasks(page);
  expect(ledger.uploads).toHaveLength(0);
  await expect(dialog.getByText('上传截图', { exact: true })).toBeVisible();
  await dialog.getByText('手工填写', { exact: true }).click();
  expect(await pasteScreenshot(dialog)).toEqual([false]);
  await finishBrowserTasks(page);
  expect(ledger.uploads).toHaveLength(0);
  await expect(dialog.getByLabel(/^带出金额/)).toHaveValue('');
  expect(ledger.errors).toEqual([]);
  expect(ledger.unexpectedRequests).toEqual([]);
});

test('粘贴上传结果不确定时拒绝更换图片，并用首次原图重试识别', async ({ page }) => {
  const ledger = await openClipboardLedger(page, { failUploadOnce: true });
  const dialog = await openRound(page, ledger.order.title, false);
  ledger.releaseUpload();
  await pasteScreenshot(dialog.getByLabel('截图上传区域', { exact: true }));
  await expect(dialog.getByText('上传结果待核实', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '重试上传', exact: true })).toBeEnabled();
  await dialog.getByLabel(/^假账扣除/).fill('200000');
  await pasteScreenshot(dialog, '结果未核实时的另一张.png', 1, Buffer.concat([screenshot, Buffer.from('different screenshot')]));
  await finishBrowserTasks(page);
  expect(ledger.uploads).toHaveLength(1);
  await expect(dialog.getByText('上传结果待核实', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(dialog.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
  await expect(dialog.getByRole('combobox', { name: '撤离结果', exact: true })).toHaveValue('撤离成功');
  await expect(dialog.getByLabel(/^假账扣除/)).toHaveValue('200,000');
  await expect(dialog.getByText('上传结果待核实', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('img', { name: '本场原始战绩截图', exact: true })).toHaveJSProperty('naturalWidth', 1);
  expect(ledger.uploads).toHaveLength(2);
  expect(ledger.uploads[0]).toEqual({ data: screenshot, contentType: 'image/png', orderId: ledger.order.id, name: '粘贴战绩.png' });
  expect(ledger.uploads[1]).toEqual(ledger.uploads[0]);
  expect(ledger.errors).toEqual([]);
  expect(ledger.unexpectedRequests).toEqual([]);
});
