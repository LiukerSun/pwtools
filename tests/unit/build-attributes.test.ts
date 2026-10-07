import assert from 'node:assert/strict';
import test from 'node:test';
import { initialAttributes, hasMainAttributes, validAttributes, mergeCandidates, personalInput } from '../../apps/desktop/src/renderer/buildAttributes.ts';

test('空值与0，整数和参考价保护', () => {
  assert.equal(hasMainAttributes({ damage: 0 }), true);
  assert.equal(hasMainAttributes({ damage: null, price: 100 }), false);
  assert.equal(validAttributes({ damage: -1 }), false);
  assert.equal(validAttributes({ damage: 39, capacity: 1.5 }), false);
  assert.equal(validAttributes({ price: 9_000_000_000_001 }), false);
});
test('重新识别填空与显式全部替换', () => {
  const previous = { damage: 0, handling: 38, range_m: null };
  const incoming = { damage: 39, handling: 50, range_m: 65 };
  assert.deepEqual(mergeCandidates(previous, incoming, false), { damage: 0, handling: 38, range_m: 65 });
  assert.deepEqual(mergeCandidates(previous, incoming, true), incoming);
});
test('保存三态保留、清空和确认对象', () => {
  const identity = { weapon_name: 'M7战斗步枪', mode: '烽火地带' as const, core_code: 'ABCDEFGH' };
  const initial = initialAttributes();
  assert.equal(personalInput(initial, identity), undefined);
  assert.equal(personalInput({ ...initial, changed: true, clear: true }, identity), null);
  assert.deepEqual(personalInput({ ...initial, values: { damage: 39 }, changed: true, confirmed: true }, identity), {
    identity, values: { damage: 39 }, source: 'manual', recognized_at: null, confirmed: true,
  });
});
