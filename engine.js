import { MODELS, MODEL, CHARACTER_PRICE_CENTS, findModel } from './catalog.js';
export { MODEL };
export const initialAccount = () => ({ balanceCents: 0, requests: 0, tokens: 0, characters: 0 });
export function normalizeAccount(account = initialAccount()) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('Invalid account data');
  const normalized = { ...account, characters: account.characters === undefined ? 0 : account.characters };
  if (!['balanceCents', 'requests', 'tokens', 'characters'].every(key => Number.isSafeInteger(normalized[key]) && normalized[key] >= 0)) throw new Error('Invalid account data');
  return normalized;
}
export const COMPLETION_DELAY = { baseMs: 1200, inputMsPerChar: 3, outputMsPerChar: 1, maxBaseMs: 15000, jitter: 0.15 };
export const FIRST_TOKEN_DELAY = { minMs: 300, maxMs: 2300 };
export const RECONNECT_POLICY = { firstMin: 2, firstMax: 4, cooldown: 8, probability: 0.02, pityAfter: 20, maxAttempts: 5 };
export const RECONNECT_ERRORS = [
  { reason: 'Network Error', phase: 'connecting', action: '重新建立连接' },
  { reason: '403 Forbidden', phase: 'connecting', action: '通道拒绝访问，停止重试', status: 403 },
  { reason: 'invalid_state', phase: 'thinking', action: '重建会话状态后重试' },
  { reason: '429 Too Many Requests', phase: 'connecting', action: '等待限流退避后重试' },
  { reason: 'stream closed before response.completed', phase: 'waiting_first_token', action: '响应尚未完成，重新建立响应通道' },
  { reason: '远程主机强迫关闭了一个现有的连接（os error 10054）', phase: 'connecting', action: '连接被对端重置，重新建立连接' },
  { reason: '你的主机中的软件中止了一个已建立的连接（os error 10053）', phase: 'connecting', action: '本地连接已中止，重新创建连接' },
];

export function createReconnectGate(random = Math.random) {
  let firstRemaining = RECONNECT_POLICY.firstMin + Math.floor(random() * (RECONNECT_POLICY.firstMax - RECONNECT_POLICY.firstMin + 1));
  let cooldown = 0;
  let eligible = 0;
  return () => {
    if (firstRemaining > 0) {
      if (--firstRemaining > 0) return false;
    } else {
      if (cooldown > 0) { cooldown--; return false; }
      if (++eligible < RECONNECT_POLICY.pityAfter && random() >= RECONNECT_POLICY.probability) return false;
    }
    cooldown = RECONNECT_POLICY.cooldown;
    eligible = 0;
    return true;
  };
}

const reconnectGates = new WeakMap();

export const countCharacters = text => Array.from(text).length;

export function thinkingDelayRange(prepared) {
  const base = Math.min(COMPLETION_DELAY.maxBaseMs, COMPLETION_DELAY.baseMs + prepared.promptCharacters * COMPLETION_DELAY.inputMsPerChar + prepared.completionCharacters * COMPLETION_DELAY.outputMsPerChar);
  return { minMs: Math.round(base * (1 - COMPLETION_DELAY.jitter)), maxMs: Math.round(base * (1 + COMPLETION_DELAY.jitter)) };
}

export class ApiError extends Error {
  constructor(message, status = 400, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export function validateCompletion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('请求体必须是 JSON 对象。');
  const model = findModel(body.model);
  if (!model) throw new ApiError(`模型不存在，请使用 ${MODEL}。`, 404);
  if (!model.available) throw new ApiError(`${model.name} 在本站暂无可用渠道，请选择其他模型。`, 503, 'model_unavailable');
  if (body.stream !== undefined && body.stream !== false) throw new ApiError('暂不支持流式输出，请设置 stream: false。');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) throw new ApiError('messages 需要包含 1–100 条消息。');
  for (const message of body.messages) {
    if (!message || !['system', 'assistant', 'user'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 4000) {
      throw new ApiError('消息需要有效的 role 和不超过 4000 字符的文本 content。');
    }
  }
  const last = body.messages.at(-1);
  if (last.role !== 'user' || !last.content.trim()) throw new ApiError('最后一条消息必须是非空的 user 文本。');
  const count = text => Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 4));
  return {
    content: last.content,
    promptTokens: body.messages.reduce((sum, message) => sum + count(message.content), 0),
    completionTokens: count(last.content),
    promptCharacters: body.messages.reduce((sum, message) => sum + countCharacters(message.content), 0),
    completionCharacters: countCharacters(last.content),
  };
}

export function complete(prepared, account) {
  const total = prepared.promptTokens + prepared.completionTokens;
  const quantity = prepared.completionCharacters;
  const creditCents = quantity * CHARACTER_PRICE_CENTS;
  const next = normalizeAccount({ balanceCents: account.balanceCents + creditCents, requests: account.requests + 1, tokens: account.tokens + total, characters: (account.characters ?? 0) + quantity });
  return {
    account: next,
    response: {
      id: `chatcmpl-relay-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: prepared.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: prepared.promptTokens, completion_tokens: prepared.completionTokens, total_tokens: total, estimated: true, prompt_characters: prepared.promptCharacters, completion_characters: quantity, total_characters: prepared.promptCharacters + quantity },
      billing: { currency: 'USD', unit: 'character', unit_price: -CHARACTER_PRICE_CENTS / 100, quantity, amount: -creditCents / 100, balance: next.balanceCents / 100, simulated: true },
    },
  };
}

export async function createCompletion(body, accountStore, { random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {}, shouldReconnect } = {}) {
  const prepared = validateCompletion(body);
  const sample = ({ minMs, maxMs }) => minMs + Math.floor(random() * (maxMs - minMs + 1));
  const thinkingMs = sample(thinkingDelayRange(prepared));
  const firstTokenMs = sample(FIRST_TOKEN_DELAY);
  if (!shouldReconnect) {
    if (!reconnectGates.has(accountStore)) reconnectGates.set(accountStore, createReconnectGate(random));
    shouldReconnect = reconnectGates.get(accountStore);
  }
  const incident = shouldReconnect() ? RECONNECT_ERRORS[Math.floor(random() * RECONNECT_ERRORS.length)] : undefined;
  const reconnect = async () => {
    await sleep(sample({ minMs: 500, maxMs: 1200 }));
    const attempt = 1 + Math.floor(random() * RECONNECT_POLICY.maxAttempts);
    if (incident.status === 403) {
      onProgress({ ...incident, phase: 'failed', attempt, maxAttempts: RECONNECT_POLICY.maxAttempts });
      throw new ApiError(`${incident.reason}：${incident.action}。`, 403, 'upstream_error');
    }
    onProgress({ ...incident, phase: 'reconnecting', attempt, maxAttempts: RECONNECT_POLICY.maxAttempts });
    const backoff = incident.reason.startsWith('429') ? { minMs: 2500, maxMs: 5000 } : { minMs: 700, maxMs: 2000 };
    await sleep(sample(backoff));
  };
  // Wait outside the ledger transaction so concurrent requests do not block each other.
  onProgress({ phase: 'connecting' });
  if (incident?.phase === 'connecting') await reconnect();
  onProgress({ phase: 'thinking' });
  await sleep(thinkingMs);
  if (incident?.phase === 'thinking') await reconnect();
  onProgress({ phase: 'waiting_first_token' });
  await sleep(firstTokenMs);
  if (incident?.phase === 'waiting_first_token') {
    await reconnect();
    onProgress({ phase: 'waiting_first_token' });
    await sleep(sample(FIRST_TOKEN_DELAY));
  }
  return accountStore.update(account => complete(prepared, account));
}

export async function handleApi(request, path, accountStore, completionTiming) {
  const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
  try {
    if (request.method === 'GET' && path === '/v1/models') {
      return json({ object: 'list', data: MODELS.map(model => ({ id: model.id, name: model.name, object: 'model', owned_by: model.provider.toLowerCase(), available: model.available, status: model.available ? 'available' : 'unavailable' })), simulated: true });
    }
    if (request.method === 'GET' && path === '/v1/balance') {
      const account = await accountStore.read();
      return json({ balance: account.balanceCents / 100, currency: 'USD', requests: account.requests, tokens: account.tokens, characters: account.characters ?? 0, simulated: true });
    }
    if (path === '/v1/chat/completions' && request.method === 'POST') {
      if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) throw new ApiError('请使用 Content-Type: application/json。', 415);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 65536) throw new ApiError('请求体不能超过 64 KiB。', 413);
      let body;
      try { body = JSON.parse(raw); } catch { throw new ApiError('无效的 JSON。'); }
      const response = await createCompletion(body, accountStore, completionTiming);
      return json(response);
    }
    if (['/v1/models', '/v1/balance', '/v1/chat/completions'].includes(path)) return json({ error: { message: '不支持此 HTTP 方法。', type: 'invalid_request_error' } }, 405, { Allow: path.endsWith('completions') ? 'POST' : 'GET' });
    throw new ApiError('接口不存在。', 404);
  } catch (error) {
    return json({ error: { message: error instanceof ApiError ? error.message : '存储暂不可用，请重试；未确认的调用不会显示为成功。', type: error instanceof ApiError ? error.type : 'server_error' } }, error instanceof ApiError ? error.status : 500);
  }
}
