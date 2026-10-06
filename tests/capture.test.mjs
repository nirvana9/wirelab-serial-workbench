import test from 'node:test';
import assert from 'node:assert/strict';

test('split UTF8 RX chunks are decoded without replacement characters',async()=>{
  const {SessionBuffer}=await import('../dist/capture.mjs');
  const capture=new SessionBuffer();
  capture.append(Uint8Array.from([0xe4,0xbd]),'RX');
  capture.append(Uint8Array.from([0xa0,0x0a]),'RX');
  assert.equal(capture.rxText,'你\n');assert.equal(capture.rxBytes,4);
  assert.deepEqual([...capture.records[0].bytes],[0xe4,0xbd]);
});

test('TX does not contaminate RX logs, and record retention keeps recent bytes',async()=>{
  const {SessionBuffer}=await import('../dist/capture.mjs');
  const capture=new SessionBuffer({maxRecords:2});
  capture.append(Uint8Array.from([65]),'RX');capture.append(Uint8Array.from([66]),'TX');capture.append(Uint8Array.from([67]),'RX');
  assert.equal(capture.rxText,'AC');assert.equal(capture.rxBytes,2);assert.equal(capture.txBytes,1);
  assert.equal(capture.records.length,2);assert.equal(capture.records[0].direction,'TX');
});

test('reset discards partial UTF8 and all prior session counters',async()=>{
  const {SessionBuffer}=await import('../dist/capture.mjs');
  const capture=new SessionBuffer();capture.append(Uint8Array.from([0xe4,0xbd]),'RX');capture.reset();
  capture.append(Uint8Array.from([65]),'RX');assert.equal(capture.rxText,'A');assert.equal(capture.rxBytes,1);assert.equal(capture.records.length,1);
});

test('fragmented RX becomes logical text lines for search and export while HEX keeps raw chunks',async()=>{
  const {SessionBuffer}=await import('../dist/capture.mjs');
  const capture=new SessionBuffer();const encode=new TextEncoder();
  capture.append(encode.encode('ER'),'RX');capture.append(encode.encode('ROR: usb failed\nnext'),'RX');
  assert.deepEqual(capture.textRecords.map(r=>r.text),['ERROR: usb failed\n','next']);
  assert.equal(capture.textRecords.filter(r=>r.text.includes('ERROR')).length,1);
  assert.equal(capture.records.length,2);
  assert.equal(capture.textRecords.map(r=>r.text).join(''),'ERROR: usb failed\nnext');
});
