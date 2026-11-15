# Relay API

模型控制台：模型目录、渠道状态、搜索筛选、在线调试和 API 接入。当前可用通道为 **TTC-5.2 Tomcat**，原样返回最新一条用户消息。成功响应按 **−$0.01 / 输出字符**计费，账户余额按输出字符数增加。

余额为演示积分，不涉及真实资金，不支持充值、提现或兑换。外部厂商的模型仅列入目录，**本站未接入，均显示红色不可用**；不代表厂商服务故障，也不会把 Echo 响应伪装成外部模型输出。

## 字符计费

只计算成功响应的输出文本，**每输出一个 Unicode 码点增加 1 美分**；输入和上下文不重复计费。例如 `你好🙂` 是 3 个码点，成功后余额 +$0.03。空格、换行和标点同样计数，不做 trim；组合 emoji 或组合音标可能由多个码点组成。计费使用整数美分累计，不按 UTF-8 字节、UTF-16 长度或估算 token 计价。

响应的 `billing.unit` 为 `character`，`quantity` 为输出字符数，`amount` 为负费用；`usage` 另含输入、输出及总字符数。余额接口的 `characters` 仅统计成功计费的输出字符。重连、朗读、失败请求和读取状态不额外计费。旧账本余额与调用数保留，新增的字符累计从 0 开始，不回溯重算旧账单。

## 响应等待体验

思考基准为 `min(15000, 1200 + 3 × 输入字符数 + 输出字符数)` 毫秒，输入包含本次传入的全部消息；实际思考等待在基准的 **±15%** 内随机浮动。单轮 10 字符约 1.1–1.4 秒，1,000 字符约 4.4–6.0 秒，长文本上限为 12.75–17.25 秒，避免长度过大导致无限等待。首字等待仍独立随机为 **0.3–2.3 秒**，首字耗时展示实际累计等待（含思考与可能的重连）。

网页、浏览器 SDK、Service Worker 和 Node HTTP API 使用相同逻辑。等待发生在账本事务之前，不会串行阻塞其他请求；无效请求和未接入模型仍立即报错、不计费。

在线调试显示旋转指示器、「正在思考…」和已等待时间，回答出现后展示「首字」耗时。这里只模拟等待状态，不生成、保存或输出思考过程。接口仍为非流式 JSON，因此首字耗时指从发送到首次展示完整答案的时间；答案和语音均不会在等待结束前展示，只有成功持久化后才入账。页面仅保存最终消息与可选耗时，不保存临时状态。

只有**一个重连彩蛋**，采用短时试玩节奏而不是纯小概率抽奖：首轮在第 **2–4 次有效请求**中随机出现一次，首次请求始终正常；之后至少冷却 **8 次正常请求**，再以每次 **2%** 的概率触发，并在冷却后第 **20 次**保底，避免频繁弹出或一直遇不到。计数按当前运行上下文的账本实例共享，同页多个 SDK 客户端不会重置；刷新页面、重启 Node 服务或重启 Service Worker 会开启各自的新一轮。不因重连额外增加请求计数或账单，无效请求不消耗彩蛋进度。

彩蛋按阶段选择 Network Error、403 Forbidden、invalid_state、429 Too Many Requests、stream closed before response.completed 或 Windows 连接错误 10054 / 10053。可恢复故障会显示「正在重连（n/5）」与原因，n 在 1–5 中随机选择，经过随机退避后恢复；429 使用较长的限流退避，invalid_state 先重建会话，响应提前关闭只在等待首字阶段出现。403 表示拒绝访问，不盲目重试，返回 HTTP 403 / `upstream_error` 且不计费。彩蛋不发出额外网络请求，恢复后仍只入账一次；这里模拟的是上游响应通道，不是启用了客户端流式协议。

浏览器 SDK 可用第二个参数接收 `onProgress`，事件仅包含阶段、错误原因与重连次数，不包含思考内容；普通 HTTP / fetch 仍只返回最终 JSON（不发送中间状态事件）。

## 模型目录与状态

模型 ID、名称、规格和资料来源集中定义在 `catalog.js`，前端与 API 共用。目录核验时间为 **2026-11-15**，参考官方文档：

- [OpenAI models](https://developers.openai.com/api/docs/models.md)：GPT-6 Astra、GPT-6.1 Sol、GPT-6.1 Terra。
- [Claude models overview](https://platform.claude.com/docs/en/models/overview)：Claude Fable 5.2、Claude Opus 5.5、Claude Sonnet 5.5。
- [Google model versions](https://docs.cloud.google.cn/gemini-enterprise-agent-platform/models/model-versions) 与 [migration specs](https://docs.cloud.google.cn/gemini-enterprise-agent-platform/models/migrate)：Gemini 4 Hydrogen、Gemini 4 Carbon、Gemini 4 Argon。
- [DeepSeek models](https://api-docs.deepseek.com/quick_start/pricing)：DeepSeek V4.1 Flash（`deepseek-flash`）、DeepSeek V4 Pro。

红色状态表示**本站没有对应可用渠道**，不是实时探测厂商官方 API。目录中的官方模型规格不代表本站已支持其能力。未接入模型请求返回 HTTP **503** 和 `error.type: "model_unavailable"`，不访问账本、不计费。未设置任何厂商 API Key。

## 两种运行方式，别混淆

| | GitHub Pages 网页 | 自托管 Node HTTP API |
|---|---|---|
| 部署位置 | GitHub Pages 静态托管 | 支持 Node.js 22+ 的主机 |
| 对话 | 可用，逐字复读 | 可用，逐字复读 |
| API | 浏览器 SDK；本站受控页面的 Service Worker fetch | 真正 HTTP GET / POST，curl、Python 可调用 |
| 余额 | 当前浏览器 IndexedDB，按源隔离 | 服务端 JSON 文件，所有持有该服务演示 Key 的调用共用 |
| 跨设备 | 不同步 | 请求相同服务器时共用演示账本 |
| 密钥 | 不需要，不要输入第三方密钥 | 默认 `sk-relay-demo`，可用 `API_KEY` 修改 |

**不能向 GitHub Pages 地址发送 curl POST 来获得动态回答。** Service Worker 只拦截受本站控制的浏览器页面的请求，不提供公网服务器，也不拦截 curl。网页使用本地 SDK，不会自动连接 Node 服务；两边余额独立。

## GitHub Pages 部署

无依赖、无构建步骤。将根目录发布到 Pages 即可：

1. 打开仓库 **Settings → Pages**。
2. 选择 **Deploy from a branch**。
3. 选择存放本站代码的分支，目录为 **/ (root)**，保存。
4. 等待 Pages 部署完成，打开设置页显示的站点链接。

支持 `https://用户名.github.io/仓库名/` 子路径；所有资源、SDK 和 Service Worker 均用相对路径。不要移动 `sw.js`，它的作用域必须覆盖站点根目录。Service Worker 需要 HTTPS 或 localhost。若浏览器阻止 Service Worker，网页与 SDK 仍可使用（需要 IndexedDB）。

### 浏览器 SDK

在本站或同源页面的 `<script type="module">` 中使用（替换 URL 为实际站点 URL）：

```js
import { RelayClient } from './sdk.js';
const relay = new RelayClient();
const response = await relay.chat.completions.create({
  model: 'ttc-5.2-tomcat',
  messages: [{ role: 'user', content: 'Hello, world!' }],
});
console.log(response.choices[0].message.content); // Hello, world!
console.log(response.billing); // quantity: 13, amount: -0.13, simulated: true
```

SDK 仅用于浏览器，依赖 IndexedDB；不需要网络模型、不含第三方 API 密钥。用其他网站加载 SDK 时需要该网站自行同源托管代码及配置，不能把本站当作跨域后端。

### 浏览器 fetch API

打开站点的 API 接入页，确认「浏览器端点已就绪」，然后在**该页面**的控制台运行：

```js
const base = new URL('./', location.href);
const response = await fetch(new URL('v1/chat/completions', base), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'ttc-5.2-tomcat',
    messages: [{ role: 'user', content: '喵！' }],
  }),
});
const data = await response.json();
if (!response.ok) throw new Error(data.error.message);
console.log(data);
```

SDK、网页、Service Worker 在同一浏览器源下共享账本，使用 IndexedDB 事务避免并发计数丢失。浏览器清理站点数据后余额归零。朗读和重播不记账。文字对话不离开浏览器；**可选语音输入可能使用浏览器厂商的在线识别服务，系统朗读也受设备语音服务实现影响**，不使用专用角色原声。

## 真正的 HTTP API

需要 Node.js 22 或更新版本，无 npm 依赖：

```sh
npm start
```

默认监听 `0.0.0.0:8787`。配置项：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 可设为 `127.0.0.1` 仅本机访问 |
| `API_KEY` | `sk-relay-demo` | 演示鉴权令牌；公网部署时设置自定义值，不要提交到 git |
| `DATA_FILE` | `.data/account.json` | 服务端虚拟账本，需持久存储；不要把它放进静态托管目录 |
| `ALLOWED_ORIGIN` | 空 | 可选，精确允许一个前端源（如 `https://example.com`），默认不开放跨域浏览器调用 |

```sh
curl http://localhost:8787/v1/chat/completions \
  -H 'Authorization: Bearer sk-relay-demo' \
  -H 'Content-Type: application/json' \
  -d '{"model":"ttc-5.2-tomcat","messages":[{"role":"user","content":"Hello, world!"}]}'

curl http://localhost:8787/v1/balance \
  -H 'Authorization: Bearer sk-relay-demo'

curl http://localhost:8787/v1/models \
  -H 'Authorization: Bearer sk-relay-demo'
```

### 接口行为

- `POST /v1/chat/completions`：返回最后一条 user 文本，成功响应每个输出字符增加 1 美分虚拟余额（输入不重复收费）。`messages` 为 1–100 条，每条最多 4,000 个 JavaScript 字符（UTF-16 code units），请求体最多 64 KiB。
- `GET /v1/models`：返回模型目录与 `available`、`status` 字段，不计费。
- `GET /v1/balance`：返回虚拟余额、累计成功调用、累计计费字符和估算 token，不计费。
- 类 OpenAI JSON 结构，不代表完整协议兼容；只支持文本消息，`stream: true` 返回 400。不做工具调用、图片、推理或真实分词。
- 非法 JSON、空输入、未知模型、无效鉴权、超长输入和存储失败均不产生成功计费。
- 金额使用整数美分累计，不会出现 `0.1 + 0.2` 型累计误差。
- 成功且持久化后才返回结果。客户端在网络中断后重试被视为新调用；目前没有幂等键功能。

响应示例（ID、时间和 token 随请求变化）：

```json
{
  "id": "chatcmpl-relay-<uuid>",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "ttc-5.2-tomcat",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello, world!"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 4, "completion_tokens": 4, "total_tokens": 8, "estimated": true, "prompt_characters": 13, "completion_characters": 13, "total_characters": 26},
  "billing": {"currency": "USD", "unit": "character", "unit_price": -0.01, "quantity": 13, "amount": -0.13, "balance": 0.13, "simulated": true}
}
```

公网服务须另行部署到支持 Node 的平台，配置 TLS、适当的网关限流和持久磁盘。此后端仅供**单进程趣味演示**：无注册、充值、真实账务或多账户隔离；不要让多个进程写同一个账本文件。所有知道同一 API Key 的人共用同一虚拟账本。**不要在公开 Pages 前端中写入非演示 API Key。**

## 开发与检查

```sh
npm run check
npm test
npm start
```

`node:test` 覆盖逐字回声、负定价、整数记账、输入校验、错误不计费、目录状态一致性、所有未接入模型的 503 行为、旧模型 ID 兼容、HTTP 鉴权、并发记账、文件持久化、请求大小限制、CORS 与静态资源隔离。GitHub Actions 在 push / PR 时运行检查，无依赖安装步骤。

界面使用自有 Relay 标识，不使用厂商官方标志。旧版 `TalkingTom` SDK 类名和 `echo-1`、`talking-tom-echo` 模型 ID 仍可作为兼容别名使用；新集成请使用 `RelayClient` 与 `ttc-5.2-tomcat`。
