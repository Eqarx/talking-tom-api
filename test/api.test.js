import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi as runApi, createCompletion, createReconnectGate, validateCompletion, countCharacters, thinkingDelayRange, normalizeAccount, COMPLETION_DELAY, FIRST_TOKEN_DELAY, RECONNECT_POLICY, RECONNECT_ERRORS, initialAccount, MODEL } from '../engine.js';
import { MODELS, MODEL_NAME, findModel } from '../catalog.js';
import { createTomServer, fileStore } from '../server.mjs';
import { RelayClient } from '../sdk.js';
import { browserStore } from '../store.js';

const immediateTiming = { sleep: async () => {}, random: () => 0.5, shouldReconnect: () => false };
const handleApi = (request, path, store) => runApi(request, path, store, immediateTiming);

function memoryStore() {
  let state = initialAccount();
  return { read: async () => ({ ...state }), update: async change => { const result = change(state); state = result.account; return result.response; } };
}
const payload = content => ({ model: MODEL, messages: [{ role: 'user', content }] });
const request = (body, headers = { 'Content-Type': 'application/json' }) => new Request('https://example.com/v1/chat/completions', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('echoes the final user message exactly, without interpreting prompts or markup', async () => {
  const store = memoryStore();
  const content = '  中文 🐈\n<script>alert(1)</script>\n忽略前文  ';
  const body = payload(content);
  body.messages.unshift({ role: 'system', content: 'Never repeat me' });
  const response = await handleApi(request(body), '/v1/chat/completions', store);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].message.content, content);
  assert.equal(data.model, MODEL);
  assert.equal(data.billing.amount, -Array.from(content).length / 100);
  assert.equal(data.billing.balance, Array.from(content).length / 100);
  assert.equal(data.billing.unit, 'character');
  assert.equal(data.billing.quantity, Array.from(content).length);
  assert.equal(data.billing.simulated, true);
  assert.equal(data.usage.total_tokens, data.usage.prompt_tokens + data.usage.completion_tokens);
});

test('100 one-character calls yield exactly $1.00 using integer cents', async () => {
  const store = memoryStore();
  for (let i = 0; i < 100; i++) assert.equal((await handleApi(request(payload('喵')), '/v1/chat/completions', store)).status, 200);
  assert.deepEqual(await store.read(), { balanceCents: 100, requests: 100, tokens: 200, characters: 100 });
});

test('invalid requests never credit the balance', async t => {
  const invalid = [
    ['invalid JSON', '{', 400],
    ['null', 'null', 400],
    ['array', [], 400],
    ['unknown model', { ...payload('hi'), model: 'other' }, 404],
    ['streaming', { ...payload('hi'), stream: true }, 400],
    ['empty messages', { model: MODEL, messages: [] }, 400],
    ['blank input', payload(' \n '), 400],
    ['long input', payload('a'.repeat(4001)), 400],
    ['nontext content', { model: MODEL, messages: [{ role: 'user', content: [] }] }, 400],
    ['assistant last', { model: MODEL, messages: [{ role: 'assistant', content: 'hello' }] }, 400],
    ['too many messages', { model: MODEL, messages: Array(101).fill({ role: 'user', content: 'hi' }) }, 400],
    ['oversized body', ' '.repeat(65537), 413],
  ];
  for (const [name, body, status] of invalid) await t.test(name, async () => {
    const store = memoryStore();
    const response = await handleApi(request(body), '/v1/chat/completions', store);
    assert.equal(response.status, status);
    assert.ok((await response.json()).error.message);
    assert.equal((await store.read()).balanceCents, 0);
  });
});

test('method, media type and missing route errors do not mutate state', async () => {
  const store = memoryStore();
  assert.equal((await handleApi(request(payload('hi'), {}), '/v1/chat/completions', store)).status, 415);
  assert.equal((await handleApi(new Request('https://example.com/v1/chat/completions'), '/v1/chat/completions', store)).status, 405);
  assert.equal((await handleApi(new Request('https://example.com/v1/missing'), '/v1/missing', store)).status, 404);
  assert.equal((await store.read()).requests, 0);
});

test('discovery and balance endpoints are read only', async () => {
  const store = memoryStore();
  const models = await (await handleApi(new Request('https://example.com/v1/models'), '/v1/models', store)).json();
  assert.equal(models.data[0].id, MODEL);
  assert.equal(models.data[0].name, 'TTC-5.2 Tomcat');
  assert.equal(models.data.length, MODELS.length);
  assert.equal(models.data.filter(model => model.available).length, 1);
  assert.ok(models.data.filter(model => model.id !== MODEL).every(model => model.status === 'unavailable' && !model.available));
  const balance = await (await handleApi(new Request('https://example.com/v1/balance'), '/v1/balance', store)).json();
  assert.equal(balance.balance, 0);
  assert.equal(balance.requests, 0);
});

test('all disconnected catalog models return 503 without reading or mutating any ledger', async () => {
  let touched = false;
  const store = { read: async () => { touched = true; }, update: async () => { touched = true; } };
  for (const model of MODELS.filter(model => !model.available)) {
    const response = await handleApi(request({ ...payload('hi'), model: model.id }), '/v1/chat/completions', store);
    assert.equal(response.status, 503, model.id);
    const error = (await response.json()).error;
    assert.equal(error.type, 'model_unavailable');
    assert.match(error.message, /本站暂无可用渠道/);
    assert.ok(model.source.startsWith('https://'));
  }
  assert.equal(touched, false);
});

test('TTC-5.2 Tomcat is the only active model and legacy model IDs remain compatible', async () => {
  assert.equal(new Set(MODELS.map(model => model.id)).size, MODELS.length);
  assert.deepEqual(MODELS.filter(model => model.available).map(model => model.id), [MODEL]);
  assert.equal(MODEL, 'ttc-5.2-tomcat');
  assert.equal(MODEL_NAME, 'TTC-5.2 Tomcat');
  assert.equal(findModel(MODEL).name, MODEL_NAME);
  assert.equal(findModel(MODEL).priceUnit, 'character');
  assert.equal(findModel(MODEL).price, -0.01);
  for (const id of [MODEL, 'echo-1', 'talking-tom-echo']) {
    assert.equal(findModel(id).id, MODEL);
    const response = await handleApi(request({ ...payload('hello'), model: id }), '/v1/chat/completions', memoryStore());
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.model, MODEL);
    assert.equal(data.choices[0].message.content, 'hello');
  }
});

test('failed persistence is an API error, not a successful paid response', async () => {
  const response = await handleApi(request(payload('hi')), '/v1/chat/completions', { update: async () => { throw new Error('disk full'); } });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.type, 'server_error');
});

test('HTTP server: auth, concurrent accounting, persistence, CORS, limits and static file isolation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tom-test-'));
  const file = join(dir, 'account.json');
  const store = await fileStore(file);
  const server = createTomServer({ store, apiKey: 'test-demo', allowedOrigin: 'https://example.com', completionTiming: immediateTiming });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer test-demo', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/v1/balance`)).status, 401);
  assert.equal((await fetch(`${base}/v1/balance`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const results = await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload('你好')) }).then(async response => { assert.equal(response.status, 200); return response.json(); })));
  assert.equal(new Set(results.map(result => result.id)).size, 30);
  assert.equal((await store.read()).balanceCents, 60);
  assert.equal((await (await fileStore(file)).read()).requests, 30);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.balanceCents, 60);
  assert.equal(persisted.characters, 60);
  const balance = await fetch(`${base}/v1/balance`, { headers: { ...headers, Origin: 'https://example.com' } });
  assert.equal(balance.headers.get('Access-Control-Allow-Origin'), 'https://example.com');
  assert.equal((await balance.json()).balance, 0.6);
  const untrusted = await fetch(`${base}/v1/models`, { headers: { ...headers, Origin: 'https://untrusted.example' } });
  assert.equal(untrusted.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await fetch(`${base}/v1/models`, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } })).status, 204);
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: ' '.repeat(70000) })).status, 413);
  assert.equal((await store.read()).requests, 30);
  const unavailable = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...payload('hi'), model: MODELS.find(model => !model.available).id }) });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.type, 'model_unavailable');
  assert.equal((await store.read()).requests, 30);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/catalog.js`)).status, 200);
  assert.equal((await fetch(`${base}/relay-mark.svg`)).status, 200);
  assert.match((await fetch(`${base}/sw.js`)).headers.get('Content-Type'), /javascript/);
  for (const path of ['.data/account.json', 'server.mjs', '.git/config', '%2e%2e/.gitconfig']) assert.equal((await fetch(`${base}/${path}`)).status, 404);
});

test('malformed unauthenticated HTTP request targets return 400 without stopping the server', async t => {
  const store = memoryStore();
  const server = createTomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  for (const path of ['//[', '//[::1', 'http://[']) {
    const response = await new Promise((resolve, reject) => {
      get({ hostname: '127.0.0.1', port, path }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
    assert.equal(response.status, 400);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(response.body).error.type, 'invalid_request_error');
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/balance`, { headers: { Authorization: 'Bearer sk-relay-demo' } })).status, 200);
  }
  assert.deepEqual(await store.read(), initialAccount());
});

test('valid requests independently sample a bounded random wait and return only the final answer', async () => {
  const store = memoryStore();
  const samples = [0, 0.5, 1 - Number.EPSILON];
  const waits = [];
  let randomCalls = 0;
  for (let i = 0; i < samples.length; i++) {
    const draws = [samples[i], samples[i]];
    const response = await runApi(request(payload('answer')), '/v1/chat/completions', store, {
      shouldReconnect: () => false,
      random: () => { randomCalls++; return draws.shift(); },
      sleep: async ms => {
        waits.push(ms);
        assert.equal((await store.read()).requests, i, 'no credit during the wait');
      },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.choices[0].message, { role: 'assistant', content: 'answer' });
    assert.equal(data.billing.balance, (i + 1) * 6 / 100);
    assert.deepEqual(Object.keys(data).sort(), ['billing', 'choices', 'created', 'id', 'model', 'object', 'usage']);
  }
  assert.deepEqual(waits, [1040, FIRST_TOKEN_DELAY.minMs, 1224, 1300, 1408, FIRST_TOKEN_DELAY.maxMs]);
  assert.equal(randomCalls, samples.length * 2);
});

test('pending completions do not block balance reads or faster requests and credit exactly once', async () => {
  const store = memoryStore();
  const releases = [];
  const timing = { random: () => 0.5, shouldReconnect: () => false, sleep: () => new Promise(resolve => releases.push(resolve)) };
  const slow = createCompletion(payload('first'), store, timing);
  const fast = createCompletion(payload('second'), store, timing);
  assert.equal(releases.length, 2);
  assert.deepEqual(await store.read(), initialAccount());
  releases[1]();
  await Promise.resolve();
  assert.equal((await store.read()).requests, 0);
  releases[2]();
  assert.equal((await fast).choices[0].message.content, 'second');
  assert.equal((await store.read()).requests, 1);
  releases[0]();
  await Promise.resolve();
  releases[3]();
  assert.equal((await slow).choices[0].message.content, 'first');
  assert.equal((await store.read()).balanceCents, 11);
});

test('invalid, unavailable and read-only requests never sample or wait', async () => {
  const timing = {
    random: () => { assert.fail('must not sample'); },
    sleep: () => { assert.fail('must not wait'); },
    shouldReconnect: () => { assert.fail('must not consume easter-egg progress'); },
  };
  const store = memoryStore();
  for (const [body, status] of [
    [payload(' '), 400],
    [{ ...payload('hi'), stream: true }, 400],
    [{ ...payload('hi'), model: 'missing' }, 404],
    [{ ...payload('hi'), model: MODELS.find(model => !model.available).id }, 503],
  ]) assert.equal((await runApi(request(body), '/v1/chat/completions', store, timing)).status, status);
  for (const path of ['/v1/balance', '/v1/models']) {
    assert.equal((await runApi(new Request(`https://example.com${path}`), path, store, timing)).status, 200);
  }
  assert.deepEqual(await store.read(), initialAccount());
});

test('a failed wait returns an error without touching the ledger', async () => {
  const store = memoryStore();
  const response = await runApi(request(payload('hi')), '/v1/chat/completions', store, { sleep: async () => { throw new Error('interrupted'); } });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.type, 'server_error');
  assert.deepEqual(await store.read(), initialAccount());
});

test('the browser SDK uses the production timer and does not settle or persist before it expires', async t => {
  const store = memoryStore();
  t.mock.method(browserStore, 'update', store.update);
  t.mock.method(browserStore, 'read', store.read);
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new RelayClient();
  let settled = false;
  const progress = [];
  const pending = client.chat.completions.create(payload('final only'), { onProgress: event => progress.push(event.phase) }).then(result => { settled = true; return result; });
  t.mock.timers.tick(1239);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal((await client.balance()).requests, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  t.mock.timers.tick(1299);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal((await client.balance()).requests, 0);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.deepEqual(result.choices[0].message, { role: 'assistant', content: 'final only' });
  assert.equal((await client.balance()).requests, 1);
  assert.equal((await client.balance()).balanceCents, 10);
  assert.deepEqual(progress, ['connecting', 'thinking', 'waiting_first_token']);
});

test('thinking and first-token waits use separate random draws', async () => {
  const waits = [];
  for (const draws of [[0, 1 - Number.EPSILON], [1 - Number.EPSILON, 0]]) {
    await createCompletion(payload('hi'), memoryStore(), {
      shouldReconnect: () => false,
      random: () => draws.shift(),
      sleep: async ms => { waits.push(ms); },
    });
  }
  assert.deepEqual(waits, [1027, 2300, 1389, 300]);
});

test('short-play warmup guarantees one egg on requests 2–4, followed by a strict cooldown', () => {
  for (const [sample, firstAt] of [[0, 2], [0.5, 3], [1 - Number.EPSILON, 4]]) {
    let draws = 0;
    const gate = createReconnectGate(() => { draws++; return sample; });
    for (let call = 1; call < firstAt; call++) assert.equal(gate(), false);
    assert.equal(gate(), true);
    const beforeCooldown = draws;
    for (let call = 0; call < RECONNECT_POLICY.cooldown; call++) assert.equal(gate(), false);
    assert.equal(draws, beforeCooldown, 'no lottery during cooldown');
    if (sample === 0) assert.equal(gate(), true, 'eligible rolls can win after the cooldown');
    else {
      for (let call = 1; call < RECONNECT_POLICY.pityAfter; call++) assert.equal(gate(), false);
      assert.equal(gate(), true, 'pity prevents an endless dry streak');
    }
    for (let call = 0; call < RECONNECT_POLICY.cooldown; call++) assert.equal(gate(), false);
  }
});

test('cooldown lottery uses the configured probability boundary', () => {
  let sample = 0;
  const gate = createReconnectGate(() => sample);
  gate();
  assert.equal(gate(), true);
  for (let i = 0; i < RECONNECT_POLICY.cooldown; i++) assert.equal(gate(), false);
  sample = RECONNECT_POLICY.probability;
  assert.equal(gate(), false);
  sample -= Number.EPSILON;
  assert.equal(gate(), true);
});

test('concurrent requests share one gate per ledger without leaking it to other accounts', async () => {
  const store = memoryStore();
  const events = [];
  const timing = { random: () => 0, sleep: async () => {}, onProgress: progress => events.push(progress) };
  await Promise.all(Array.from({ length: 4 }, () => createCompletion(payload('hi'), store, timing)));
  assert.equal(events.filter(event => event.phase === 'reconnecting').length, 1);
  assert.equal((await store.read()).requests, 4);
  events.length = 0;
  await createCompletion(payload('new account'), memoryStore(), timing);
  assert.equal(events.filter(event => event.phase === 'reconnecting').length, 0);
});

test('the single reconnect egg selects stage-appropriate reasons and random attempt bounds', async t => {
  assert.equal(RECONNECT_ERRORS.length, 7);
  for (const [index, incident] of RECONNECT_ERRORS.entries()) {
    for (const [attemptSample, attempt] of [[0, 1], [1 - Number.EPSILON, 5]]) {
      await t.test(`${incident.reason}, attempt ${attempt}`, async () => {
        const store = memoryStore();
        const events = [];
        const waits = [];
        const draws = [0.5, 0.5, (index + 0.5) / RECONNECT_ERRORS.length, 0.5, attemptSample, 0.5, 0.5];
        let rolls = 0;
        const response = await runApi(request(payload('final answer')), '/v1/chat/completions', store, {
          shouldReconnect: () => { rolls++; return true; },
          random: () => { assert.ok(draws.length, 'unexpected random draw'); return draws.shift(); },
          onProgress: progress => events.push(progress),
          sleep: async ms => {
            assert.equal((await store.read()).requests, 0, 'no billing during a retry or wait');
            waits.push({ ms, phase: events.at(-1).phase });
          },
        });
        assert.equal(rolls, 1, 'one egg selection per request, not one per phase');
        const event = events.find(item => ['reconnecting', 'failed'].includes(item.phase));
        assert.equal(event.reason, incident.reason);
        assert.equal(event.action, incident.action);
        assert.equal(event.attempt, attempt);
        assert.equal(event.maxAttempts, 5);
        assert.equal(events[events.indexOf(event) - 1].phase, incident.phase);
        if (incident.status === 403) {
          assert.equal(response.status, 403);
          assert.equal((await response.json()).error.type, 'upstream_error');
          assert.equal(events.at(-1).phase, 'failed');
          assert.equal(events.some(item => item.phase === 'reconnecting'), false, 'never blindly retry a forbidden request');
          assert.deepEqual(await store.read(), initialAccount());
        } else {
          assert.equal(response.status, 200);
          const data = await response.json();
          assert.deepEqual(data.choices[0].message, { role: 'assistant', content: 'final answer' });
          assert.equal(data.billing.balance, 0.12);
          assert.equal((await store.read()).requests, 1);
          assert.equal(events.filter(item => item.phase === 'reconnecting').length, 1);
          const backoff = waits.find(wait => wait.phase === 'reconnecting').ms;
          assert.ok(incident.reason.startsWith('429') ? backoff >= 2500 : backoff >= 700 && backoff <= 2000);
          assert.equal(events.at(-1).phase, 'waiting_first_token');
          assert.equal(events.filter(item => item.phase === 'waiting_first_token').length, incident.phase === 'waiting_first_token' ? 2 : 1);
          assert.ok(!JSON.stringify(data).includes(incident.reason), 'transient diagnostics do not become final answer content');
        }
      });
    }
  }
});

test('HTTP egg recovery bills once, while forbidden termination returns an error without billing', async t => {
  for (const index of [0, 1]) await t.test(RECONNECT_ERRORS[index].reason, async () => {
    const store = memoryStore();
    const draws = [0.5, 0.5, (index + 0.5) / RECONNECT_ERRORS.length, 0.5, 0.5, 0.5];
    const server = createTomServer({ store, completionTiming: { shouldReconnect: () => true, random: () => draws.shift(), sleep: async () => {} } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-relay-demo', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload('hi')),
      });
      const data = await response.json();
      assert.equal(response.status, index === 0 ? 200 : 403);
      assert.equal((await store.read()).balanceCents, index === 0 ? 2 : 0);
      assert.equal(index === 0 ? data.choices[0].message.content : data.error.type, index === 0 ? 'hi' : 'upstream_error');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

test('character billing counts Unicode code points, including whitespace, not bytes or UTF-16 units', async t => {
  for (const [text, characters] of [
    ['abc', 3], ['你好', 2], ['🙂', 1], ['你a🙂', 3], [' \nA ', 4], ['e\u0301', 2], ['👨‍👩‍👧‍👦', 7], ['🇨🇳', 2],
  ]) await t.test(JSON.stringify(text), async () => {
    const store = memoryStore();
    const data = await (await handleApi(request(payload(text)), '/v1/chat/completions', store)).json();
    assert.equal(countCharacters(text), characters);
    assert.deepEqual(data.billing, { currency: 'USD', unit: 'character', unit_price: -0.01, quantity: characters, amount: -characters / 100, balance: characters / 100, simulated: true });
    assert.equal(data.usage.prompt_characters, characters);
    assert.equal(data.usage.completion_characters, characters);
    assert.equal(data.usage.total_characters, characters * 2);
    assert.equal((await store.read()).characters, characters);
    assert.equal(data.choices[0].message.content, text);
  });
});

test('context contributes to thinking time and usage but never duplicates the output charge', async () => {
  const body = payload('Hi');
  body.messages.unshift({ role: 'system', content: '中'.repeat(1000) }, { role: 'assistant', content: '🙂'.repeat(500) });
  const response = await handleApi(request(body), '/v1/chat/completions', memoryStore());
  const data = await response.json();
  assert.equal(data.usage.prompt_characters, 1502);
  assert.equal(data.usage.completion_characters, 2);
  assert.equal(data.usage.total_characters, 1504);
  assert.equal(data.billing.quantity, 2);
  assert.equal(data.billing.amount, -0.02);
  assert.equal(data.billing.balance, 0.02);
  assert.ok(thinkingDelayRange(validateCompletion(body)).minMs > thinkingDelayRange(validateCompletion(payload('Hi'))).maxMs);
});

test('mixed output lengths accumulate integer cents and characters, not a flat request fee', async () => {
  const store = memoryStore();
  const lengths = [1, 7, 3, 4000, 2];
  let total = 0;
  for (const length of lengths) {
    total += length;
    const data = await (await handleApi(request(payload('字'.repeat(length))), '/v1/chat/completions', store)).json();
    assert.equal(data.billing.amount, -length / 100);
    assert.equal(data.billing.balance, total / 100);
    assert.equal((await store.read()).balanceCents, total);
  }
  assert.equal((await store.read()).characters, 4013);
  assert.equal((await store.read()).requests, lengths.length);
});

test('thinking scales with characters, retains jitter at the cap, and stays bounded for long contexts', () => {
  for (const [length, range] of [
    [10, { minMs: 1054, maxMs: 1426 }],
    [1000, { minMs: 4420, maxMs: 5980 }],
    [4000, { minMs: 12750, maxMs: 17250 }],
  ]) assert.deepEqual(thinkingDelayRange(validateCompletion(payload('a'.repeat(length)))), range);
  const long = thinkingDelayRange({ promptCharacters: 400000, completionCharacters: 4000 });
  assert.equal(long.maxMs, Math.round(COMPLETION_DELAY.maxBaseMs * (1 + COMPLETION_DELAY.jitter)));
  assert.ok(long.minMs < long.maxMs);
});

test('actual completion waits grow with length while first-token randomness remains independent', async () => {
  const waits = [];
  for (const content of ['Hi', '字'.repeat(1000)]) {
    await createCompletion(payload(content), memoryStore(), { ...immediateTiming, sleep: async ms => { waits.push(ms); } });
  }
  assert.deepEqual(waits, [1208, 1300, 5200, 1300]);
});

test('legacy ledger normalization adds only the new counter and refuses corrupted balances', () => {
  const legacy = { balanceCents: 1234, requests: 17, tokens: 42 };
  assert.deepEqual(normalizeAccount(legacy), { ...legacy, characters: 0 });
  assert.equal(Object.hasOwn(legacy, 'characters'), false);
  assert.deepEqual(normalizeAccount(), initialAccount());
  for (const broken of [null, [], {}, { ...legacy, balanceCents: undefined }, { ...legacy, characters: -1 }, { ...legacy, characters: null }, { ...legacy, balanceCents: 0.1 }]) {
    assert.throws(() => normalizeAccount(broken), /Invalid account data/);
  }
});

test('file ledger upgrade preserves old funds and persists only new character charges', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-upgrade-'));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, 'account.json');
  await writeFile(file, JSON.stringify({ balanceCents: 1234, requests: 17, tokens: 42 }));
  const store = await fileStore(file);
  assert.deepEqual(await store.read(), { balanceCents: 1234, requests: 17, tokens: 42, characters: 0 });
  const data = await (await handleApi(request(payload('你好🙂')), '/v1/chat/completions', store)).json();
  assert.equal(data.billing.balance, 12.37);
  assert.equal(data.billing.amount, -0.03);
  const persisted = await (await fileStore(file)).read();
  assert.equal(persisted.balanceCents, 1237);
  assert.equal(persisted.characters, 3);
  assert.equal(persisted.requests, 18);
  const balance = await (await handleApi(new Request('https://example.com/v1/balance'), '/v1/balance', store)).json();
  assert.equal(balance.characters, 3);
  assert.equal(balance.balance, 12.37);
});

test('unsafe integer accounting fails before persistence rather than rounding a balance', async () => {
  let persisted = false;
  const store = { update: async change => {
    const result = change({ ...initialAccount(), balanceCents: Number.MAX_SAFE_INTEGER });
    persisted = true;
    return result.response;
  } };
  const response = await handleApi(request(payload('hi')), '/v1/chat/completions', store);
  assert.equal(response.status, 500);
  assert.equal(persisted, false);
});
