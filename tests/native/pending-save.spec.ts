import { expect, test, type Page } from '@playwright/test';
import { NativeApplication } from './native-helpers';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { DesktopBridge, LedgerEntry, LedgerEntryInput } from '../../apps/desktop/src/shared/contracts';

const DIR_PREFIX = 'pwtools-pending-save-';
const LIMITED_MESSAGE = '恢复重试暂时受限，请再次核实。';
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

function safeDataDirectory(directory: string): boolean {
  const target = resolve(directory).toLowerCase();
  const temporaryRoot = resolve(tmpdir()).toLowerCase();
  return target.startsWith(temporaryRoot + sep)
    && target !== resolve('.').toLowerCase()
    && basename(target).startsWith(DIR_PREFIX);
}

async function startPendingProxy(loss: '断开响应' | '无效 JSON 响应') {
  const entryBodies: string[] = [];
  const entryPaths: string[] = [];
  const upstreamStatuses: number[] = [];
  const upstreamEntryIds: string[] = [];
  const failures: string[] = [];

  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const path = request.url || '/';
      if (!path.startsWith('/api/')) { response.writeHead(404); response.end(); return; }
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      const body = Buffer.concat(parts);
      const isEntry = request.method === 'POST' && /^\/api\/orders\/[^/]+\/entries$/.test(path);
      if (isEntry) {
        entryBodies.push(body.toString('utf8'));
        entryPaths.push(path);
        if (entryBodies.length === 2) {
          response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
          response.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: LIMITED_MESSAGE } }));
          return;
        }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (HOP_HEADERS.has(name) || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      const upstreamRoot = (process.env.PWTOOLS_E2E_API_URL || 'http://localhost:8080/api').replace(/\/api\/?$/, '');
      const upstream = await fetch(`${upstreamRoot}${path}`, {
        method: request.method,
        headers,
        ...(body.byteLength ? { body: new Uint8Array(body).buffer } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (isEntry) {
        upstreamStatuses.push(upstream.status);
        const entry: LedgerEntry = JSON.parse(bytes.toString('utf8'));
        upstreamEntryIds.push(entry.id);
        if (entryBodies.length === 1) {
          // The real API response proves commit before the client loses its response.
          if (loss === '断开响应') response.destroy();
          else { response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end('{'); }
          return;
        }
      }
      const outputHeaders: Record<string, string> = {};
      for (const [name, value] of upstream.headers) {
        if (!HOP_HEADERS.has(name) && name !== 'content-encoding') outputHeaders[name] = value;
      }
      response.writeHead(upstream.status, outputHeaders);
      response.end(bytes);
    } catch {
      // Never retain or print forwarded authentication headers or registration bodies.
      failures.push('测试代理未能完成转发');
      response.destroy();
    }
  };
  const server = createServer((request, response) => { void forward(request, response); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('测试代理未监听 TCP 端口'); }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api`,
    entryBodies, entryPaths, upstreamStatuses, upstreamEntryIds, failures,
    close: async () => {
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    },
  };
}

async function clickWindowClose(page: Page) {
  // Invoke the real title-bar close handler even while the recording modal covers it.
  await page.getByRole('button', { name: '关闭窗口', exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
}

for (const loss of ['断开响应', '无效 JSON 响应'] as const) {
test(`原生窗口阻止未决记账退出，${loss}和限流后只记一场`, async () => {
  test.setTimeout(150_000);
  const dataDir = await mkdtemp(join(tmpdir(), DIR_PREFIX));
  if (!safeDataDirectory(dataDir)) throw new Error('测试临时目录范围校验失败');
  let desktop: NativeApplication | undefined;
  let proxy: Awaited<ReturnType<typeof startPendingProxy>> | undefined;
  try {
    proxy = await startPendingProxy(loss);
    desktop = await NativeApplication.launch(dataDir, proxy.apiUrl);
    const page = desktop.page;
    // This suite verifies the exit guard. Explicitly select exit so first-close
    // education and minimize preferences do not change the scenario under test.
    await page.evaluate(() => localStorage.setItem('pwtools:close-behavior', 'exit'));
    await page.reload();
    page.on('dialog', (dialog) => { if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {}); });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
    await page.evaluate(async (id) => {
      const bridge = window.pwtools!;
      await bridge.register({ email: `pending-${id}@example.test`, password: `Test-${id}!` });
    }, randomUUID());
    await page.reload();
    await expect(page.getByRole('main', { name: '老板账本', exact: true })).toBeVisible();
    const seeded = await page.evaluate(async () => {
      const bridge: DesktopBridge = window.pwtools!;
      const boss = await bridge.createBoss({ display_name: '恢复测试老板', game_id: '', game_name: '', notes: '未决结果核实后离开' });
      const order = await bridge.createOrder(boss.id, { title: '待核实陪玩', kind: 'hourly', target_quantity: 60, failure_default_quantity: 0, note: '' });
      return { boss, order };
    });
    await page.getByRole('button', { name: '刷新老板账本', exact: true }).click();
    await page.getByRole('button', { name: '查看恢复测试老板订单', exact: true }).click();
    const article = page.getByRole('article', { name: '待核实陪玩订单', exact: true });
    await article.getByRole('button', { name: '记一场', exact: true }).click();
    const form = page.getByRole('dialog', { name: '记一场', exact: true });
    const minutes = form.getByLabel('本次陪玩时长分钟', { exact: true });
    await minutes.fill('15');

    // A normal unsaved form uses the App guard above the RoundEntry modal.
    await clickWindowClose(page);
    const closeGuard = page.getByRole('dialog', { name: '尚有未保存修改', exact: true });
    await expect(closeGuard).toBeVisible();
    expect(page.isClosed()).toBe(false);
    await closeGuard.getByRole('button', { name: '继续填写', exact: true }).click();
    await expect(closeGuard).toHaveCount(0);
    await expect(minutes).toHaveValue('15');
    await expect(minutes).toBeEnabled();

    await form.getByRole('button', { name: '确认入账', exact: true }).click();
    await expect(form.getByText('本场保存结果待核实', { exact: true })).toBeVisible();
    await expect(minutes).toBeDisabled();
    await expect(form.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    expect(proxy.entryBodies).toHaveLength(1);
    expect(proxy.upstreamStatuses).toEqual([201]);
    const committed = await page.evaluate((id) => window.pwtools!.getOrder(id), seeded.order.id);
    expect(committed.record_count).toBe(1);
    expect(committed.completed_quantity).toBe(15);
    expect(committed.remaining_quantity).toBe(45);

    await clickWindowClose(page);
    await expect(page.getByText('当前操作尚未完成', { exact: true })).toBeVisible();
    expect(page.isClosed()).toBe(false);
    expect(desktop.process.exitCode).toBeNull();
    await expect(closeGuard).toHaveCount(0);
    await expect(minutes).toHaveValue('15');

    const retry = form.getByRole('button', { name: '重试核实本场', exact: true });
    await retry.click();
    await expect(form.getByText(LIMITED_MESSAGE, { exact: true })).toBeVisible();
    await expect(form.getByText('本场保存结果待核实', { exact: true })).toBeVisible();
    expect(proxy.entryBodies).toHaveLength(2);
    expect(proxy.upstreamStatuses).toEqual([201]);
    await expect(minutes).toBeDisabled();
    await expect(form.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    // Exercise the actual WM_CLOSE path used by Alt+F4.
    await desktop.requestNativeClose();
    await expect(page.getByText('当前操作尚未完成', { exact: true }).last()).toBeVisible();
    expect(page.isClosed()).toBe(false);
    expect(desktop.process.exitCode).toBeNull();
    await expect(closeGuard).toHaveCount(0);

    await retry.click();
    await expect(form).toHaveCount(0);
    expect(proxy.entryBodies).toHaveLength(3);
    expect(proxy.entryBodies).toEqual([proxy.entryBodies[0], proxy.entryBodies[0], proxy.entryBodies[0]]);
    expect(proxy.entryPaths).toEqual(Array(3).fill(`/api/orders/${seeded.order.id}/entries`));
    expect(proxy.upstreamStatuses).toEqual([201, 200]);
    expect(proxy.upstreamEntryIds[1]).toBe(proxy.upstreamEntryIds[0]);
    const submitted: LedgerEntryInput = JSON.parse(proxy.entryBodies[0]);
    expect(submitted.kind).toBe('progress');
    expect(submitted.quantity).toBe(15);
    expect(submitted.idempotency_key).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    const verified = await page.evaluate(async (id) => {
      const bridge = window.pwtools!;
      return { order: await bridge.getOrder(id), entries: await bridge.listLedgerEntries(id) };
    }, seeded.order.id);
    expect(verified.order.record_count).toBe(1);
    expect(verified.order.completed_quantity).toBe(15);
    expect(verified.order.remaining_quantity).toBe(45);
    expect(verified.entries.total).toBe(1);
    expect(verified.entries.items).toHaveLength(1);
    expect(verified.entries.items[0].id).toBe(proxy.upstreamEntryIds[0]);
    expect(proxy.failures).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await desktop?.close().catch(() => {});
    await proxy?.close();
    if (!safeDataDirectory(dataDir)) throw new Error('临时目录范围校验失败，未删除任何目录');
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
}
