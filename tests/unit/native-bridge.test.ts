import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeBridge, NativeBridgeError, type NativeRequest, type NativeWebView } from '../../apps/desktop/src/renderer/nativeBridge.ts';

class FakeWebView implements NativeWebView {
  readonly requests: NativeRequest[] = [];
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  failPost = false;

  postMessage(request: NativeRequest) {
    if (this.failPost) throw new Error('Disconnected');
    this.requests.push(request);
  }

  addEventListener(_type: 'message', handler: (event: { data: unknown }) => void) { this.listeners.add(handler); }
  removeEventListener(_type: 'message', handler: (event: { data: unknown }) => void) { this.listeners.delete(handler); }
  receive(data: unknown) { for (const listener of this.listeners) listener({ data }); }
  reply(index: number, data: unknown) { this.receive({ id: this.requests[index].id, ok: true, data }); }
}

test('all desktop methods use matching RPC names and JSON arguments', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  const bridge = native.bridge;
  const auth = { email: 'test@example.invalid', password: 'example-password' };
  const boss = { display_name: '老板', game_id: '', game_name: '', notes: '' };
  const order = { title: '订单', kind: 'hourly' as const, target_quantity: 60, failure_default_quantity: 0, note: '' };
  const template = { ...order, name: '小时模板' };
  const match = { player_name: '老板', outcome: 'success' as const, amount: 100, confirmed: true, played_at: null, note: '', fake_amount: 0 };
  const entry = { kind: 'progress' as const, quantity: 30, occurred_at: null, note: '', idempotency_key: 'same-retry-key' };
  const transfer = { id: 'transfer', prepaid: false, progress_bps: null, note: '协商转出', expected_updated_at: '2026-10-07T00:00:00Z' };
  const transferAction = { id: 'action', transfer_id: 'transfer', action: 'settle' as const, amount_cents: 19960, note: '已收到', expected_updated_at: '2026-10-07T00:01:00Z' };
  const rentalAccount = { id: 'account', name: '租用账号', note: '' };
  const rentalSession = { id: 'rental', account_id: 'account', coin_per_yuan: 500000, aw_price: 200000, helmet_price: 300000, armor_price: 400000, initial_coins: 10000000, deposit_cents: 20000, started_at: '2026-10-06T00:00:00Z', note: '' };
  const cases: Array<[string, () => Promise<unknown>, unknown[]]> = [
    ['listBuildCodes', () => bridge.listBuildCodes(), []],
    ['createBuildCode', () => bridge.createBuildCode({ code: 'ABCDEFGH', weapon_name: 'M7', mode: '烽火地带', note: '' }), [{ code: 'ABCDEFGH', weapon_name: 'M7', mode: '烽火地带', note: '' }]],
    ['updateBuildCode', () => bridge.updateBuildCode('code-id', { code: 'ABCDEFGH', weapon_name: 'M7', mode: '烽火地带', note: '' }), ['code-id', { code: 'ABCDEFGH', weapon_name: 'M7', mode: '烽火地带', note: '' }]],
    ['deleteBuildCode', () => bridge.deleteBuildCode('code-id'), ['code-id']],
    ['lookupBuildCode', () => bridge.lookupBuildCode({ code: 'ABCDEFGH', weapon_name: 'M7', mode: '烽火地带', note: '' }), [{ code: 'ABCDEFGH', weapon_name: 'M7', mode: '烽火地带', note: '' }]],
    ['recognizeBuildCodeAttributes', () => bridge.recognizeBuildCodeAttributes({ name: 'gun.png', content_type: 'image/png', data_base64: 'AAEC' }), [{ name: 'gun.png', content_type: 'image/png', data_base64: 'AAEC' }]],
    ['classifyScreenshot', () => bridge.classifyScreenshot({ name: 'capture.png', content_type: 'image/png', data_base64: 'AAEC' }), [{ name: 'capture.png', content_type: 'image/png', data_base64: 'AAEC' }]],
    ['listRentalAccounts', () => bridge.listRentalAccounts(), []],
    ['createRentalAccount', () => bridge.createRentalAccount(rentalAccount), [rentalAccount]],
    ['listRentalSessions', () => bridge.listRentalSessions(), []],
    ['createRentalSession', () => bridge.createRentalSession(rentalSession), [rentalSession]],
    ['returnRentalSession', () => bridge.returnRentalSession('rental', { final_cost_cents: 13500 }), ['rental', { final_cost_cents: 13500 }]],
    ['rentalAnalysis', () => bridge.rentalAnalysis('rental'), ['rental']],
    ['health', () => bridge.health(), []],
    ['register', () => bridge.register(auth), [auth]],
    ['login', () => bridge.login(auth), [auth]],
    ['me', () => bridge.me(), []],
    ['logout', () => bridge.logout(), []],
    ['windowControl', () => bridge.windowControl('close'), ['close']],
    ['windowControl', () => bridge.windowControl('minimize'), ['minimize']],
    ['windowControl', () => bridge.windowControl('hide-to-tray'), ['hide-to-tray']],
    ['windowControl', () => bridge.windowControl('restore'), ['restore']],
    ['setWindowTheme', () => bridge.setWindowTheme('dark'), ['dark']],
    ['setWindowTheme', () => bridge.setWindowTheme('light'), ['light']],
    ['setImportHotkey', () => bridge.setImportHotkey(null), [null]],
    ['setImportHotkey', () => bridge.setImportHotkey({ code: 'KeyI', ctrl: true, alt: true, shift: false, win: false }), [{ code: 'KeyI', ctrl: true, alt: true, shift: false, win: false }]],
    ['appInfo', () => bridge.appInfo(), []],
    ['getUpdateState', () => bridge.getUpdateState(), []],
    ['checkForUpdates', () => bridge.checkForUpdates(), []],
    ['setBetaParticipation', () => bridge.setBetaParticipation(true), [true]],
    ['downloadUpdate', () => bridge.downloadUpdate(), []],
    ['installUpdate', () => bridge.installUpdate(), []],
    ['listMatches', () => bridge.listMatches(undefined, undefined, undefined, false), [1, 20, null, false]],
    ['matchStats', () => bridge.matchStats(), [null]],
    ['getMatch', () => bridge.getMatch('match'), ['match']],
    ['updateMatch', () => bridge.updateMatch('match', match), ['match', match]],
    ['recognizeMatch', () => bridge.recognizeMatch('match'), ['match']],
    ['deleteMatch', () => bridge.deleteMatch('match'), ['match']],
    ['matchSettings', () => bridge.matchSettings(), []],
    ['updateMatchSettings', () => bridge.updateMatchSettings({ boss_id: 'boss', boss_player_name: '老板' }), [{ boss_id: 'boss', boss_player_name: '老板' }]],
    ['listBosses', () => bridge.listBosses(), ['']],
    ['getBoss', () => bridge.getBoss('boss'), ['boss']],
    ['createBoss', () => bridge.createBoss(boss), [boss]],
    ['updateBoss', () => bridge.updateBoss('boss', boss), ['boss', boss]],
    ['listOrders', () => bridge.listOrders(), [null]],
    ['getOrder', () => bridge.getOrder('order'), ['order']],
    ['createOrder', () => bridge.createOrder('boss', order), ['boss', order]],
    ['updateOrder', () => bridge.updateOrder('order', order), ['order', order]],
    ['transferOrder', () => bridge.transferOrder('order', transfer), ['order', transfer]],
    ['transferOrderAction', () => bridge.transferOrderAction('order', transferAction), ['order', transferAction]],
    ['listOrderTemplates', () => bridge.listOrderTemplates(), []],
    ['createOrderTemplate', () => bridge.createOrderTemplate(template), [template]],
    ['updateOrderTemplate', () => bridge.updateOrderTemplate('template', template), ['template', template]],
    ['deleteOrderTemplate', () => bridge.deleteOrderTemplate('template'), ['template']],
    ['listLedgerEntries', () => bridge.listLedgerEntries('order'), ['order', 1, 20]],
    ['addLedgerEntry', () => bridge.addLedgerEntry('order', entry), ['order', entry]],
    ['deleteLedgerEntry', () => bridge.deleteLedgerEntry('order', 'entry'), ['order', 'entry']],
    ['windowDrag', () => native.dragWindow(), []],
  ];
  try {
    for (const [method, call, args] of cases) {
      const result = call();
      const index = webview.requests.length - 1;
      const request = webview.requests[index];
      assert.equal(request.method, method);
      assert.deepEqual(request.args, args);
      assert.deepEqual(JSON.parse(JSON.stringify(request)).args, args);
      webview.reply(index, { returnedBy: method });
      assert.deepEqual(await result, { returnedBy: method });
    }
    assert.equal(new Set(webview.requests.map(request => request.id)).size, cases.length);
  } finally { native.dispose(); }
});

test('responses correlate by request id, including out-of-order and duplicate replies', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  try {
    const first = native.bridge.getBoss('first');
    const second = native.bridge.getBoss('second');
    webview.receive({ id: 'unknown', ok: true, data: 'unrelated' });
    webview.reply(1, 'second');
    assert.equal(await second, 'second');
    webview.reply(1, 'duplicate');
    webview.reply(0, 'first');
    assert.equal(await first, 'first');
  } finally { native.dispose(); }
});

test('screenshots round-trip base64 without leaking typed-array wire data or losing offsets', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  const storage = Uint8Array.from({ length: 120_033 }, (_, index) => index % 256);
  const data = storage.subarray(17, 120_010);
  try {
    const upload = native.bridge.uploadMatch({ name: 'screenshot.png', content_type: 'image/png', data, order_id: 'order' });
    const request = webview.requests[0];
    assert.equal(request.method, 'uploadMatch');
    const wire = request.args[0] as Record<string, unknown>;
    assert.equal('data' in wire, false);
    assert.equal(wire.order_id, 'order');
    assert.equal(wire.content_type, 'image/png');
    assert.deepEqual(Uint8Array.from(atob(String(wire.data_base64)), character => character.charCodeAt(0)), data);
    webview.reply(0, { duplicate: false });
    assert.deepEqual(await upload, { duplicate: false });
    const image = native.bridge.matchImage('match');
    webview.reply(1, { content_type: 'image/png', data_base64: wire.data_base64 });
    const result = await image;
    assert.equal(result.content_type, 'image/png');
    assert.ok(result.data instanceof Uint8Array);
    assert.deepEqual(result.data, data);
    const malformed = native.bridge.matchImage('bad');
    webview.reply(2, { content_type: 'image/png', data_base64: '?' });
    await assert.rejects(malformed, { code: 'IMAGE_INTEGRITY_ERROR' });
    const thumbnail = native.bridge.matchThumbnail('match');
    assert.equal(webview.requests[3].method, 'matchThumbnail');
    assert.deepEqual(webview.requests[3].args, ['match']);
    webview.reply(3, { content_type: 'image/webp', data_base64: 'BAUG' });
    assert.deepEqual(await thumbnail, { content_type: 'image/webp', data: Uint8Array.from([4, 5, 6]) });
  } finally { native.dispose(); }
});

test('host errors retain their codes; malformed replies remain uncertain', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  try {
    const denied = native.bridge.me();
    webview.receive({ id: webview.requests[0].id, ok: false, error: { code: 'UNAUTHORIZED', message: '请重新登录' } });
    await assert.rejects(denied, error => error instanceof NativeBridgeError && error.code === 'UNAUTHORIZED' && error.message === '请重新登录');
    const malformed = native.bridge.logout();
    webview.receive({ id: webview.requests[1].id, ok: false, error: {} });
    await assert.rejects(malformed, { code: 'UNKNOWN' });
    webview.failPost = true;
    await assert.rejects(native.bridge.health(), { code: 'NETWORK_ERROR' });
  } finally { native.dispose(); }
});

test('ordinary calls expire at 20 seconds and OCR calls at 110 seconds', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  try {
    let ordinaryDone = false;
    let ocrDone = false;
    const ordinary = native.bridge.health();
    const ocr = native.bridge.recognizeMatch('match');
    const ordinaryRejected = assert.rejects(ordinary, { code: 'TIMEOUT' }).then(() => { ordinaryDone = true; });
    const ocrRejected = assert.rejects(ocr, { code: 'TIMEOUT' }).then(() => { ocrDone = true; });
    context.mock.timers.tick(19_999);
    await Promise.resolve();
    assert.equal(ordinaryDone, false);
    assert.equal(ocrDone, false);
    context.mock.timers.tick(1);
    await ordinaryRejected;
    assert.equal(ordinaryDone, true);
    assert.equal(ocrDone, false);
    webview.reply(0, 'late response');
    context.mock.timers.tick(89_999);
    await Promise.resolve();
    assert.equal(ocrDone, false);
    context.mock.timers.tick(1);
    await ocrRejected;
    const upload = native.bridge.uploadMatch({ name: 'empty-test.png', content_type: 'image/png', data: new Uint8Array() });
    const uploadRejected = assert.rejects(upload, { code: 'TIMEOUT' });
    context.mock.timers.tick(110_000);
    await uploadRejected;
    const attributes = native.bridge.recognizeBuildCodeAttributes({ name: 'panel.png', content_type: 'image/png', data_base64: 'AQID' });
    const attributesRejected = assert.rejects(attributes, { code: 'TIMEOUT' });
    context.mock.timers.tick(110_000);
    await attributesRejected;
  } finally { native.dispose(); }
});

test('close notifications are advisory, queue before subscription, and unsubscribe cleanly', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  let requests = 0;
  try {
    webview.receive({ event: 'close-requested' });
    const unsubscribe = native.bridge.onCloseRequested!(() => { requests += 1; });
    await Promise.resolve();
    assert.equal(requests, 1);
    webview.receive({ event: 'close-requested' });
    assert.equal(requests, 2);
    assert.equal(webview.requests.length, 0, 'the bridge must not force-close before the app guards run');
    unsubscribe();
    unsubscribe();
    webview.receive({ event: 'close-requested' });
    assert.equal(requests, 2);
  } finally { native.dispose(); }
});

test('explicit exit notifications queue independently and leave exit guards in charge', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  let closes = 0;
  let exits = 0;
  try {
    webview.receive({ event: 'exit-requested' });
    const unsubscribeClose = native.bridge.onCloseRequested!(() => { closes += 1; });
    await Promise.resolve();
    assert.equal(closes, 0, 'explicit exit must not use the minimize preference');
    const unsubscribeExit = native.bridge.onExitRequested!(() => { exits += 1; });
    await Promise.resolve();
    assert.equal(exits, 1);
    webview.receive({ event: 'close-requested' });
    assert.equal(closes, 1);
    assert.equal(exits, 1);
    webview.receive({ event: 'exit-requested' });
    assert.equal(closes, 1);
    assert.equal(exits, 2);
    assert.equal(webview.requests.length, 0, 'exit guards must run before the bridge sends a close command');
    unsubscribeExit();
    unsubscribeExit();
    webview.receive({ event: 'exit-requested' });
    assert.equal(exits, 2);
    webview.receive({ event: 'close-requested' });
    assert.equal(closes, 2);
    unsubscribeClose();
  } finally { native.dispose(); }
});

test('queued exit notifications are cancelled by unsubscribe or disposal', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  let exits = 0;
  webview.receive({ event: 'exit-requested' });
  const unsubscribe = native.bridge.onExitRequested!(() => { exits += 1; });
  unsubscribe();
  await Promise.resolve();
  assert.equal(exits, 0);
  webview.receive({ event: 'exit-requested' });
  native.bridge.onExitRequested!(() => { exits += 1; });
  native.dispose();
  await Promise.resolve();
  assert.equal(exits, 0);
  webview.receive({ event: 'exit-requested' });
  assert.equal(exits, 0);
});

test('disposal rejects outstanding operations and removes message listeners', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  const pending = native.bridge.logout();
  const rejected = assert.rejects(pending, { code: 'NETWORK_ERROR' });
  native.dispose();
  await rejected;
  assert.equal(webview.listeners.size, 0);
  await assert.rejects(native.bridge.health(), { code: 'NETWORK_ERROR' });
  assert.equal(webview.requests.length, 1);
  native.dispose();
});

test('global import notifications coalesce before subscription and do not bypass app guards', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  let imports = 0;
  try {
    webview.receive({ event: 'import-requested' });
    webview.receive({ event: 'import-requested' });
    const unsubscribe = native.bridge.onImportRequested!(() => { imports += 1; });
    await Promise.resolve();
    assert.equal(imports, 1);
    webview.receive({ event: 'import-requested' });
    assert.equal(imports, 2);
    assert.equal(webview.requests.length, 0, 'only the app may choose an order and start uploading');
    unsubscribe();
    webview.receive({ event: 'import-requested' });
    const cancel = native.bridge.onImportRequested!(() => { imports += 1; });
    cancel();
    await Promise.resolve();
    assert.equal(imports, 2);
    webview.receive({ event: 'import-requested' });
    native.bridge.onImportRequested!(() => { imports += 1; });
    native.dispose();
    await Promise.resolve();
    assert.equal(imports, 2);
  } finally { native.dispose(); }
});

test('clipboard images preserve bytes and empty or malformed results remain distinct', async () => {
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  try {
    const empty = native.bridge.readClipboardImage();
    assert.equal(webview.requests[0].method, 'readClipboardImage');
    assert.deepEqual(webview.requests[0].args, []);
    webview.reply(0, null);
    assert.equal(await empty, null);
    const image = native.bridge.readClipboardImage();
    webview.reply(1, { name: 'clipboard.png', content_type: 'image/png', data_base64: 'AAECA/8=' });
    assert.deepEqual(await image, { name: 'clipboard.png', content_type: 'image/png', data: Uint8Array.of(0, 1, 2, 3, 255) });
    const malformed = native.bridge.readClipboardImage();
    webview.reply(2, { name: 'broken.png', content_type: 'image/png', data_base64: '?' });
    await assert.rejects(malformed, { code: 'IMAGE_INTEGRITY_ERROR' });
  } finally { native.dispose(); }
});

test('screen selection cancellation stays distinct from PNG bytes and capture errors', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const webview = new FakeWebView();
  const native = createNativeBridge(webview);
  try {
    const cancelled = native.bridge.captureScreen();
    assert.equal(webview.requests[0].method, 'captureScreen');
    assert.deepEqual(webview.requests[0].args, []);
    context.mock.timers.tick(25_000);
    webview.reply(0, null);
    assert.equal(await cancelled, null, 'a user can take longer than an ordinary RPC timeout to select a region');
    const image = native.bridge.captureScreen();
    webview.reply(1, { name: 'capture.png', content_type: 'image/png', data_base64: 'AAECA/8=' });
    assert.deepEqual(await image, { name: 'capture.png', content_type: 'image/png', data: Uint8Array.of(0, 1, 2, 3, 255) });
    const malformed = native.bridge.captureScreen();
    webview.reply(2, { content_type: 'image/png', data_base64: '?' });
    await assert.rejects(malformed, { code: 'IMAGE_INTEGRITY_ERROR' });
    const denied = native.bridge.captureScreen();
    webview.receive({ id: webview.requests[3].id, ok: false, error: { code: 'BUSY', message: '正在截图' } });
    await assert.rejects(denied, { code: 'BUSY' });
    assert.equal(webview.requests.some(request => request.method === 'readClipboardImage' || request.method === 'uploadMatch'), false);
  } finally { native.dispose(); }
});
