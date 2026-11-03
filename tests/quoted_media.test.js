'use strict';
// 被引用消息（群聊引用图片）抽取 — 纯函数单测（零依赖，不连 NapCat）
const test = require('node:test');
const assert = require('node:assert');
const qm = require('../tools/quoted_media');

// 模拟 get_msg 返回结构：{ data: { message: [...] } }
function getMsgResult(segs) {
  return { status: 'ok', data: { message: segs } };
}

test('toSegments：数组 / 带 .message 的对象 / CQ 字符串 都能归一', () => {
  assert.deepStrictEqual(qm.toSegments([{ type: 'text', data: { text: 'hi' } }]), [{ type: 'text', data: { text: 'hi' } }]);
  assert.deepStrictEqual(qm.toSegments({ message: [{ type: 'text', data: { text: 'x' } }] }), [{ type: 'text', data: { text: 'x' } }]);
  const cq = qm.toSegments('[CQ:image,file=abc.jpg,url=http://x/y.jpg]');
  assert.strictEqual(cq.length, 1);
  assert.strictEqual(cq[0].type, 'image');
  assert.strictEqual(cq[0].data.file, 'abc.jpg');
});

test('imageSegsOf / textOf：从段里抽出图与文', () => {
  const segs = [
    { type: 'text', data: { text: '看这张' } },
    { type: 'image', data: { file: 'a.png', url: 'u1' } },
    { type: 'image', data: { file: 'b.png', url: 'u2' } },
  ];
  assert.strictEqual(qm.imageSegsOf(segs).length, 2);
  assert.strictEqual(qm.textOf(segs), '看这张');
});

test('coalesceQuotedImages：缓冲命中优先，直接取缓冲的图片段', () => {
  const buffered = { imgSegs: [{ type: 'image', data: { file: 'buf.png', url: 'ub' } }], text: '被引用的文字' };
  const out = qm.coalesceQuotedImages({ buffered, fetched: null });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].data.file, 'buf.png');
});

test('coalesceQuotedImages：缓冲未命中时由 get_msg 结果补全', () => {
  const fetched = getMsgResult([{ type: 'image', data: { file: 'f.png', url: 'uf' } }]);
  const out = qm.coalesceQuotedImages({ buffered: null, fetched });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].data.file, 'f.png');
});

test('coalesceQuotedImages：缓冲与 get_msg 重复图片按 file 去重', () => {
  const buffered = { imgSegs: [{ type: 'image', data: { file: 'same.png', url: 'uA' } }], text: 't' };
  const fetched = getMsgResult([{ type: 'image', data: { file: 'same.png', url: 'uB' } }]);
  const out = qm.coalesceQuotedImages({ buffered, fetched });
  assert.strictEqual(out.length, 1); // 去重后只剩一张
});

test('mergeVisionSegs：当前图在前、被引用图在后，按 URL 去重，且受限 maxImages', () => {
  const base = [{ type: 'image', data: { file: 'cur.png', url: 'c' } }];
  const quoted = [
    { type: 'image', data: { file: 'q1.png', url: 'q1' } },
    { type: 'image', data: { file: 'cur.png', url: 'c' } }, // 与当前图重复，应去重
    { type: 'image', data: { file: 'q2.png', url: 'q2' } },
  ];
  const out = qm.mergeVisionSegs(base, quoted, 3);
  assert.strictEqual(out.length, 3); // cur + q1 + q2（q2 因上限被截断）
  assert.strictEqual(out[0].data.url, 'c'); // 当前图在前
  assert.strictEqual(out[1].data.url, 'q1');
});

test('mergeVisionSegs：被引用图多于上限时截断，绝不返回非图片段', () => {
  const quoted = [
    { type: 'image', data: { file: 'q1.png', url: 'q1' } },
    { type: 'text', data: { text: '不是图' } }, // 非图片，应被忽略
    { type: 'image', data: { file: 'q2.png', url: 'q2' } },
  ];
  const out = qm.mergeVisionSegs([], quoted, 1);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'image');
});
