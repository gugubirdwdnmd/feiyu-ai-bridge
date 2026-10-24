'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redactText, redactObject, looksSecret } = require('../src/services/redact');

test('redact sk- key', () => { assert.ok(redactText('sk-abc123def456ghi').includes('sk-<KEY>')); });
test('redact windows path', () => { assert.ok(redactText('file at D:\\NapCat\\ai_config.json').includes('<本地路径>')); });
test('redact local port', () => { assert.ok(redactText('listen 127.0.0.1:3001').includes('<本地地址>')); });
test('redact onebot token field', () => { assert.ok(redactText('"onebotToken":"x"').includes('<TOKEN>')); });
test('keeps normal text', () => { assert.strictEqual(redactText('你好世界'), '你好世界'); });
test('redactObject recurses', () => {
  const o = redactObject({ a: 'sk-abc123def456', b: ['x D:\\y'], n: 5 });
  assert.ok(o.a.includes('<KEY>')); assert.ok(o.b[0].includes('<本地路径>')); assert.strictEqual(o.n, 5);
});
test('looksSecret true for key', () => { assert.strictEqual(looksSecret('apiKey: sk-abc'), true); assert.strictEqual(looksSecret('普通文本'), false); });
