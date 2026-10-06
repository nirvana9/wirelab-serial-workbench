export class SessionBuffer {
  constructor({maxRecords = 10000, maxText = 10 * 1024 * 1024} = {}) {
    this.maxRecords = maxRecords;
    this.maxText = maxText;
    this.reset();
  }
  reset() {
    this.records = [];
    this.textRecords = [];
    this.pendingRecord = null;
    this.rxBytes = 0;
    this.txBytes = 0;
    this.rxText = '';
    this.decoder = new TextDecoder('utf-8');
  }
  append(bytes, direction, time = new Date()) {
    const copy = Uint8Array.from(bytes);
    const text = direction === 'RX' ? this.decoder.decode(copy, {stream: true}) : new TextDecoder().decode(copy);
    if (direction === 'RX') {
      this.rxBytes += copy.length;
      this.rxText = (this.rxText + text).slice(-this.maxText);
      const pieces = text.split(/(?<=\n)/);
      for (const piece of pieces) {
        if (!piece) continue;
        if (!this.pendingRecord) {
          this.pendingRecord = {text: '', direction, time};
          this.textRecords.push(this.pendingRecord);
        }
        this.pendingRecord.text += piece;
        if (piece.endsWith('\n')) this.pendingRecord = null;
      }
    } else {
      this.txBytes += copy.length;
      this.textRecords.push({text, direction, time});
    }
    this.records.push({bytes: copy, text, direction, time});
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    if (this.textRecords.length > this.maxRecords) this.textRecords.splice(0, this.textRecords.length - this.maxRecords);
    if (this.pendingRecord && !this.textRecords.includes(this.pendingRecord)) this.pendingRecord = null;
    return this.records.at(-1);
  }
}
