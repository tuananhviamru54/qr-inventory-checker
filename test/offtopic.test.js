import test from 'node:test';
import assert from 'node:assert/strict';
import { isOnTopic } from '../src/bot.js';

test('câu không rõ chủ đề bị từ chối, câu về kho/doanh số/công nợ được nhận', () => {
  for (const q of ['alo', 'ok', 'bạn là ai', 'kể chuyện cười', 'hôm nay trời đẹp', '2+2 bằng mấy']) assert.equal(isOnTopic(q), false, q);
  for (const q of ['A10_2 còn bao nhiêu', 'tồn kho ECO', 'công nợ khách Long', 'mã nào đang âm kho', 'tiền ngân hàng còn bao nhiêu', 'chi phí tháng 10']) assert.equal(isOnTopic(q), true, q);
});
