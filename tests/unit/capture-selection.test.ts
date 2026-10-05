import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureDragBounds, captureDragStarted, captureWindowAt, readCaptureWindows } from '../../apps/desktop/src/renderer/captureSelection.ts';

test('window snapping follows stacking order and free dragging stays independent', () => {
  const viewport = { width: 3200, height: 1080 };
  const windows = readCaptureWindows([
    { x: 1800, y: 100, width: 900, height: 700 },
    { x: 1600, y: 0, width: 1600, height: 1080 },
    { x: 0, y: 0, width: 1600, height: 900 },
  ], viewport);
  assert.equal(captureWindowAt(windows, { x: 2000, y: 400 }), windows[0]);
  assert.equal(captureWindowAt(windows, { x: 2750, y: 400 }), windows[1]);
  assert.equal(captureWindowAt(windows, { x: 1600, y: 400 }), windows[1]);
  assert.equal(captureWindowAt(windows, { x: 20, y: 950 }), null);
  assert.equal(captureDragStarted({ x: 100, y: 100 }, { x: 102, y: 101 }), false);
  assert.equal(captureDragStarted({ x: 100, y: 100 }, { x: 103, y: 104 }), true);
  assert.deepEqual(captureDragBounds({ x: 2000, y: 700 }, { x: 1200, y: 200 }, viewport),
    { x: 1200, y: 200, width: 800, height: 500 });
  assert.deepEqual(captureDragBounds({ x: -100, y: 20 }, { x: 4000, y: 2000 }, viewport),
    { x: 0, y: 20, width: 3200, height: 1060 });
  assert.equal(captureDragBounds({ x: 10, y: 10 }, { x: 100, y: 10 }, viewport), null);
  assert.throws(() => readCaptureWindows([{ x: -1, y: 0, width: 100, height: 100 }], viewport));
  assert.throws(() => readCaptureWindows([{ x: 3100, y: 0, width: 200, height: 100 }], viewport));
});
