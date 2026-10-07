import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBuildCode } from '../../apps/desktop/src/renderer/buildCode.ts';

test('完整码保留枪名中的连字符', () => {
  assert.deepEqual(parseBuildCode(' PTR-32突击步枪-全面战场-6EIAKTC02U9HU6AC38CQJ '), {
    core: '6EIAKTC02U9HU6AC38CQJ', weapon: 'PTR-32突击步枪', mode: '全面战场', error: '',
  });
});
test('接受核心码但要求表单补充武器和模式', () => {
  assert.equal(parseBuildCode('6L79CCC0BK4JN1CPUVQAH').core, '6L79CCC0BK4JN1CPUVQAH');
  assert.equal(parseBuildCode('6L79CCC0BK4JN1CPUVQAH').weapon, '');
});
test('非法模式、字符、长度与空名称不给出可保存结果', () => {
  for (const code of ['bad','武器-错误模式-ABCDEFGH','-烽火地带-ABCDEFGH','武器-烽火地带-ABCD%EFGH','A'.repeat(65),'武器-烽火地带-ABCDEFGH\nX']) assert.ok(parseBuildCode(code).error);
});
