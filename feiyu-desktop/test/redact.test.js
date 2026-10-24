'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redactText, redactObject, looksSecret } = require('../src/services/redact');

test('redact sk- key', () => { assert.ok(redactText('sk-abc123def456ghi').includes('sk-<KEY>')); });
test('redact windows path', () => { assert.ok(redactText('file at D:\\NapCat\\ai_config.json').includes('<本地路径>')); });
test('redact windows path whose first segment starts with s (回归: [^\\s] 误排除字母 s)', () => {
  // 历史缺陷：字符类写成 [^\\s"'<>|]，在字符类里 \s 被当作字面量 's'，
  // 导致首段含 s 的路径完全不被脱敏，且 C:\Users\me\x 只替换掉 "C:\U"、尾部泄漏。
  for (const p of ['D:\\some\\path\\file.txt', 'D:\\secret\\x.txt', 'D:\\sss\\t.txt', 'C:\\Users\\me\\x', 'D:\\system32\\drivers']) {
    const out = redactText(p);
    assert.ok(out !== p, '路径未脱敏: ' + p);
    assert.ok(!/[A-Za-z]:\\/.test(out), '路径残留盘符: ' + p + ' -> ' + out);
  }
});
test('redact windows path stops at whitespace (不吞掉后续正常文本)', () => {
  const out = redactText('D:\\a b\\c.txt 后面的说明文字');
  assert.ok(out.includes('<本地路径>'));
  assert.ok(out.includes('后面的说明文字'), '不应吞掉路径后的正常文本: ' + out);
});
test('redact local port', () => { assert.ok(redactText('listen 127.0.0.1:3001').includes('<本地地址>')); });
test('redact onebot token field', () => { assert.ok(redactText('"onebotToken":"x"').includes('<TOKEN>')); });
test('keeps normal text', () => { assert.strictEqual(redactText('你好世界'), '你好世界'); });
test('redactObject recurses', () => {
  const o = redactObject({ a: 'sk-abc123def456', b: ['x D:\\y'], n: 5 });
  assert.ok(o.a.includes('<KEY>')); assert.ok(o.b[0].includes('<本地路径>')); assert.strictEqual(o.n, 5);
});
test('looksSecret true for key', () => { assert.strictEqual(looksSecret('apiKey: sk-abc'), true); assert.strictEqual(looksSecret('普通文本'), false); });

// ————————————————————————————————————————
// V1.0 验收新增：路径脱敏对各种 Windows 路径形态的正确性
// ————————————————————————————————————————

test('redact windows path with forward slashes', () => {
  assert.ok(redactText('see D:/NapCat/secrets.json').includes('<本地路径>'));
});
test('redact windows path with mixed separators', () => {
  assert.ok(redactText('D:\\NapCat/memory/usage/x.jsonl').includes('<本地路径>'));
});
test('redact windows path with space in segment', () => {
  // 空格会终止路径片段，尾部允许残留（与 bot 核心同口径）
  assert.ok(redactText('D:\\a b\\c.txt').includes('<本地路径>'));
});
test('redact does not touch https urls', () => {
  const s = 'https://api.deepseek.com/v1/chat/completions';
  assert.strictEqual(redactText(s), s);
});
test('redact does not touch plain external url', () => {
  const s = 'http://example.com/api';
  assert.strictEqual(redactText(s), s);
});
test('redact masks localhost port (localport rule)', () => {
  assert.ok(redactText('http://localhost:3000/api').includes('<本地地址>'));
});
test('redact masks apiKey / onebotToken / auth header fields', () => {
  assert.ok(redactText('{"apiKey":"sk-xyz"}').includes('<KEY>'));
  assert.ok(redactText('{"onebotToken":"tok-abc"}').includes('<TOKEN>'));
  assert.ok(redactText('Authorization: Bearer abcdef').includes('<TOKEN>'));
});
test('redact masks internal component names', () => {
  const o = redactText('napcat ai_bridge secrets.json');
  assert.ok(!o.includes('napcat'));
  assert.ok(!o.includes('ai_bridge'));
});
