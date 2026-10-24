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
