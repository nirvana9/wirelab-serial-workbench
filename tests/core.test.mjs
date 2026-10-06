import test from 'node:test';
import assert from 'node:assert/strict';

test('HEX separators and prefixes preserve byte values', async () => {
  const {parseHex, hex} = await import('../dist/core.mjs');
  assert.deepEqual([...parseHex('0xAA, 0x55:00 ff')], [170,85,0,255]);
  assert.equal(hex(parseHex('AA5500FF')), 'AA 55 00 FF');
});

test('invalid or odd HEX and empty commands are rejected', async () => {
  const {parseHex,buildPayload} = await import('../dist/core.mjs');
  for(const bad of ['AAB','GG','-1','AA zz','0x','','1 2','0x1 0x2','AA B CC D']) assert.throws(()=>parseHex(bad),bad);
  assert.throws(()=>buildPayload('',{mode:'text'}));
});

test('UTF8 and CRLF produce exact on-wire bytes', async () => {
  const {buildPayload} = await import('../dist/core.mjs');
  assert.deepEqual([...buildPayload('你好',{mode:'text',ending:'crlf'})], [228,189,160,229,165,189,13,10]);
});

test('SUM8 and XOR8 apply to body before line ending', async () => {
  const {buildPayload} = await import('../dist/core.mjs');
  assert.deepEqual([...buildPayload('FF 02',{mode:'hex',checksum:'sum8',ending:'lf'})],[255,2,1,10]);
  assert.deepEqual([...buildPayload('AA 55',{mode:'hex',checksum:'xor8'})],[170,85,255]);
});

test('CRC16 MODBUS uses initial FFFF and low-byte-first standard check vector', async () => {
  const {buildPayload} = await import('../dist/core.mjs');
  assert.deepEqual([...buildPayload('123456789',{mode:'text',checksum:'modbus'})],[49,50,51,52,53,54,55,56,57,0x37,0x4b]);
});

test('log analysis grades faults without treating zero errors as a failure', async () => {
  const {analyzeLog} = await import('../dist/core.mjs');
  const records=analyzeLog('[ 1.0] boot complete\n[ 2.1] usb error -71\n[ 3.0] WARNING: voltage low\nsummary: 0 errors\nKernel panic - not syncing');
  assert.deepEqual(records.map(x=>x.level),['info','error','warning','info','error']);
  assert.equal(records[1].line,2);
  assert.equal(records[4].category,'内核异常');
});

test('log filtering and context preserve original line numbers and literal search', async () => {
  const {analyzeLog,filterLog,context} = await import('../dist/core.mjs');
  const records=analyzeLog('begin\nusb error [71]\nnext\nwarn: hot\nend');
  assert.deepEqual(filterLog(records,{query:'[71]',level:'error'}).map(x=>x.line),[2]);
  assert.deepEqual(context(records,1,1).map(x=>x.text),['begin','usb error [71]','next']);
  assert.deepEqual(analyzeLog(''),[]);
  assert.equal(analyzeLog('<img onerror=alert(1)>')[0].text,'<img onerror=alert(1)>');
});
