import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick, setTimeout as delay} from 'node:timers/promises';

function hardware({openError,writeError}={}) {
  const writes=[],events=[];
  let receiver;
  const port = {
    readable: new ReadableStream({start(controller){receiver=controller;},cancel(){events.push('read-cancel');}}),
    writable: new WritableStream({write(bytes){if(writeError)throw writeError;writes.push([...bytes]);events.push('write');}}),
    async open(options){if(openError)throw openError;port.options=options;events.push('open');},
    async close(){assert.equal(port.readable.locked,false);assert.equal(port.writable.locked,false);events.push('close');},
    getInfo(){return {usbVendorId:0x1a86,usbProductId:0x7523};}
  };
  const serial=new EventTarget();serial.requestPort=async()=>port;
  return {port,serial,writes,events,receive:bytes=>receiver.enqueue(Uint8Array.from(bytes)),failRead:error=>receiver.error(error)};
}

test('real streams carry TX/RX bytes and disconnect releases locks before close', async()=>{
  const {SerialSession}=await import('../dist/serial.mjs');
  const h=hardware(),received=[],states=[];
  const session=new SerialSession({serial:h.serial,onData:b=>received.push([...b]),onState:s=>states.push(s)});
  await session.connect({baudRate:1500000,dataBits:8,stopBits:1,parity:'none',flowControl:'none'});
  assert.equal(h.port.options.baudRate,1500000);
  await session.send(Uint8Array.from([0xaa,0x55]));
  h.receive([0x01,0x02]);await tick();
  assert.deepEqual(h.writes,[[170,85]]);assert.deepEqual(received,[[1,2]]);
  await session.disconnect();
  assert.equal(session.state,'idle');assert.equal(session.port,null);
  assert.deepEqual(states,['connecting','connected','disconnecting','idle']);
  assert.ok(h.events.indexOf('read-cancel')<h.events.indexOf('close'));
});

test('canceled picker and open failure return to idle',async()=>{
  const {SerialSession}=await import('../dist/serial.mjs');
  const serial={requestPort:async()=>{throw new DOMException('cancel','NotFoundError');}};
  const session=new SerialSession({serial});
  await assert.rejects(session.connect({baudRate:115200}));assert.equal(session.state,'idle');
  const h=hardware({openError:new Error('busy')});
  const second=new SerialSession({serial:h.serial});
  await assert.rejects(second.connect({baudRate:115200}),/busy/);assert.equal(second.port,null);assert.equal(second.state,'idle');
});

test('disconnected send is rejected, writes keep submission order, close waits for writes',async()=>{
  const {SerialSession}=await import('../dist/serial.mjs');
  const h=hardware();const session=new SerialSession({serial:h.serial});
  await assert.rejects(session.send(Uint8Array.from([1])));
  await session.connect({baudRate:115200});
  const first=session.send(Uint8Array.from([1])),second=session.send(Uint8Array.from([2]));
  await session.disconnect();await Promise.all([first,second]);
  assert.deepEqual(h.writes,[[1],[2]]);assert.equal(h.events.at(-1),'close');
});

test('write failure is reported and stream lock is released',async()=>{
  const {SerialSession}=await import('../dist/serial.mjs');
  const h=hardware({writeError:new Error('write fault')}),errors=[];
  const session=new SerialSession({serial:h.serial,onError:e=>errors.push(e.message)});
  await session.connect({baudRate:115200});
  await assert.rejects(session.send(Uint8Array.from([1])),/write fault/);
  assert.equal(h.port.writable.locked,false);assert.deepEqual(errors,['write fault']);
  await session.disconnect();
});

test('fatal read failure cleans up the connection instead of leaving a connected UI',async()=>{
  const {SerialSession}=await import('../dist/serial.mjs');
  const h=hardware(),errors=[];
  const session=new SerialSession({serial:h.serial,onError:e=>errors.push(e.message)});
  await session.connect({baudRate:115200});h.failRead(new Error('unplugged'));
  for(let i=0;i<4;i++)await tick();
  assert.equal(session.state,'idle');assert.equal(session.port,null);assert.deepEqual(errors,['unplugged']);
});

test('disconnect aborts a flow-control-blocked writer after grace period and releases both locks',async()=>{
  const {SerialSession}=await import('../dist/serial.mjs');const h=hardware();let forceFinish;
  h.port.writable=new WritableStream({write(bytes,controller){return new Promise((resolve,reject)=>{forceFinish=resolve;controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});});}});
  const session=new SerialSession({serial:h.serial,closeGraceMs:10});await session.connect({baudRate:115200});
  const sent=session.send(Uint8Array.from([1])).then(()=>null,error=>error);await tick();
  const closing=session.disconnect();
  const recovered=await Promise.race([closing.then(()=>true),delay(100,false)]);
  if(!recovered){forceFinish();await closing;}
  const error=await sent;
  assert.equal(recovered,true,'disconnect should cancel the blocked write');
  assert.equal(error?.name,'AbortError');assert.equal(session.state,'idle');
  assert.equal(h.port.readable.locked,false);assert.equal(h.port.writable.locked,false);
});
