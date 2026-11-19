import test from 'node:test';
import assert from 'node:assert/strict';
import { setConcurrentHandler } from '../src/index.js';

test('báo cáo cuối ngày: tự đăng nhập tiếp 2 lần, lần 3 hỏi; báo cáo thường luôn hỏi', async () => {
  const sent = []; const asked = [];
  const tg = { sendMessage: async (t) => sent.push(t), ask: async (t) => { asked.push(t); return 'no'; } };
  const config = { title: 'X', amis: {} };
  const auto = { used: 0, limit: 2 };
  const s = {};
  setConcurrentHandler(s, config, tg, auto);
  assert.equal(s.allowRepeat, true);
  assert.equal(await s.onConcurrent('máy A'), 'yes');
  assert.equal(await s.onConcurrent('máy A'), 'yes');
  assert.equal(await s.onConcurrent('máy A'), 'no');
  assert.equal(sent.length, 2); assert.equal(asked.length, 1);
  assert.match(asked[0], /đã tự đăng nhập tiếp 2 lần/);

  const n = {};
  setConcurrentHandler(n, config, tg);
  assert.equal(n.allowRepeat, false);
  assert.equal(await n.onConcurrent('máy A'), 'no');
  assert.equal(asked.length, 2);
});
