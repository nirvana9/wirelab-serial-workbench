export class SerialSession {
  constructor({serial, onState = () => {}, onData = () => {}, onError = () => {}, closeGraceMs = 2000}) {
    this.serial = serial;
    this.onState = onState;
    this.onData = onData;
    this.onError = onError;
    this.state = 'idle';
    this.port = null;
    this.reader = null;
    this.readTask = null;
    this.writeQueue = Promise.resolve();
    this.closeTask = null;
    this.running = false;
    this.activeWriter = null;
    this.cancelWrites = false;
    this.closeGraceMs = closeGraceMs;
  }

  setState(state) { this.state = state; this.onState(state); }

  async connect(options) {
    if (this.state !== 'idle') throw new Error('当前串口正在连接或已连接');
    if (!this.serial) throw new Error('当前浏览器不支持网页串口，请使用电脑端 Chrome');
    this.setState('connecting');
    try {
      const port = await this.serial.requestPort();
      await port.open(options);
      this.port = port;
      this.running = true;
      this.writeQueue = Promise.resolve();
      this.cancelWrites = false;
      this.setState('connected');
      this.readTask = this.readLoop();
    } catch (error) {
      this.port = null;
      this.running = false;
      this.setState('idle');
      throw error;
    }
  }

  async readLoop() {
    try {
      if (!this.port.readable) throw new Error('串口没有可读数据流');
      this.reader = this.port.readable.getReader();
      while (this.running) {
        const {value, done} = await this.reader.read();
        if (done) break;
        if (value?.length) this.onData(value);
      }
    } catch (error) {
      if (this.running) this.onError(error);
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      if (this.running) queueMicrotask(() => this.disconnect().catch(error => this.onError(error)));
    }
  }

  send(bytes) {
    if (this.state !== 'connected' || !this.port?.writable) return Promise.reject(new Error('请先连接串口'));
    const port = this.port;
    const copy = Uint8Array.from(bytes);
    const write = this.writeQueue.then(async () => {
      if (this.cancelWrites) throw new DOMException('连接关闭，发送已取消', 'AbortError');
      const writer = port.writable.getWriter();
      this.activeWriter = writer;
      try { await writer.write(copy); }
      finally { writer.releaseLock(); this.activeWriter = null; }
    });
    this.writeQueue = write.catch(() => {});
    return write.catch(error => { if (!(this.cancelWrites && error.name === 'AbortError')) this.onError(error); throw error; });
  }

  disconnect() {
    if (this.closeTask) return this.closeTask;
    if (!this.port) return Promise.resolve();
    this.setState('disconnecting');
    this.running = false;
    this.closeTask = this.close().finally(() => { this.closeTask = null; });
    return this.closeTask;
  }

  async close() {
    try {
      const readDone = (async () => {
        if (this.reader) {
          try { await this.reader.cancel(); } catch { /* A removed device may already have errored its reader. */ }
        }
        await this.readTask;
      })();
      let timer;
      const drained = await Promise.race([
        this.writeQueue.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), this.closeGraceMs); })
      ]);
      clearTimeout(timer);
      if (!drained) {
        this.cancelWrites = true;
        // Web Serial's sink listens to this abort signal to interrupt blocked OS writes.
        await this.activeWriter?.abort(new DOMException('连接关闭，发送已取消；部分字节可能已发出', 'AbortError')).catch(() => {});
      }
      await this.writeQueue;
      await readDone;
      await this.port.close();
    } finally {
      this.port = null;
      this.reader = null;
      this.readTask = null;
      this.setState('idle');
    }
  }
}
