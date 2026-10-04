import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename, sep } from 'node:path';
import type { DesktopBridge } from '../../apps/desktop/src/shared/contracts';
import { NativeApplication } from './native-helpers';

test('真实截图经过 WebView2 原生二进制桥：OCR、去重、原图与重启持久化', async () => {
  test.skip(!process.env.PWTOOLS_OCR_SAMPLE, '设置 PWTOOLS_OCR_SAMPLE 为本地三角洲样例，不将用户原图提交到仓库');
  test.setTimeout(240_000);
  const source = await readFile(process.env.PWTOOLS_OCR_SAMPLE!);
  const sha = createHash('sha256').update(source).digest('hex');
  const encoded = source.toString('base64');
  const dataDir = await mkdtemp(join(tmpdir(), 'pwtools-native-e2e-'));
  let desktop: NativeApplication | undefined;
  const launch = () => NativeApplication.launch(dataDir);
  try {
    desktop = await launch();
    let page = desktop.page;
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await page.evaluate(async id => {
      await window.pwtools!.register({ email: `native-ocr-${id}@example.test`, password: `Test-${id}!` });
    }, randomUUID());
    // Reload restores the session owned by the native host, without exposing its token.
    await page.reload();
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('button', { name: '战绩记录', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(2);
    const context = await page.evaluate(async () => {
      const bridge: DesktopBridge = window.pwtools!;
      const boss = await bridge.createBoss({ display_name: '团团老板', game_id: 'boss-001', game_name: '团团吃大饼', notes: '先核对原图再记账' });
      const order = await bridge.createOrder(boss.id, { title: '桌面第一笔护航', kind: 'escort', target_quantity: 10000000, failure_default_quantity: 1000000, note: '真实截图测试' });
      return { boss, order };
    });
    await page.getByRole('button', { name: '刷新老板账本', exact: true }).click();
    await page.getByRole('button', { name: '查看团团老板订单', exact: true }).click();
    const article = page.getByRole('article', { name: '桌面第一笔护航订单', exact: true });
    await article.getByRole('button', { name: '记一场', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记一场', exact: true });
    await expect(dialog.getByRole('radio', { name: '截图录入', exact: true })).toBeChecked();
    await dialog.getByLabel('导入本场截图', { exact: true }).setInputFiles(process.env.PWTOOLS_OCR_SAMPLE!);
    await expect(dialog.getByLabel(/^带出金额/)).toHaveValue('3,314,221', { timeout: 90_000 });
    await expect(dialog.getByLabel(/^假账扣除/)).toHaveValue('');
    await dialog.getByLabel(/^假账扣除/).fill('314221');
    await expect(dialog.getByRole('region', { name: '本场净值', exact: true }).locator('strong').last()).toHaveText('3,000,000');
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const savedDraft = await page.evaluate(async orderId => {
      const bridge = window.pwtools!;
      return { list: await bridge.listMatches(1, 20, orderId, false), order: await bridge.getOrder(orderId) };
    }, context.order.id);
    expect(savedDraft.list.items).toHaveLength(1);
    expect(savedDraft.list.items[0].confirmed).toBe(false);
    expect(savedDraft.order.record_count).toBe(0);
    const history = article.getByRole('button', { name: '桌面第一笔护航场次账本', exact: true });
    await history.click();
    await article.getByRole('region', { name: '待确认截图', exact: true }).getByRole('button', { name: '继续填写', exact: true }).click();
    const resumed = page.getByRole('dialog', { name: '校对此场', exact: true });
    await expect(resumed.getByLabel(/^带出金额/)).toHaveValue('3,314,221');
    await expect(resumed.getByLabel(/^假账扣除/)).toHaveValue('314,221');
    await resumed.getByRole('button', { name: '确认入账', exact: true }).click();
    await expect(resumed).toHaveCount(0);
    await expect(article).toContainText('7,000,000 哈夫币');
    const record = await page.evaluate(async orderId => {
      const bridge = window.pwtools!;
      const list = await bridge.listMatches(1, 20, orderId);
      return { record: list.items[0], stats: await bridge.matchStats(orderId), drafts: await bridge.listMatches(1, 20, orderId, false), order: await bridge.getOrder(orderId) };
    }, context.order.id);
    expect(record.record.order_id).toBe(context.order.id);
    expect(record.record.id).toBe(savedDraft.list.items[0].id);
    expect(record.record.player_name).toBe('团团吃大饼');
    expect(record.record.confirmed).toBe(true);
    expect(record.record.image_sha256).toBe(sha);
    expect(record.record.players.map(player => player.amount)).toEqual([3314221, 1867449, 97593]);
    expect(record.record.amount).toBe(3314221);
    expect(record.record.fake_amount).toBe(314221);
    expect(record.record.net_amount).toBe(3000000);
    expect(record.stats.total_amount).toBe(3000000);
    expect(record.stats.confirmed_count).toBe(1);
    expect(record.drafts.items).toHaveLength(0);
    expect(record.order.remaining_quantity).toBe(7000000);
    const duplicate = await page.evaluate(async ({ encoded, orderId }) => {
      return window.pwtools!.uploadMatch({ name: '重复截图.png', content_type: 'image/png', data: Uint8Array.from(atob(encoded), char => char.charCodeAt(0)), order_id: orderId });
    }, { encoded, orderId: context.order.id });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.id).toBe(record.record.id);
    expect(duplicate.record.confirmed).toBe(true);
    expect(duplicate.record.net_amount).toBe(3000000);
    const original = await page.evaluate(async id => {
      const image = await window.pwtools!.matchImage(id);
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(image.data).buffer);
      return { sha: Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join(''), type: image.content_type, size: image.data.byteLength, typedArray: image.data instanceof Uint8Array };
    }, record.record.id);
    expect(original).toEqual({ sha, type: 'image/png', size: source.byteLength, typedArray: true });
    if (await history.getAttribute('aria-expanded') !== 'true') await history.click();
    await article.getByRole('button', { name: '查看此场', exact: true }).click();
    const correction = page.getByRole('dialog', { name: '校对此场', exact: true });
    await expect(correction.getByLabel(/^带出金额/)).toHaveValue('3,314,221');
    await expect(correction.getByLabel(/^假账扣除/)).toHaveValue('314,221');
    await correction.getByRole('button', { name: '放大本场原图', exact: true }).click();
    await expect(page.getByRole('img', { name: '本场原图放大查看', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await correction.getByRole('button', { name: '取消', exact: true }).click();
    await expect(correction).toHaveCount(0);
    await mkdir('.artifacts', { recursive: true });
    await page.screenshot({ path: '.artifacts/matches-native.png', fullPage: true });

    await desktop.close();
    desktop = await launch();
    page = desktop.page;
    await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('button', { name: '战绩记录', exact: true })).toHaveCount(0);
    const restored = await page.evaluate(async ({ orderId, bossId }) => {
      const bridge = window.pwtools!;
      return { boss: await bridge.getBoss(bossId), list: await bridge.listMatches(1, 20, orderId), stats: await bridge.matchStats(orderId), order: await bridge.getOrder(orderId) };
    }, { orderId: context.order.id, bossId: context.boss.id });
    expect(restored.boss.notes).toBe('先核对原图再记账');
    expect(restored.list.items[0].id).toBe(record.record.id);
    expect(restored.stats.total_amount).toBe(3000000);
    expect(restored.order.remaining_quantity).toBe(7000000);
    expect(restored.order.record_count).toBe(1);
    await page.getByRole('button', { name: '查看团团老板订单', exact: true }).click();
    const restoredArticle = page.getByRole('article', { name: '桌面第一笔护航订单', exact: true });
    await restoredArticle.getByRole('button', { name: '桌面第一笔护航场次账本', exact: true }).click();
    await restoredArticle.getByRole('button', { name: '查看此场', exact: true }).click();
    const restoredScene = page.getByRole('dialog', { name: '校对此场', exact: true });
    await expect(restoredScene.getByLabel(/^带出金额/)).toHaveValue('3,314,221');
    await expect(restoredScene.getByLabel(/^假账扣除/)).toHaveValue('314,221');
    await expect(restoredScene.getByRole('img', { name: '本场原始战绩截图', exact: true })).toBeVisible();
    await restoredScene.getByRole('button', { name: '取消', exact: true }).click();
    await expect(restoredScene).toHaveCount(0);
    const unmatched = await page.evaluate(async encoded => {
      const bridge = window.pwtools!;
      const boss = await bridge.createBoss({ display_name: '其他老板', game_id: 'boss-002', game_name: '未出现在截图的老板', notes: '' });
      const order = await bridge.createOrder(boss.id, { title: '未匹配护航', kind: 'escort', target_quantity: 5000000, failure_default_quantity: 0, note: '' });
      const result = await bridge.uploadMatch({ name: '其他老板.png', content_type: 'image/png', data: Uint8Array.from(atob(encoded), char => char.charCodeAt(0)), order_id: order.id });
      return { record: result.record, stats: await bridge.matchStats(order.id), order: await bridge.getOrder(order.id) };
    }, encoded);
    expect(unmatched.record.amount).toBeNull();
    expect(unmatched.record.outcome).toBe('unknown');
    expect(unmatched.record.confirmed).toBe(false);
    expect(unmatched.stats.total_amount).toBe(0);
    expect(unmatched.stats.draft_count).toBe(1);
    expect(unmatched.order.remaining_quantity).toBe(5000000);
  } finally {
    await desktop?.close().catch(() => {});
    const target = resolve(dataDir).toLowerCase();
    if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith('pwtools-native-e2e-')) {
      throw new Error('临时目录范围校验失败，未删除任何目录');
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
