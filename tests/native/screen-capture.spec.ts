import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createCapturePatternWindow, nativeCommand, NativeApplication, type NativeCaptureState } from './native-helpers';

const DIRECTORY_PREFIX = 'pwtools-native-capture-';
const UNREACHABLE_API = 'http://127.0.0.1:1/api';
interface CapturedPNG { name: string; content_type: string; data_base64: string }

async function cleanupDirectory(directory: string) {
  const target = resolve(directory).toLowerCase();
  if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith(DIRECTORY_PREFIX)) throw new Error('临时目录范围校验失败，未删除任何目录');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function beginCapture(app: NativeApplication, fromTray = false): Promise<{ result: Promise<CapturedPNG | null>; overlay: Page; state: NativeCaptureState }> {
  const result = nativeCommand(app.page, 'captureScreen', [], 90_000) as Promise<CapturedPNG | null>;
  // Cleanup can close the CDP page before a failed startup reaches its reply.
  // Attach a rejection handler immediately while preserving the result promise.
  void result.catch(() => {});
  try {
    await expect.poll(async () => (await app.captureState()).shown, { timeout: 30_000 }).toBe(true);
  } catch (failure) {
    const state = await app.captureState().catch(() => undefined);
    const pages = await Promise.all(app.browser.contexts().flatMap(context => context.pages()).map(async page => ({ url: page.url(), capture: await page.evaluate(() => ({ state: document.querySelector('.capture-overlay')?.getAttribute('data-capture-state'), visibility: document.visibilityState, alert: document.querySelector('[role="alert"]')?.textContent })).catch(() => undefined) })));
    throw new Error(`${String(failure)}\n截图启动状态: ${JSON.stringify({ state, pages })}`);
  }
  const state = await app.captureState();
  const overlay = await app.capturePage();
  await expect(overlay.locator('[data-capture-state="ready"]')).toBeVisible();
  expect(state.active).toBe(true);
  expect(state.ready).toBe(true);
  // Keep an already hidden tray window hidden throughout capture.
  expect(state.parentWindowVisible).toBe(!fromTray);
  expect(state.parentWindowIconic).toBe(!fromTray);
  expect(await overlay.evaluate(() => window.devicePixelRatio)).toBe(1);
  expect(await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: state.bounds.right - state.bounds.left, height: state.bounds.bottom - state.bounds.top });
  await overlay.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  expect(await overlay.locator('.screenshots').evaluate(element => ({ width: Number.parseFloat((element as HTMLElement).style.width), height: Number.parseFloat((element as HTMLElement).style.height) }))).toEqual({ width: state.bounds.right - state.bounds.left, height: state.bounds.bottom - state.bounds.top });
  return { result, overlay, state };
}

async function selectRegion(overlay: Page, from: { x: number; y: number }, to: { x: number; y: number }, closedCapture?: () => Promise<unknown>) {
  const recorded: unknown[] = [];
  await overlay.exposeFunction('pwtoolsCaptureTestEvent', (event: unknown) => { recorded.push(event); });
  await overlay.evaluate(() => {
    const events: { type: string; x: number; y: number; target: string }[] = [];
    (window as Window & { capturePointerEvents?: typeof events }).capturePointerEvents = events;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dblclick', 'contextmenu', 'keydown', 'blur', 'focus']) window.addEventListener(type, event => {
      const pointer = event as PointerEvent;
      const record = { type, x: pointer.clientX, y: pointer.clientY, target: (pointer.target as HTMLElement | null)?.className || '' };
      events.push(record);
      void (window as Window & { pwtoolsCaptureTestEvent?: (value: typeof record) => Promise<void> }).pwtoolsCaptureTestEvent?.(record).catch(() => {});
    }, { capture: true });
  });
  await overlay.mouse.move(from.x, from.y);
  await overlay.mouse.down();
  await overlay.mouse.move(to.x, to.y, { steps: 8 });
  await overlay.mouse.up();
  try {
    await expect.poll(() => overlay.locator('.screenshots-canvas-panel').evaluate(element => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }))).toEqual({ width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) });
  }
  catch (failure) {
    const diagnostic = await overlay.evaluate(() => ({ canvas: document.querySelector('.screenshots-canvas-panel')?.outerHTML, background: document.querySelector('.screenshots-background')?.getBoundingClientRect().toJSON() })).catch(() => ({ closed: true }));
    const capture = overlay.isClosed() ? await closedCapture?.() : undefined;
    throw new Error(`${String(failure)}\n框选诊断: ${JSON.stringify({ from, to, recorded, diagnostic, capture })}`);
  }
}

async function closingAction(overlay: Page, action: () => Promise<unknown>) {
  try { await action(); } catch (failure) { if (!overlay.isClosed()) throw failure; }
}

async function decodePixels(page: Page, png: CapturedPNG) {
  expect(png.content_type).toBe('image/png');
  return page.evaluate(async value => {
    const data = Uint8Array.from(atob(value.data_base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
    try {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const points = [[0, 0], [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)], [canvas.width - 1, canvas.height - 1]];
      return { width: canvas.width, height: canvas.height, size: data.length, pixels: points.map(([x, y]) => ({ x, y, rgba: Array.from(context.getImageData(x, y, 1, 1).data) })) };
    } finally { URL.revokeObjectURL(url); }
  }, png);
}

test('托盘运行中取消截图保持隐藏，完成截图恢复窗口并移除托盘图标', async () => {
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API, { PWTOOLS_E2E_CAPTURE_PATTERN: '1' });
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await app.page.evaluate(() => window.pwtools!.windowControl('maximize'));
    await expect.poll(async () => (await app!.windowState()).maximized).toBe(true);
    const before = await app.windowState();
    await app.page.evaluate(() => window.pwtools!.windowControl('hide-to-tray'));
    await expect.poll(async () => (await app!.windowState()).visible).toBe(false);
    expect((await app.windowState()).trayIconRegistered).toBe(true);

    const canceled = await beginCapture(app, true);
    expect((await app.windowState()).trayIconRegistered).toBe(true);
    await closingAction(canceled.overlay, () => canceled.overlay.keyboard.press('Escape'));
    expect(await canceled.result).toBeNull();
    expect((await app.windowState()).visible).toBe(false);
    expect((await app.windowState()).trayIconRegistered).toBe(true);

    const completed = await beginCapture(app, true);
    await selectRegion(completed.overlay, { x: 80, y: 96 }, { x: 208, y: 176 });
    await closingAction(completed.overlay, () => completed.overlay.getByTitle('完成截图', { exact: true }).click());
    expect(await completed.result).not.toBeNull();
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    const restored = await app.windowState();
    expect(restored.trayIconRegistered).toBe(false);
    expect(restored.maximized).toBe(true);
    expect({ left: restored.left, top: restored.top, width: restored.width, height: restored.height }).toEqual({ left: before.left, top: before.top, width: before.width, height: before.height });
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('截图前最小化主窗口保留任务栏入口，前台 Esc 和后台右键取消均保留原窗口状态', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API, { PWTOOLS_E2E_CAPTURE_PATTERN: '1' });
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await app.page.evaluate(() => window.pwtools!.windowControl('maximize'));
    await expect.poll(async () => (await app!.windowState()).maximized).toBe(true);
    const before = await app.windowState();
    const foreground = await beginCapture(app);
    expect(foreground.state.pattern).toBe(true);
    expect(foreground.state.originalIconic).toBe(false);
    await closingAction(foreground.overlay, () => foreground.overlay.keyboard.press('Escape'));
    expect(await foreground.result).toBeNull();
    await expect.poll(async () => (await app!.windowState()).visible).toBe(true);
    const canceled = await app.windowState();
    expect(canceled.iconic).toBe(false);
    expect(canceled.maximized).toBe(true);
    expect({ left: canceled.left, top: canceled.top, width: canceled.width, height: canceled.height }).toEqual({ left: before.left, top: before.top, width: before.width, height: before.height });
    await app.page.evaluate(() => window.pwtools!.windowControl('minimize'));
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(true);
    const background = await beginCapture(app);
    expect(background.state.pattern).toBe(true);
    expect(background.state.originalIconic).toBe(true);
    await closingAction(background.overlay, () => background.overlay.mouse.click(80, 80, { button: 'right' }));
    expect(await background.result).toBeNull();
    const backgroundCanceled = await app.windowState();
    expect(backgroundCanceled.visible).toBe(true);
    expect(backgroundCanceled.iconic).toBe(true);
    await testInfo.attach('synthetic-source-cancel-states', { body: JSON.stringify({ source: 'debug synthetic pattern, no desktop read', before, foreground: foreground.state, canceled, background: background.state, backgroundCanceled }), contentType: 'application/json' });
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('react-screenshots 正向反向和桌面边界框选输出合成区域 PNG，成功恢复主窗口', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API, { PWTOOLS_E2E_CAPTURE_PATTERN: '1' });
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const evidence: unknown[] = [];
    const cases = [
      { from: { x: 80, y: 96 }, to: { x: 208, y: 176 } },
      { from: { x: 320, y: 240 }, to: { x: 128, y: 112 } },
      { from: { x: 0, y: 0 }, to: { x: 64, y: 48 } },
    ];
    for (const region of cases) {
      await app.page.evaluate(() => window.pwtools!.windowControl('minimize'));
      await expect.poll(async () => (await app!.windowState()).iconic).toBe(true);
      const capture = await beginCapture(app);
      expect(capture.state.pattern).toBe(true);
      await selectRegion(capture.overlay, region.from, region.to, async () => ({ result: await capture.result === null ? 'null' : 'PNG', native: await app!.captureState() }));
      if (evidence.length === 0) await capture.overlay.screenshot({ path: testInfo.outputPath('synthetic-overlay.png'), animations: 'disabled' });
      await closingAction(capture.overlay, () => capture.overlay.getByTitle('完成截图', { exact: true }).click());
      const png = await capture.result;
      expect(png).not.toBeNull();
      const decoded = await decodePixels(app.page, png!);
      const left = Math.min(region.from.x, region.to.x), top = Math.min(region.from.y, region.to.y);
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: Math.abs(region.to.x - region.from.x), height: Math.abs(region.to.y - region.from.y) });
      for (const point of decoded.pixels) expect(point.rgba).toEqual([48, Math.floor((left + point.x) / 16) % 200 + 20, Math.floor((top + point.y) / 16) % 200 + 20, 255]);
      await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
      expect((await app.windowState()).visible).toBe(true);
      evidence.push({ region, capture: capture.state, decoded });
      await expect.poll(() => capture.overlay.isClosed()).toBe(true);
    }
    const cancel = await beginCapture(app);
    await selectRegion(cancel.overlay, { x: 80, y: 96 }, { x: 208, y: 176 });
    await closingAction(cancel.overlay, () => cancel.overlay.getByTitle('取消截图', { exact: true }).click());
    expect(await cancel.result).toBeNull();
    await testInfo.attach('synthetic-source-region-pixels', { body: JSON.stringify({ source: 'debug synthetic pattern, no desktop read', cases: evidence }), contentType: 'application/json' });
  } finally {
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});

test('真实 GDI 截图只导出独立不透明测试窗口内部的区域像素', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  let app: NativeApplication | undefined;
  let pattern: Awaited<ReturnType<typeof createCapturePatternWindow>> | undefined;
  try {
    app = await NativeApplication.launch(directory, UNREACHABLE_API, { PWTOOLS_E2E_CAPTURE_PATTERN: '0' });
    await expect(app.page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await app.page.evaluate(() => window.pwtools!.windowControl('minimize'));
    pattern = await createCapturePatternWindow();
    const fixturePath = testInfo.outputPath('owned-pattern-window-state.json');
    await writeFile(fixturePath, JSON.stringify(pattern.diagnostic, null, 2));
    await testInfo.attach('owned-pattern-window-state', { path: fixturePath, contentType: 'application/json' });
    expect(pattern.diagnostic.visible).toBe(true);
    expect(pattern.diagnostic.patternCloaked).toBe(0);
    expect(pattern.diagnostic.patternWindowRgb).toEqual([48, 96, 160]);
    test.skip(JSON.stringify(pattern.diagnostic.patternDesktopRgb) !== '[48,96,160]', `当前桌面未呈现 owned Win32 测试窗口：窗口 DC 为蓝色，desktop DC 为 ${JSON.stringify(pattern.diagnostic.patternDesktopRgb)}；保留严格 RGB 条件，真实 GDI 采集未验证。`);
    const capture = await beginCapture(app);
    expect(capture.state.pattern).toBe(false);
    const from = { x: pattern.left - capture.state.bounds.left + 48, y: pattern.top - capture.state.bounds.top + 40 };
    const to = { x: from.x + 64, y: from.y + 48 };
    expect(from.x).toBeGreaterThanOrEqual(0); expect(from.y).toBeGreaterThanOrEqual(0);
    expect(to.x).toBeLessThan(capture.state.bounds.right - capture.state.bounds.left);
    expect(to.y).toBeLessThan(capture.state.bounds.bottom - capture.state.bounds.top);
    const sourcePixels = await capture.overlay.evaluate(({ x, y }) => {
      const image = document.querySelector<HTMLImageElement>('.screenshots-background-image')!;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const positions = [[x, y], [x + 32, y + 24], [x + 63, y + 47]];
      return positions.map(([left, top]) => { context.drawImage(image, left, top, 1, 1, 0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data); });
    }, from);
    const sourcePath = testInfo.outputPath('owned-pattern-source-roi.json');
    await writeFile(sourcePath, JSON.stringify({ pattern: { left: pattern.left, top: pattern.top, width: pattern.width, height: pattern.height }, from, to, sourcePixels }, null, 2));
    await testInfo.attach('real-gdi-owned-pattern-source-roi', { path: sourcePath, contentType: 'application/json' });
    for (const pixel of sourcePixels) expect(pixel).toEqual([48, 96, 160, 255]);
    // This is the only exported region. The full desktop exists transiently in
    // memory for selection; its pixels are never saved, attached or uploaded.
    await selectRegion(capture.overlay, from, to);
    await closingAction(capture.overlay, () => capture.overlay.getByTitle('完成截图', { exact: true }).click());
    const png = await capture.result;
    expect(png).not.toBeNull();
    const decoded = await decodePixels(app.page, png!);
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 64, height: 48 });
    for (const point of decoded.pixels) expect(point.rgba).toEqual([48, 96, 160, 255]);
    await expect.poll(async () => (await app!.windowState()).iconic).toBe(false);
    await testInfo.attach('real-gdi-owned-pattern-crop', { body: JSON.stringify({ source: 'real GDI desktop capture; exported crop strictly within owned opaque pattern window', pattern: { left: pattern.left, top: pattern.top, width: pattern.width, height: pattern.height }, from, to, capture: capture.state, decoded }), contentType: 'application/json' });
  } finally {
    await pattern?.close().catch(() => {});
    await app?.close().catch(() => {});
    await cleanupDirectory(directory);
  }
});
