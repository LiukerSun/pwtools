import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { NativeApplication, nativeCommand } from './native-helpers';

test('截图启动耗时及反向框选后确认按钮距离', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pwtools-native-capture-perf-'));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, 'http://127.0.0.1:1/api', { PWTOOLS_E2E_CAPTURE_PATTERN: '1', PWTOOLS_DEV_URL: '' });
    const times: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 1) await app.page.evaluate(() => window.pwtools!.windowControl('hide-to-tray'));
      const started = performance.now();
      const result = nativeCommand(app.page, 'captureScreen', [], 90000); void result.catch(() => {});
      await expect.poll(async () => (await app!.captureState()).shown, { intervals: [20], timeout: 15000 }).toBe(true);
      times.push(performance.now() - started);
      const overlay = await app.capturePage();
      const endpoint = attempt === 0 ? { x: 100, y: 100 } : attempt === 1 ? { x: 900, y: 700 }
        : await overlay.evaluate(() => ({ x: innerWidth - 5, y: innerHeight - 5 }));
      await overlay.mouse.move(attempt === 0 ? 900 : 100, attempt === 0 ? 700 : 100); await overlay.mouse.down();
      await overlay.mouse.move(endpoint.x, endpoint.y, { steps: 8 }); await overlay.mouse.up();
      const confirm = overlay.getByTitle('完成截图', { exact: true });
      await expect(confirm).toBeVisible();
      const bounds = await confirm.boundingBox();
      const distance = Math.hypot(bounds!.x + bounds!.width / 2 - endpoint.x, bounds!.y + bounds!.height / 2 - endpoint.y);
      const toolbar = await overlay.locator('.screenshots-operations').boundingBox();
      const viewport = await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(toolbar!.x).toBeGreaterThanOrEqual(0); expect(toolbar!.y).toBeGreaterThanOrEqual(0);
      expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(viewport.width);
      expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(viewport.height);
      console.log(JSON.stringify({ attempt, startupMs: times.at(-1), confirmDistance: distance }));
      await overlay.keyboard.press('Escape').catch(error => { if (!overlay.isClosed()) throw error; }); await result;
      expect(distance).toBeLessThan(120);
    }
    expect(Math.max(...times)).toBeLessThan(1500);
  } finally {
    await app?.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('pwtools-native-capture-perf-')) throw new Error('截图性能测试目录范围校验失败');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
