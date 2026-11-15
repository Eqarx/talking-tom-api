import { RelayClient, MODEL } from './sdk.js';
import { MODELS, MODEL_NAME, CHARACTER_PRICE_CENTS, CATALOG_CHECKED_AT, findModel } from './catalog.js';

const $ = selector => document.querySelector(selector);
const client = new RelayClient();
const base = new URL('./', location.href);
const money = cents => `$${(cents / 100).toFixed(2)}`;
let busy = false;
let toastTimer;
let creditTimer;
let history = [];
let activeCode = 'sdk';
let workerReady = false;
let apiBusy = false;
let selectedProvider = 'all';
let dialogModel;

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

function route() {
  const hash = location.hash.slice(1);
  const page = hash === 'composer' ? 'playground' : ['playground', 'docs', 'pricing'].includes(hash) ? hash : 'models';
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `view-${page}`; });
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.classList.toggle('active', link.dataset.nav === page);
    if (link.dataset.nav === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#breadcrumb-title').textContent = { models: '模型广场', playground: '在线调试', docs: 'API 接入', pricing: '账单与余额' }[page];
  if (location.hash === '#composer') requestAnimationFrame(() => { $('#composer').focus(); $('#composer').scrollIntoView({ block: 'center' }); });
}
window.addEventListener('hashchange', route);
route();

function modelCard(model) {
  const article = document.createElement('article');
  article.className = `model-card${model.available ? ' featured' : ''}`;
  article.innerHTML = `<div class="card-main"><div class="card-top"><span class="provider-mark"></span><span class="status"><span class="status-dot"></span><span class="status-text"></span></span></div><h3></h3><div class="model-id"></div><p class="card-description"></p><div class="model-tags"></div><div class="card-specs"><div><span>调用价格</span><strong class="card-price"></strong><span class="price-unit"></span></div><div><span>上下文</span><strong class="card-context"></strong></div></div></div><div class="card-bottom"><span class="channel-label"></span><button type="button" class="detail-button">模型详情 ↗</button><button type="button" class="card-use"></button></div>`;
  const field = selector => article.querySelector(selector);
  field('.provider-mark').textContent = model.mark;
  field('.provider-mark').classList.toggle('relay', model.provider === 'Relay');
  field('.status').classList.add(model.available ? 'available' : 'unavailable');
  field('.status-text').textContent = model.available ? 'API 可用' : 'API 不可用';
  field('h3').textContent = model.name;
  field('.model-id').textContent = model.id;
  field('.card-description').textContent = model.description;
  model.tags.forEach(tag => { const element = document.createElement('span'); element.textContent = tag; field('.model-tags').append(element); });
  field('.card-price').textContent = model.available ? '−$0.01' : '—';
  field('.card-price').classList.toggle('local-price', model.available);
  field('.price-unit').textContent = model.available ? 'USD / 输出字符' : '尚未开放计费';
  field('.card-context').textContent = model.context;
  field('.channel-label').textContent = model.provider;
  field('.detail-button').dataset.detail = model.id;
  field('.detail-button').setAttribute('aria-label', `查看 ${model.name} 模型详情`);
  field('.card-use').textContent = model.available ? '在线调试' : '暂无渠道';
  field('.card-use').disabled = !model.available;
  field('.card-use').classList.toggle('live', model.available);
  field('.card-use').dataset.useModel = model.id;
  return article;
}

function renderCatalog() {
  const query = $('#model-search').value.trim().toLowerCase();
  const models = MODELS.filter(model => (selectedProvider === 'all' || model.provider === selectedProvider) && (!$('#available-only').checked || model.available) && `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query));
  $('#model-grid').replaceChildren(...models.map(modelCard));
  $('#catalog-empty').hidden = models.length > 0;
  $('#catalog-count').textContent = models.length;
  document.querySelectorAll('[data-provider]').forEach(button => {
    button.classList.toggle('selected', button.dataset.provider === selectedProvider);
    button.setAttribute('aria-pressed', String(button.dataset.provider === selectedProvider));
  });
}

const available = MODELS.filter(model => model.available).length;
document.querySelectorAll('[data-available]').forEach(element => { element.textContent = available; });
document.querySelectorAll('[data-unavailable]').forEach(element => { element.textContent = MODELS.length - available; });
document.querySelectorAll('[data-total]').forEach(element => { element.textContent = MODELS.length; });
$('#catalog-date').textContent = CATALOG_CHECKED_AT;
$('#catalog-count').setAttribute('aria-live', 'polite');
document.querySelectorAll('[data-provider]').forEach(button => button.addEventListener('click', () => { selectedProvider = button.dataset.provider; renderCatalog(); }));
$('#model-search').addEventListener('input', renderCatalog);
$('#available-only').addEventListener('change', renderCatalog);
$('#reset-filters').addEventListener('click', () => { selectedProvider = 'all'; $('#model-search').value = ''; $('#available-only').checked = false; renderCatalog(); });
$('#model-grid').addEventListener('click', event => {
  const detail = event.target.closest('[data-detail]');
  if (detail) openModel(detail.dataset.detail);
  if (event.target.closest('[data-use-model]')) location.hash = 'playground';
});

function openModel(id) {
  dialogModel = findModel(id);
  if (!dialogModel) return;
  $('#dialog-provider').textContent = dialogModel.provider;
  $('#dialog-model-name').textContent = dialogModel.name;
  $('#dialog-model-id').textContent = dialogModel.id;
  $('#dialog-description').textContent = dialogModel.description;
  const specs = [
    ['提供方', dialogModel.provider],
    ['上下文 / 输入上限', dialogModel.context],
    ['本站调用单价', dialogModel.available ? '−$0.01 / 输出字符' : '未开放计费'],
    ['本站 API 状态', dialogModel.available ? '可用 · 浏览器通道' : '不可用 · 未接入渠道'],
  ];
  $('#dialog-specs').replaceChildren(...specs.map(([name, value]) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = name; dd.textContent = value; row.append(dt, dd); return row;
  }));
  $('#dialog-status').textContent = dialogModel.available ? '成功响应按输出字符计费，每字符余额增加 $0.01；输入不重复计费。字符按 Unicode 码点统计，空格和换行也计入。' : '本站尚未接入此模型。调用将返回 503 model_unavailable，不计费；该状态不代表厂商官方服务异常。';
  $('#dialog-status').classList.toggle('available', dialogModel.available);
  $('#dialog-source').hidden = !dialogModel.source;
  if (dialogModel.source) $('#dialog-source').href = dialogModel.source;
  else $('#dialog-source').removeAttribute('href');
  $('#dialog-use').disabled = !dialogModel.available;
  $('#dialog-use').textContent = dialogModel.available ? '在线调试 ↗' : '暂无可用渠道';
  $('#model-dialog').showModal();
}
$('#close-dialog').addEventListener('click', () => $('#model-dialog').close());
$('#model-dialog').addEventListener('click', event => { if (event.target === $('#model-dialog')) { const rect = $('#model-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#model-dialog').close(); } });
$('#dialog-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(dialogModel.id); $('#model-dialog').close(); toast('模型 ID 已复制。'); }
  catch { $('#dialog-status').textContent = '自动复制不可用，请选中上方模型 ID 手动复制。'; }
});
$('#dialog-use').addEventListener('click', () => { if (dialogModel?.available) { $('#model-dialog').close(); location.hash = 'playground'; } });
renderCatalog();

async function refreshAccount(creditedCharacters = 0) {
  const account = await client.balance();
  document.querySelectorAll('[data-balance]').forEach(element => { element.textContent = money(account.balanceCents); });
  document.querySelectorAll('[data-requests]').forEach(element => { element.textContent = account.requests.toLocaleString(); });
  document.querySelectorAll('[data-characters]').forEach(element => { element.textContent = (account.characters ?? 0).toLocaleString(); });
  if (creditedCharacters > 0) {
    clearTimeout(creditTimer);
    $('#credit-flash').textContent = `+${money(creditedCharacters * CHARACTER_PRICE_CENTS)}`;
    creditTimer = setTimeout(() => { $('#credit-flash').textContent = ''; }, 2500);
  }
}

function speak(content) {
  if (!('speechSynthesis' in window)) return toast('此浏览器不支持语音朗读，文字对话仍可使用。');
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.lang = 'zh-CN';
  utterance.pitch = 1.65;
  utterance.rate = 1.1;
  const chinese = speechSynthesis.getVoices().find(voice => voice.lang.startsWith('zh'));
  if (chinese) utterance.voice = chinese;
  speechSynthesis.speak(utterance);
}

function addMessage(role, content, save = true, firstTokenMs, billedCharacters) {
  if ($('.welcome')) $('.welcome').remove();
  $('#suggestions').hidden = true;
  const article = document.createElement('div');
  article.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = { user: 'USER', assistant: MODEL_NAME, error: '未完成调用' }[role];
  const body = document.createElement('div');
  body.className = 'message-content';
  body.textContent = content;
  article.append(label, body);
  if (role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const credit = document.createElement('span');
    credit.textContent = Number.isSafeInteger(billedCharacters) && billedCharacters > 0 ? `${billedCharacters} 字符 · 余额 +${money(billedCharacters * CHARACTER_PRICE_CENTS)}` : '已入账';
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'replay';
    replay.textContent = '朗读 ↗';
    replay.setAttribute('aria-label', '朗读这条回复（不计费）');
    replay.addEventListener('click', () => speak(content));
    if (Number.isFinite(firstTokenMs) && firstTokenMs >= 0) {
      const timing = document.createElement('span');
      timing.className = 'message-timing';
      timing.textContent = `首字 ${(firstTokenMs / 1000).toFixed(1)}s`;
      timing.title = '从发送请求到首次展示回答的耗时';
      meta.append(timing);
    }
    meta.append(credit, replay);
    article.append(meta);
  }
  $('#messages').append(article);
  while ($('#messages').children.length > 80) $('#messages').firstElementChild.remove();
  $('#messages').scrollTop = $('#messages').scrollHeight;
  if (save && role !== 'error') {
    history.push({ role, content, ...(Number.isFinite(firstTokenMs) && firstTokenMs >= 0 ? { firstTokenMs: Math.round(firstTokenMs) } : {}), ...(Number.isSafeInteger(billedCharacters) && billedCharacters > 0 ? { billedCharacters } : {}) });
    history = history.slice(-80);
    try { localStorage.setItem('tom-chat-history', JSON.stringify(history)); } catch { /* Chat remains usable without persisted history. */ }
  }
}

function progressView(progress) {
  if (progress.phase === 'reconnecting') return { title: `正在重连（${progress.attempt}/${progress.maxAttempts}）`, hint: `${progress.reason} · ${progress.action}` };
  if (progress.phase === 'failed') return { title: '重连已停止', hint: `${progress.reason} · ${progress.action}` };
  return {
    connecting: { title: '正在连接…', hint: '建立响应通道' },
    thinking: { title: '正在思考…', hint: '等待模型响应' },
    waiting_first_token: { title: '等待首字响应…', hint: '响应通道已就绪，等待首字' },
  }[progress.phase];
}

function startThinking() {
  const started = performance.now();
  const article = document.createElement('div');
  article.className = 'message assistant thinking-message';
  article.innerHTML = '<div class="message-label"></div><div class="thinking-status"><span class="thinking-spinner" aria-hidden="true"></span><span class="thinking-title" role="status">正在连接…</span><span class="thinking-time" aria-hidden="true">0.0s</span></div><div class="thinking-hint">建立响应通道</div>';
  article.querySelector('.message-label').textContent = MODEL_NAME;
  $('#messages').append(article);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  const timer = setInterval(() => {
    article.querySelector('.thinking-time').textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  }, 100);
  let elapsed;
  return {
    update(progress) {
      if (elapsed !== undefined) return;
      const view = progressView(progress);
      if (!view) return;
      article.classList.toggle('reconnecting', ['reconnecting', 'failed'].includes(progress.phase));
      article.querySelector('.thinking-title').textContent = view.title;
      article.querySelector('.thinking-hint').textContent = view.hint;
    },
    stop() {
      elapsed ??= performance.now() - started;
      clearInterval(timer);
      article.remove();
      return elapsed;
    },
  };
}

const welcome = $('#messages').innerHTML;
try {
  const stored = JSON.parse(localStorage.getItem('tom-chat-history') || '[]');
  if (Array.isArray(stored)) {
    history = stored.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && item.content.length <= 4000).slice(-80);
    history.forEach(item => addMessage(item.role, item.content, false, item.firstTokenMs, item.billedCharacters));
  }
} catch { /* Storage may be unavailable in restricted browsing modes. */ }

$('#clear-chat').addEventListener('click', () => {
  if (busy) return;
  history = [];
  try { localStorage.removeItem('tom-chat-history'); } catch { /* No persisted history to remove. */ }
  $('#messages').innerHTML = welcome;
  $('#suggestions').hidden = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  toast('对话已清空，账户余额保留。');
});

$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const content = $('#composer').value;
  if (!content.trim() || busy) return;
  busy = true;
  $('#send').disabled = true;
  $('#clear-chat').disabled = true;
  $('#send').textContent = '请求中…';
  $('#chat-form').setAttribute('aria-busy', 'true');
  addMessage('user', content);
  $('#composer').value = '';
  const pending = startThinking();
  try {
    const result = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content }] }, { onProgress: pending.update });
    const reply = result.choices[0].message.content;
    addMessage('assistant', reply, true, pending.stop(), result.billing.quantity);
    await refreshAccount(result.billing.quantity);
    if ($('#voice').checked) speak(reply);
  } catch (error) {
    pending.stop();
    addMessage('error', error.message || '调用失败，请重试。');
    $('#composer').value = content;
  } finally {
    pending.stop();
    $('#chat-form').removeAttribute('aria-busy');
    busy = false;
    $('#send').disabled = false;
    $('#clear-chat').disabled = false;
    $('#send').textContent = '发送 ↑';
  }
});
$('#composer').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('#composer').value = button.dataset.prompt; $('#composer').focus(); }));

if (!('speechSynthesis' in window)) { $('#voice').disabled = true; $('#voice').parentElement.title = '此浏览器不支持语音朗读'; }
$('#voice').addEventListener('change', () => { if (!$('#voice').checked && 'speechSynthesis' in window) speechSynthesis.cancel(); });
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.onresult = event => { $('#composer').value = event.results[0][0].transcript.slice(0, 4000); $('#composer').focus(); };
  recognition.onerror = () => toast('语音输入不可用，请检查麦克风权限或直接打字。语音识别可能需要联网。');
  recognition.onend = () => { $('#mic').disabled = false; };
  $('#mic').addEventListener('click', () => {
    try { recognition.start(); $('#mic').disabled = true; toast('正在听，请说话。浏览器语音识别可能使用其厂商的在线服务。'); } catch { toast('暂时无法开启麦克风。'); }
  });
} else {
  $('#mic').addEventListener('click', () => toast('此浏览器不支持语音输入，请直接打字；支持的浏览器可使用麦克风。'));
}

const examples = {
  sdk: `// 在浏览器 <script type="module"> 中运行\nimport { RelayClient } from '${new URL('sdk.js', base)}';\n\nconst relay = new RelayClient();\nconst result = await relay.chat.completions.create({\n  model: '${MODEL}',\n  messages: [{ role: 'user', content: 'Hello, world!' }]\n});\n\nconsole.log(result.choices[0].message.content);\n// Hello, world!\nconsole.log(result.billing); // quantity: 13, amount: -0.13`,
  fetch: `// 仅在本站受 Service Worker 控制的页面内运行\n// 等待页面显示「浏览器端点已就绪」\nconst response = await fetch('${new URL('v1/chat/completions', base)}', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n    model: '${MODEL}',\n    messages: [{ role: 'user', content: 'Hello, world!' }]\n  })\n});\nconst result = await response.json();\nif (!response.ok) throw new Error(result.error.message);\nconsole.log(result);`,
  curl: `# 先下载仓库并在本机用 Node.js 22+ 运行：npm start\n# 这是本机地址；公网 HTTP API 服务需另行部署\ncurl http://localhost:8787/v1/chat/completions \\\n  -H 'Authorization: Bearer sk-relay-demo' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\n    "model": "${MODEL}",\n    "messages": [{"role":"user","content":"Hello, world!"}]\n  }'\n\n# 查询服务端余额（与浏览器独立）\ncurl http://localhost:8787/v1/balance \\\n  -H 'Authorization: Bearer sk-relay-demo'`,
};
const descriptions = {
  sdk: '浏览器内直接调用，无需 Service Worker。与网页共享 IndexedDB 账本；不是 Node SDK。',
  fetch: '原生 fetch 请求，由本站 Service Worker 在浏览器内拦截。仅当前站点受控页面可用，不能从其他网站或 curl 调用。',
  curl: 'HTTP API 示例，需另行运行仓库中的 Node 服务。测试 Key 不是厂商密钥，不要填入任何第三方密钥。',
};
function renderCode() {
  $('#example-code').textContent = examples[activeCode];
  $('#code-description').textContent = descriptions[activeCode];
  $('#code-example').setAttribute('aria-labelledby', `tab-${activeCode}`);
  document.querySelectorAll('[data-code]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.code === activeCode)); button.tabIndex = button.dataset.code === activeCode ? 0 : -1; });
  $('#run-api').disabled = apiBusy || activeCode === 'curl' || (activeCode === 'fetch' && !workerReady);
  $('#run-api').textContent = apiBusy ? '正在思考…' : activeCode === 'curl' ? '需另行部署后端' : '运行请求 ↗';
}
document.querySelectorAll('[data-code]').forEach(button => {
  button.addEventListener('click', () => { activeCode = button.dataset.code; renderCode(); });
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-code]')];
    const index = tabs.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  });
});
$('#copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(examples[activeCode]); toast('代码已复制。'); }
  catch { toast('浏览器禁止自动复制，请选中代码手动复制。'); }
});
$('#run-api').addEventListener('click', async () => {
  if (apiBusy) return;
  apiBusy = true;
  renderCode();
  $('#api-output').hidden = false;
  $('#api-output').textContent = '正在思考… 等待响应。';
  const body = { model: MODEL, messages: [{ role: 'user', content: 'Hello, world!' }] };
  try {
    let result;
    if (activeCode === 'fetch') {
      const response = await fetch(new URL('v1/chat/completions', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '调用失败');
    } else result = await client.chat.completions.create(body, { onProgress: progress => {
      const view = progressView(progress);
      if (view) $('#api-output').textContent = `${view.title}\n${view.hint}`;
    } });
    $('#api-output').textContent = JSON.stringify(result, null, 2);
    await refreshAccount(result.billing.quantity);
  } catch (error) { $('#api-output').textContent = `调用失败：${error.message}`; }
  finally { apiBusy = false; renderCode(); }
});
renderCode();

async function setupWorker() {
  try {
    if (!('serviceWorker' in navigator)) throw new Error('unsupported');
    await navigator.serviceWorker.register(new URL('sw.js', base), { type: 'module', scope: base.pathname, updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', changed); reject(new Error('timeout')); }, 8000);
      function changed() { clearTimeout(timer); resolve(); }
      navigator.serviceWorker.addEventListener('controllerchange', changed, { once: true });
    });
    workerReady = true;
    $('#sw-status').textContent = '浏览器端点已就绪';
  } catch { $('#sw-status').textContent = 'fetch 端点不可用，可使用浏览器 SDK'; }
  renderCode();
}
setupWorker();
refreshAccount().catch(() => toast('本地存储不可用，请允许此站使用浏览器存储后重试。'));
window.addEventListener('focus', () => refreshAccount().catch(() => {}));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAccount().catch(() => {}); });
fetch(new URL('site.json', base)).then(response => response.ok ? response.json() : null).then(config => {
  if (config?.repository && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(config.repository)) {
    $('#source-link').href = config.repository;
    $('#source-link').hidden = false;
  }
}).catch(() => {});
