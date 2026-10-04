import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { AppInfo, Boss, DesktopBridge, MatchRecord, MatchUploadInput, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { NativeApplication } from './native-helpers';

const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqucAAAAASUVORK5CYII=', 'base64');
const timestamp = '2026-10-04T02:00:00Z';
const directoryPrefix = 'pwtools-native-clipboard-';

test('打包 WebView2 内粘贴截图上传原图并显示识别和预览', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix));
  let app: NativeApplication | undefined;
  try {
    // An isolated profile and unreachable API keep all account and screenshot data local to this test.
    app = await NativeApplication.launch(directory, 'http://127.0.0.1:1/api');
    const page = app.page;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const runtime = await page.evaluate(() => window.pwtools!.appInfo()) as AppInfo & { runtime?: string };
    const expectedVersion = JSON.parse(await readFile(resolve('apps/desktop/package.json'), 'utf8')).version;
    expect(runtime.version).toBe(expectedVersion);
    expect(runtime.runtime).toBe('webview2');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();

    const accountId = randomUUID();
    const bossId = randomUUID();
    const orderId = randomUUID();
    const boss: Boss = {
      id: bossId, display_name: '原生粘贴老板', game_id: 'native-clipboard', game_name: '原生粘贴昵称', notes: '',
      active_order_count: 1, remaining_minutes: 0, remaining_amount: 5000000,
      pending_single_round_count: 0, created_at: timestamp, updated_at: timestamp,
    };
    const order: ServiceOrder = {
      id: orderId, boss_id: bossId, boss_name: boss.display_name, boss_game_name: boss.game_name,
      title: '原生粘贴护航单', kind: 'escort', target_quantity: 5000000, failure_default_quantity: 0,
      failure_trigger: 'failed', failure_standard_quantity: 0, failure_mode: 'manual',

      note: '', configuration_locked: false, best_round_quantity: 0,
      completed_quantity: 0, failure_quantity: 0, adjustment_quantity: 0, total_quantity: 5000000,
      remaining_quantity: 5000000, excess_quantity: 0, status: 'active', record_count: 0,
      created_at: timestamp, updated_at: timestamp,
    };
    const record: MatchRecord = {
      id: randomUUID(), order_id: orderId, boss_id: bossId, boss_player_name: boss.game_name,
      original_name: '原生粘贴战绩.png', image_content_type: 'image/png', image_sha256: 'a'.repeat(64),
      image_width: 1, image_height: 1, image_size: screenshot.length,
      players: [{ player_name: boss.game_name, amount: 1867449, outcome: 'success', confidence: 0.98 }],
      raw_text: `${boss.game_name} 撤离成功 1,867,449`, warnings: [], ocr_status: 'completed',
      player_name: boss.game_name, outcome: 'success', amount: 1867449, fake_amount: null,
      net_amount: null, credited_amount: null, failure_extra_amount: 0,
      confirmed: false, played_at: null, note: '', created_at: timestamp, updated_at: timestamp,
    };
    await page.evaluate(({ accountId, boss, order, record, bytes, runtime, timestamp }) => {
      const bridge = window.pwtools!;
      const state = { unexpected: [] as string[], uploads: [] as {
        name: string; content_type: string; order_id: string | undefined; data: number[];
      }[], images: [] as string[] };
      (window as Window & { clipboardRequests?: typeof state }).clipboardRequests = state;
      for (const method of Object.keys(bridge)) {
        if (method === 'windowControl' || method === 'onCloseRequested') continue;
        (bridge as unknown as Record<string, unknown>)[method] = async () => {
          state.unexpected.push(method);
          throw new Error(`未配置的原生测试请求：${method}`);
        };
      }
      const user = { id: accountId, email: 'native-clipboard@example.test', created_at: timestamp };
      Object.assign(bridge, {
        health: async () => ({ status: 'ok', database: 'connected' }),
        me: async () => user,
        login: async () => user,
        appInfo: async () => runtime,
        listBosses: async () => ({ items: [boss] }),
        getBoss: async () => boss,
        listOrders: async () => ({ items: [order] }),
        getOrder: async () => order,
        listLedgerEntries: async () => ({ items: [], total: 0, page: 1, page_size: 8 }),
        listMatches: async () => ({ items: [], total: 0, page: 1, page_size: 8 }),
        uploadMatch: async (input: MatchUploadInput) => {
          state.uploads.push({ name: input.name, content_type: input.content_type, order_id: input.order_id, data: Array.from(input.data) });
          return { record, duplicate: false };
        },
        matchImage: async (id: string) => {
          state.images.push(id);
          return { content_type: 'image/png', data: new Uint8Array(bytes) };
        },
      } satisfies Partial<DesktopBridge>);
    }, { accountId, boss, order, record, bytes: Array.from(screenshot), runtime, timestamp });
    await page.getByLabel(/^邮箱/).fill('native-clipboard@example.test');
    await page.getByLabel(/^密码/).fill('Native-clipboard-2026!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '查看原生粘贴老板订单', exact: true }).click();
    const article = page.getByRole('article', { name: `${order.title}订单`, exact: true });
    await article.getByRole('button', { name: '记一场', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记一场', exact: true });
    await expect(dialog.getByRole('radio', { name: '截图录入', exact: true })).toBeChecked();
    await expect(dialog.getByText('也可 Ctrl+V 粘贴截图', { exact: true })).toBeVisible();
    const uploadArea = dialog.getByLabel('截图上传区域', { exact: true });
    await uploadArea.focus();
    await expect(uploadArea).toBeFocused();
    const prevented = await uploadArea.evaluate((element, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array(bytes)], '原生粘贴战绩.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, Array.from(screenshot));
    expect(prevented).toBe(true);
    await expect(dialog.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
    await expect(dialog.getByRole('combobox', { name: '撤离结果', exact: true })).toHaveValue('撤离成功');
    await expect(dialog.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('img', { name: '本场原始战绩截图', exact: true })).toHaveJSProperty('naturalWidth', 1);
    await expect(dialog.getByText('原生粘贴战绩.png · 草稿', { exact: true })).toBeVisible();
    const requests = await page.evaluate(() => (window as Window & {
      clipboardRequests?: { unexpected: string[]; uploads: { name: string; content_type: string; order_id?: string; data: number[] }[]; images: string[] };
    }).clipboardRequests);
    expect(requests).toEqual({ unexpected: [], uploads: [{
      name: '原生粘贴战绩.png', content_type: 'image/png', order_id: orderId, data: Array.from(screenshot),
    }], images: [record.id] });
    expect(errors).toEqual([]);
    await testInfo.attach('native-clipboard-result', { body: JSON.stringify({ version: runtime.version,
      runtime: runtime.runtime, pngBytes: screenshot.length, recordId: record.id, requests }), contentType: 'application/json' });
    const screenshotPath = testInfo.outputPath('clipboard-upload-native.png');
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach('native-clipboard-preview', { path: screenshotPath, contentType: 'image/png' });
  } finally {
    await app?.close().catch(() => {});
    const target = resolve(directory).toLowerCase();
    if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith(directoryPrefix)) {
      throw new Error('临时目录范围校验失败，未删除任何目录');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
