import {parseHex, hex, buildPayload, analyzeLog, filterLog, context, classifyLog, exportLog} from './core.mjs';
import {SerialSession} from './serial.mjs';
import {SessionBuffer} from './capture.mjs';

const $ = id => document.getElementById(id);
const encoder = new TextEncoder();
const capture = new SessionBuffer();
const pageInfo = {
  workspace: ['串口调试工作台', '连接设备，观察数据，让每一条指令都有清晰的回应。', '串口工作台'],
  commands: ['指令工具', '转换字节，保存常用指令，把重复的操作交给工具。', '指令工具'],
  logs: ['日志分析', '从大量输出中筛选异常，沿着上下文找到排查线索。', '日志分析']
};
const demoLog = `[    0.000000] Booting Linux on physical CPU 0x0000000000
[    0.000000] Linux version 6.1.99 (demo-build@wirelab)
[    0.246831] serial: ttyS2 at MMIO 0xfe660000 is a 16550A
[    1.087621] usb 2-1: new high-speed USB device
[    1.152009] usb 2-1: device descriptor read/64, error -71
[    1.243880] usb 2-1: retrying device enumeration
[    1.387241] usb 2-1: USB device detected
[    2.032916] mmc0: new high speed SDHC card at address aaaa
[    2.458721] warning: regulator voltage below expected range
[    3.145210] systemd[1]: Started serial console on ttyS2.
[    3.521006] eth0: Link is Up - 1000Mbps/Full
[    3.862451] application: ready, waiting for command
`;
const builtIns = [
  {name:'AT 应答测试',input:'AT',mode:'text',ending:'crlf',checksum:'none'},
  {name:'HEX 示例帧',input:'AA 55 01 00 FF',mode:'hex',ending:'none',checksum:'none'},
  {name:'Linux 日志命令',input:'dmesg',mode:'text',ending:'lf',checksum:'none'}
];
let commandMode = 'hex';
let terminalMode = 'text';
let paused = false;
let isDemo = true;
let analyzed = [];
let findingsRecords = [];
let renderPending = false;
let findingTimer = null;
let toastTimer = null;
let storageAvailable = true;
let sending = false;

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { storageAvailable = false; return fallback; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { storageAvailable = false; return false; }
}
const storedCommands = readStorage('wirelab.commands.v1', []);
let savedCommands = (Array.isArray(storedCommands) ? storedCommands : []).filter(item =>
  item && typeof item.name === 'string' && typeof item.input === 'string' && ['text','hex'].includes(item.mode) && ['none','cr','lf','crlf'].includes(item.ending) && ['none','sum8','xor8','modbus'].includes(item.checksum)
).slice(0,100);

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function emptyState(container, message) {
  container.replaceChildren(node('div', 'empty-state', message));
}
function showPage(name, updateHash = true) {
  if (!pageInfo[name]) name = 'workspace';
  for (const key of Object.keys(pageInfo)) {
    $(`${key}-page`).hidden = key !== name;
    $(`${key}-page`).classList.toggle('active', key === name);
  }
  for (const button of document.querySelectorAll('[data-page]')) {
    const active = button.dataset.page === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('page-title').replaceChildren(document.createTextNode(pageInfo[name][0]), node('span', 'title-dot', '.'));
  $('page-description').textContent = pageInfo[name][1];
  $('breadcrumb-current').textContent = pageInfo[name][2];
  if (updateHash) location.hash = name;
}
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => showPage(button.dataset.page));
window.addEventListener('hashchange', () => showPage(location.hash.slice(1), false));

function showDialog(title, content) {
  $('dialog-title').textContent = title;
  $('dialog-body').replaceChildren(content);
  if (!$('app-dialog').open) $('app-dialog').showModal();
}
$('dialog-close').addEventListener('click', () => $('app-dialog').close());
$('app-dialog').addEventListener('click', event => { if (event.target === $('app-dialog')) {
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
}});

function showContext(records, index) {
  const record = records[index];
  if (!record) return;
  const box = node('div');
  box.append(node('p', 'dialog-copy', `${record.category} · 第 ${record.line} 行 · 根据日志内容进行规则分级，请结合设备状态判断。`));
  const lines = node('div', 'context-lines');
  for (const item of context(records, index, 4)) {
    const row = node('div', `context-line${item.line === record.line ? ' current' : ''}`);
    row.append(node('span', 'line-number', item.line), node('pre', '', item.text));
    lines.append(row);
  }
  box.append(lines);
  showDialog('日志上下文', box);
}

async function copyText(text) {
  if (!text) return toast('没有可复制的内容');
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
  catch {
    const area = node('textarea'); area.value = text; area.readOnly = true;
    const box = node('div', 'dialog-copy', '浏览器未允许自动复制，请选中下面的内容手动复制。');
    box.append(area); showDialog('复制内容', box); area.select();
  }
}
function download(name, text) {
  if (!text) return toast('没有可导出的内容');
  const url = URL.createObjectURL(new Blob([text], {type:'text/plain;charset=utf-8'}));
  const link = node('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已生成下载文件');
}
function stamp(date) {
  return `${date.toLocaleTimeString('en-GB', {hour12:false})}.${String(date.getMilliseconds()).padStart(3,'0')}`;
}

const serialSupported = 'serial' in navigator && window.isSecureContext;
const session = new SerialSession({
  serial: serialSupported ? navigator.serial : null,
  onState: updateConnectionState,
  onData(bytes) { capture.append(bytes,'RX'); scheduleRender(); },
  onError(error) { toast(`串口异常：${error.message}`, true); }
});
if (!serialSupported) { $('browser-notice').hidden = false; $('connect-button').disabled = true; }

function options() {
  const baudRate = Number($('baud').value === 'custom' ? $('custom-baud').value : $('baud').value);
  if (!Number.isInteger(baudRate) || baudRate < 1 || baudRate > 12000000) throw new Error('波特率需为 1–12000000 的整数，并由硬件驱动支持');
  return {baudRate, dataBits: Number($('data-bits').value), stopBits: Number($('stop-bits').value), parity:$('parity').value, flowControl:$('flow').value};
}
function updateConnectionState(state) {
  const labels = {idle:'未连接',connecting:'选择设备中',connected:'已连接',disconnecting:'断开中'};
  $('stat-status').textContent = labels[state];
  $('connection-badge').textContent = labels[state];
  $('connection-badge').className = `badge ${state === 'connected' ? 'mint-badge' : 'neutral'}`;
  $('connect-button').querySelector('span').textContent = state === 'connected' ? '断开串口' : state === 'connecting' ? '等待授权…' : state === 'disconnecting' ? '断开中…' : '连接串口';
  $('connect-button').disabled = !serialSupported || ['connecting','disconnecting'].includes(state);
  for (const id of ['baud','custom-baud','data-bits','stop-bits','parity','flow']) $(id).disabled = state !== 'idle';
  $('terminal-indicator').classList.toggle('connected', state === 'connected');
  if (state === 'connected') {
    resetCapture(false);
    const config = options();
    const info = session.port.getInfo();
    const deviceId = info.usbVendorId !== undefined ? `USB ${info.usbVendorId.toString(16).padStart(4,'0').toUpperCase()}:${(info.usbProductId || 0).toString(16).padStart(4,'0').toUpperCase()}` : '串口设备';
    $('device-name').textContent = deviceId;
    $('device-detail').textContent = `${config.baudRate} bps · ${config.dataBits}${config.parity === 'none' ? 'N' : config.parity === 'even' ? 'E' : 'O'}${config.stopBits}`;
    $('stat-config').textContent = `${config.baudRate} bps`;
    writeStorage('wirelab.settings.v1', {baud:$('baud').value,custom:$('custom-baud').value,dataBits:$('data-bits').value,stopBits:$('stop-bits').value,parity:$('parity').value,flow:$('flow').value});
    toast('串口已连接，可以发送指令');
  } else if (state === 'idle') {
    $('device-name').textContent = '选择你的串口设备';
    $('device-detail').textContent = 'USB 转串口 / 开发板 / MCU';
    $('stat-config').textContent = '等待选择串口';
  }
  $('terminal-state').textContent = state === 'connected' ? '串口已连接 · 正在接收' : isDemo ? '未连接 · 示例仅供体验' : state === 'idle' ? '串口已断开 · 会话数据保留' : labels[state];
  updatePayload();
}
$('baud').addEventListener('change', () => { $('custom-baud').hidden = $('baud').value !== 'custom'; });
$('connect-button').addEventListener('click', async () => {
  $('connect-error').hidden = true;
  try {
    if (session.state === 'connected') await session.disconnect();
    else await session.connect(options());
  } catch (error) {
    if (error.name === 'NotFoundError') return toast('已取消设备选择');
    $('connect-error').textContent = `连接失败：${error.message}。请检查串口占用、权限和参数。`;
    $('connect-error').hidden = false;
  }
});

function resetCapture(demo) {
  isDemo = demo; capture.reset(); paused = false;
  $('pause-button').textContent = 'Ⅱ 暂停';
  $('terminal-source').textContent = demo ? '示例数据' : '真实会话';
  $('terminal-source').classList.toggle('demo', demo);
  renderTerminal(); renderSessionFindings();
}
function loadDemo(notify = true) {
  if (session.state !== 'idle') return toast('请先断开真实串口，再体验示例会话');
  resetCapture(true);
  demoLog.trimEnd().split('\n').forEach((line,index) => capture.append(encoder.encode(`${line}\n`),'RX',new Date(2026,9,6,10,18,20,index*46)));
  $('terminal-state').textContent = '未连接 · 示例仅供体验';
  renderTerminal(); renderSessionFindings();
  if (notify) toast('已载入示例；未连接或操作任何真实设备');
}
$('demo-button').addEventListener('click', () => { showPage('workspace'); loadDemo(); });
function scheduleRender() {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; renderTerminal(); });
  }
  if (findingTimer === null) findingTimer = setTimeout(() => { findingTimer = null; renderSessionFindings(); }, 500);
}
function renderTerminal() {
  $('rx-count').textContent = capture.rxBytes.toLocaleString();
  $('tx-count').textContent = capture.txBytes.toLocaleString();
  document.querySelectorAll('.stat-card .stat-caption')[1].textContent = isDemo ? '示例 RX' : 'RX';
  document.querySelectorAll('.stat-card .stat-caption')[2].textContent = isDemo ? '示例 TX' : 'TX';
  const available = terminalMode === 'hex' ? capture.records : capture.textRecords;
  $('terminal-line-count').textContent = available.length.toLocaleString();
  if (paused) return;
  const search = $('terminal-search').value.toLowerCase();
  const records = available.filter(record => {
    const value = terminalMode === 'hex' ? hex(record.bytes) : record.text;
    return !search || value.toLowerCase().includes(search);
  }).slice(-1000);
  if (!records.length) return emptyState($('terminal-lines'), search ? '没有匹配的收发记录' : '连接串口后，收到的数据将显示在这里。');
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const level = record.direction === 'RX' ? classifyLog(record.text).level : '';
    const row = node('div', `terminal-row ${record.direction.toLowerCase()} ${level}`);
    const value = terminalMode === 'hex' ? hex(record.bytes) : record.text.replace(/\r/g,'').replace(/\x1b\[[0-9;]*m/g,'').replace(/\n$/,'');
    row.append(node('span','terminal-time',stamp(record.time)),node('span','terminal-dir',record.direction),node('pre','',value || ' '));
    fragment.append(row);
  }
  $('terminal-lines').replaceChildren(fragment);
  if ($('auto-scroll').checked) $('terminal-lines').scrollTop = $('terminal-lines').scrollHeight;
}
function renderSessionFindings() {
  // Keep continuously refreshed rule scans bounded; the analysis page scans the complete retained RX text.
  const recent = capture.rxText.slice(-200000).split('\n').slice(-2000).join('\n');
  findingsRecords = analyzeLog(recent);
  const issues = findingsRecords.filter(record => record.level !== 'info');
  $('issue-count').textContent = issues.length.toLocaleString();
  document.querySelectorAll('.stat-card .stat-caption')[3].textContent = '近期日志';
  if (!issues.length) return emptyState($('session-findings'),'近期日志中未匹配到错误或警告。');
  const fragment = document.createDocumentFragment();
  for (const record of issues.slice(-2)) {
    const button = node('button', `finding ${record.level}`);
    const summary = node('div'); summary.append(node('strong','',record.category),node('code','',record.text));
    button.append(node('span','',record.level === 'error' ? '!' : '△'),summary,node('span','',isDemo ? '示例' : '上下文 ↗'));
    button.addEventListener('click', () => { const snapshot = [...findingsRecords]; showContext(snapshot,snapshot.indexOf(record)); });
    fragment.append(button);
  }
  $('session-findings').replaceChildren(fragment);
}
$('terminal-search').addEventListener('input', renderTerminal);
$('auto-scroll').addEventListener('change', renderTerminal);
function setTerminalMode(mode) {
  terminalMode = mode;
  for (const key of ['text','hex']) { $(`view-${key}`).classList.toggle('selected', key === mode); $(`view-${key}`).setAttribute('aria-pressed',String(key === mode)); }
  renderTerminal();
}
$('view-text').addEventListener('click', () => setTerminalMode('text'));
$('view-hex').addEventListener('click', () => setTerminalMode('hex'));
$('pause-button').addEventListener('click', () => { paused = !paused; $('pause-button').textContent = paused ? '▶ 继续' : 'Ⅱ 暂停'; renderTerminal(); });
$('clear-terminal').addEventListener('click', () => { capture.reset(); paused = false; $('pause-button').textContent = 'Ⅱ 暂停'; renderTerminal(); renderSessionFindings(); toast('已清空终端数据与计数'); });
$('export-terminal').addEventListener('click', () => {
  const records = terminalMode === 'hex' ? capture.records : capture.textRecords;
  download(`wirelab-${isDemo?'demo':'serial'}-${Date.now()}.log`,records.map(record => `[${stamp(record.time)}] [${record.direction}] ${terminalMode === 'hex' ? hex(record.bytes) : record.text.replace(/\r/g,'').replace(/\n$/,'')}`).join('\n'));
});

function commandOptions() { return {mode:commandMode,ending:$('ending').value,checksum:$('checksum').value}; }
function updatePayload() {
  let valid = false;
  try {
    const bytes = buildPayload($('command-input').value, commandOptions());
    $('payload-hex').textContent = hex(bytes);
    $('payload-size').textContent = `${bytes.length.toLocaleString()} 字节`;
    $('command-error').hidden = true; valid = true;
  } catch (error) {
    $('payload-hex').textContent = '等待有效指令'; $('payload-size').textContent = '0 字节';
    $('command-error').textContent = error.message; $('command-error').hidden = !$('command-input').value;
  }
  $('checksum-hint').hidden = $('checksum').value === 'none';
  $('send-button').disabled = !valid || session.state !== 'connected' || sending;
}
function setCommandMode(mode) {
  commandMode = mode;
  for (const key of ['hex','text']) { $(`mode-${key}`).classList.toggle('selected', key === mode); $(`mode-${key}`).setAttribute('aria-pressed',String(key === mode)); }
  $('command-input').placeholder = mode === 'hex' ? '例如 AA 55 01 00 FF' : '例如 AT 或 Linux shell 命令';
  updatePayload();
}
for (const key of ['hex','text']) $(`mode-${key}`).addEventListener('click', () => setCommandMode(key));
for (const id of ['command-input','ending','checksum']) $(id).addEventListener(id === 'command-input' ? 'input' : 'change',updatePayload);
async function sendCommand() {
  if (sending) return;
  if (session.state !== 'connected') return toast('请先连接串口');
  try {
    const bytes = buildPayload($('command-input').value, commandOptions());
    sending = true; updatePayload();
    await session.send(bytes); capture.append(bytes,'TX'); scheduleRender();
    toast(`已发送 ${bytes.length} 字节`);
  } catch (error) { toast(`发送失败：${error.message}`,true); }
  finally { sending = false; updatePayload(); }
}
$('send-button').addEventListener('click',sendCommand);
$('command-input').addEventListener('keydown',event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); sendCommand(); } });
$('copy-command').addEventListener('click', () => { try { copyText(hex(buildPayload($('command-input').value,commandOptions()))); } catch(error) { toast(error.message,true); } });

function loadCommand(command) {
  showPage('workspace'); $('command-input').value = command.input; $('ending').value = command.ending; $('checksum').value = command.checksum;
  setCommandMode(command.mode); $('command-input').focus(); toast(`已载入“${command.name}”，点击发送前请检查设备协议`);
}
function renderPresets() {
  const available = [...savedCommands,...builtIns];
  const fragment = document.createDocumentFragment();
  available.slice(0,3).forEach((command,index) => {
    const button = node('button','preset-item'); const content = node('span','preset-content');
    content.append(node('span','preset-name',command.name),node('code','',command.input));
    button.append(node('span','preset-number',String(index+1).padStart(2,'0')),content,node('span','preset-arrow','↗'));
    button.addEventListener('click',()=>loadCommand(command)); fragment.append(button);
  });
  $('preset-list').replaceChildren(fragment); $('saved-count').textContent = `${savedCommands.length} 条`;
  if (!savedCommands.length) return emptyState($('saved-commands'),'还没有保存指令。在工作台编辑后，点击“保存指令”即可添加。');
  const list = document.createDocumentFragment();
  savedCommands.forEach((command,index) => {
    const row = node('div','saved-item'); const content = node('div'); content.append(node('strong','',command.name),node('code','',`${command.mode.toUpperCase()} · ${command.input}`));
    const load = node('button','text-button','载入 ↗'); load.addEventListener('click',()=>loadCommand(command));
    const remove = node('button','text-button delete-command','删除'); remove.setAttribute('aria-label',`删除指令 ${command.name}`);
    remove.addEventListener('click',()=>{savedCommands.splice(index,1);const persisted=writeStorage('wirelab.commands.v1',savedCommands);renderPresets();toast(persisted?'已删除指令':'已从当前会话删除，浏览器无法保存更改');});
    row.append(content,load,remove); list.append(row);
  });
  $('saved-commands').replaceChildren(list);
}
$('save-command').addEventListener('click', () => {
  let command;
  try { buildPayload($('command-input').value,commandOptions()); command = {...commandOptions(),input:$('command-input').value}; }
  catch(error) { return toast(error.message,true); }
  if(savedCommands.length >= 100) return toast('指令库最多保存 100 条，请先删除不需要的指令');
  const form=node('form','dialog-form'); const label=node('label','','指令名称'); label.htmlFor='preset-name';
  const input=node('input'); input.id='preset-name'; input.required=true; input.maxLength=50; input.placeholder='例如：读取设备版本';
  const hint=node('p','muted','保存在当前浏览器，不会同步或上传。'); const submit=node('button','button primary','保存指令');submit.type='submit';
  form.append(label,input,hint,submit);
  form.addEventListener('submit',event=>{event.preventDefault();if(!input.value.trim())return; savedCommands.unshift({...command,name:input.value.trim()});const persisted=writeStorage('wirelab.commands.v1',savedCommands);renderPresets();$('app-dialog').close();toast(persisted?'指令已保存':'浏览器存储不可用，指令仅在当前会话保留');});
  showDialog('保存常用指令',form);input.focus();
});
$('manage-presets').addEventListener('click',()=>showPage('commands'));
$('text-to-hex').addEventListener('click',()=>{const value=$('convert-input').value;if(!value)return toast('请输入文本');$('convert-output').value=hex(encoder.encode(value));});
$('hex-to-text').addEventListener('click',()=>{try{$('convert-output').value=new TextDecoder('utf-8',{fatal:true}).decode(parseHex($('convert-input').value));}catch(error){toast(`转换失败：${error.message}`,true);}});
$('copy-conversion').addEventListener('click',()=>copyText($('convert-output').value));

function runAnalysis() {
  if (encoder.encode($('log-input').value).length > 10 * 1024 * 1024) return toast('日志超过 10 MiB，请先截取相关片段',true);
  analyzed = analyzeLog($('log-input').value);
  $('log-total').textContent = analyzed.length.toLocaleString();
  for(const level of ['error','warning','info']) $(level === 'error' ? 'log-errors' : level === 'warning' ? 'log-warnings' : 'log-info').textContent=analyzed.filter(record=>record.level===level).length.toLocaleString();
  renderAnalysis();
  if(!analyzed.length)toast('请先导入或粘贴日志');
}
function renderAnalysis() {
  const filtered=filterLog(analyzed,{query:$('log-search').value,level:$('log-level').value});
  $('log-matched').textContent=`匹配 ${filtered.length.toLocaleString()} / ${analyzed.length.toLocaleString()} 行`;
  $('log-more').hidden=filtered.length<=1000;
  if(!filtered.length)return emptyState($('log-results'),analyzed.length?'没有符合当前条件的日志':'导入日志后，分析结果将显示在这里。');
  const fragment=document.createDocumentFragment();
  for(const record of filtered.slice(0,1000)) {
    const row=node('button',`log-row ${record.level}`);row.title=`${record.category} · 查看第 ${record.line} 行上下文`;
    row.append(node('span','line-number',record.line),node('span','level-tag',record.level==='error'?'ERR':record.level==='warning'?'WARN':'INFO'),node('code','',record.text||' '));
    row.addEventListener('click',()=>showContext(analyzed,record.line-1));fragment.append(row);
  }
  $('log-results').replaceChildren(fragment);
}
$('analyze-log').addEventListener('click',runAnalysis);
$('log-search').addEventListener('input',renderAnalysis);
$('log-level').addEventListener('change',renderAnalysis);
$('log-file').addEventListener('change',async()=>{
  const file=$('log-file').files[0];if(!file)return;
  try {
    if(file.size>10*1024*1024)throw new Error('文件超过 10 MiB，请截取相关片段');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
    $('log-input').value=text;$('log-source-name').textContent=file.name;runAnalysis();toast(`已导入 ${file.name}`);
  }catch(error){toast(`导入失败：${error.message}`,true);}finally{$('log-file').value='';}
});
$('load-demo-log').addEventListener('click',()=>{$('log-input').value=demoLog;$('log-source-name').textContent='示例日志';runAnalysis();});
$('analyze-session').addEventListener('click',()=>{
  showPage('logs');$('log-input').value=capture.rxText;$('log-source-name').textContent=isDemo?'示例会话':'当前接收会话';$('log-level').value='all';$('log-search').value='';runAnalysis();
});
$('export-analysis').addEventListener('click',()=>download(`wirelab-filtered-${Date.now()}.log`,exportLog(filterLog(analyzed,{query:$('log-search').value,level:$('log-level').value}))));
$('help-button').addEventListener('click',()=>{
  const box=node('div','dialog-copy');
  const sections=[
    ['连接设备','在电脑端 Chrome 打开此网站，插入 USB 转串口或开发板。设置与设备一致的波特率、数据位、校验位和停止位，点击“连接串口”选择并授权设备。Linux 上需要串口访问权限；同一串口不能同时被其他工具占用。'],
    ['收发指令','HEX 模式按两位一个字节输入；文本按 UTF-8 编码。发送预览显示实际字节，包含追加校验和行尾。快捷指令只会填入编辑器，点击“发送指令”才会写入设备。自定义波特率是否可用取决于设备和驱动。'],
    ['观察数据','暂停只冻结终端显示，接收仍然继续。终端保留最近 10000 条收发记录，每次最多显示 1000 条。切换 HEX 可查看完整原始字节；复制或导出可保留当前数据。'],
    ['分析日志','导入 UTF-8 文件或粘贴日志，按关键词和等级筛选，点击一行查看前后 4 行。实时异常线索检查近期最多 2000 行/200000 字符；“分析完整日志”分析当前保留的接收文本。规则命中不代表确定根因。'],
    ['数据保存','指令库和连接参数只保存在本浏览器，日志不会上传。接收文本最多保留约 1000 万个字符，超过后保留最新内容。页面刷新、关闭或重新连接会清除当前会话；需要保留时请先导出。']
  ];
  for(const [title,text] of sections)box.append(node('h3','',title),node('p','',text));
  const link=node('a','','Web Serial 官方使用说明');link.href='https://developer.chrome.com/docs/capabilities/serial';link.target='_blank';link.rel='noopener noreferrer';box.append(link);
  showDialog('使用指南',box);
});

const preferences=readStorage('wirelab.settings.v1',{});
if(preferences && typeof preferences==='object') {
  const fields={baud:'baud',custom:'custom-baud',dataBits:'data-bits',stopBits:'stop-bits',parity:'parity',flow:'flow'};
  for(const [key,id] of Object.entries(fields)) {
    const value=String(preferences[key]??'');
    if(id==='custom-baud') { if(/^\d+$/.test(value)&&Number(value)>0&&Number(value)<=12000000)$(id).value=value; }
    else if([...$(id).options].some(option=>option.value===value))$(id).value=value;
  }
}
$('custom-baud').hidden=$('baud').value!=='custom';
renderPresets(); updatePayload(); renderAnalysis(); loadDemo(false); showPage(location.hash.slice(1)||'workspace',false);
if(!storageAvailable)toast('浏览器存储不可用，保存的指令仅在当前会话保留');
