export function parseHex(input) {
  const raw = input.trim();
  if (!raw) throw new Error('请输入指令内容');
  const tokens = raw.split(/[\s,:]+/).filter(Boolean).map(token => token.replace(/^0x/i, ''));
  if (!tokens.length || tokens.some(token => !/^[0-9a-f]+$/i.test(token))) throw new Error('HEX 仅支持 0–9、A–F，可使用空格、逗号或冒号分隔');
  if (tokens.some(token => token.length % 2)) throw new Error('HEX 每个字节需要两位，请检查每段输入');
  const compact = tokens.join('');
  if (compact.length > 131072) throw new Error('单条指令最多 64 KiB');
  return Uint8Array.from(compact.match(/../g), value => parseInt(value, 16));
}

export function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function buildPayload(input, {mode = 'hex', ending = 'none', checksum = 'none'} = {}) {
  if (!input.length || !input.trim()) throw new Error('请输入指令内容');
  if (!['hex','text'].includes(mode)) throw new Error('未知输入格式');
  const body = mode === 'hex' ? parseHex(input) : new TextEncoder().encode(input);
  if (body.length > 65536) throw new Error('单条指令最多 64 KiB');
  const suffix = [];
  if (checksum === 'sum8') suffix.push(body.reduce((sum, value) => (sum + value) & 255, 0));
  else if (checksum === 'xor8') suffix.push(body.reduce((xor, value) => xor ^ value, 0));
  else if (checksum === 'modbus') {
    let crc = 0xffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    suffix.push(crc & 255, crc >>> 8);
  } else if (checksum !== 'none') throw new Error('未知校验方式');
  const endings = {none: [], cr: [13], lf: [10], crlf: [13,10]};
  if (!(ending in endings)) throw new Error('未知行尾方式');
  return Uint8Array.from([...body, ...suffix, ...endings[ending]]);
}

export function classifyLog(text) {
  const normalized = text.replace(/\x1b\[[0-9;]*m/g, '');
  const negativeSummary = /\b(?:0|no|zero)\s+(?:errors?|failures?)\b|\b(?:errors?|failures?)\s*[:=]\s*0\b/i.test(normalized);
  const severe = /\b(?:panic|oops|BUG|fatal|exception|segfault)\b|out of memory|oom[-_ ]killer/i.test(normalized);
  const error = /\b(?:error|failed|failure|fail|timeout|timed out|denied|unable)\b|错误|失败|超时/i.test(normalized);
  const warning = /\b(?:warn|warning)\b|警告/i.test(normalized);
  let level = severe || (error && !negativeSummary) ? 'error' : warning ? 'warning' : 'info';
  // Android logcat's explicit severity takes precedence over message keywords.
  const logcat = normalized.match(/^\s*(?:\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([VDIWEF])\s/);
  if (logcat) level = ['E','F'].includes(logcat[1]) ? 'error' : logcat[1] === 'W' ? 'warning' : 'info';
  let category = '一般日志';
  if (level !== 'info') {
    if (/panic|oops|\bBUG\b|segfault/i.test(normalized)) category = '内核异常';
    else if (/out of memory|oom|allocation failed/i.test(normalized)) category = '内存异常';
    else if (/usb|xhci|ehci|enumerat/i.test(normalized)) category = 'USB / 设备枚举';
    else if (/uart|serial|tty|baud/i.test(normalized)) category = '串口通信';
    else if (/mmc|nvme|ext4|i\/o error|filesystem/i.test(normalized)) category = '存储 / 文件系统';
    else if (/network|eth\d|wlan|wifi|dhcp|link down/i.test(normalized)) category = '网络连接';
    else if (/timeout|timed out|超时/i.test(normalized)) category = '响应超时';
    else category = level === 'warning' ? '警告提示' : '错误提示';
  }
  return {level, category};
}

export function analyzeLog(text) {
  if (!text.length) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, index) => ({line: index + 1, text, ...classifyLog(text)}));
}

export function filterLog(records, {query = '', level = 'all'} = {}) {
  const needle = query.toLocaleLowerCase();
  return records.filter(record => (level === 'all' || record.level === level) && (!needle || record.text.toLocaleLowerCase().includes(needle)));
}

export function context(records, index, radius = 3) {
  return records.slice(Math.max(0, index - radius), Math.min(records.length, index + radius + 1));
}

export function exportLog(records) {
  return records.map(record => record.text).join('\n');
}
