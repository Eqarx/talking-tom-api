export const CATALOG_CHECKED_AT = '2026-11-15';
export const MODEL = 'ttc-5.2-tomcat';
export const MODEL_NAME = 'TTC-5.2 Tomcat';
export const CHARACTER_PRICE_CENTS = 1;

const openai = 'https://developers.openai.com/api/docs/models';
const anthropic = 'https://platform.claude.com/docs/en/models/overview';
const google = 'https://docs.cloud.google.cn/gemini-enterprise-agent-platform/models/model-versions';
const deepseek = 'https://api-docs.deepseek.com/quick_start/pricing';

export const MODELS = [
  { id: MODEL, name: MODEL_NAME, provider: 'Relay', mark: 'R', available: true, description: '轻量级文本回声接口，原样返回最新一条用户消息，支持浏览器语音朗读。', context: '4,000 字符', tags: ['文本对话', '语音朗读'], price: -CHARACTER_PRICE_CENTS / 100, priceUnit: 'character', source: null },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'OpenAI', mark: 'O', available: false, description: '面向复杂推理、代码开发与专业工作流的旗舰模型。', context: '1.05M', tags: ['推理', '多模态'], source: `${openai}/gpt-6-astra` },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', provider: 'OpenAI', mark: 'O', available: false, description: '面向复杂编程与专业任务，兼顾能力与成本。', context: '1.05M', tags: ['代码', '推理'], source: `${openai}/gpt-6.1-sol` },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', provider: 'OpenAI', mark: 'O', available: false, description: '面向视觉推理、计算机操作与自然写作的高效模型。', context: '1.05M', tags: ['视觉', '通用'], source: `${openai}/gpt-6.1-terra` },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', provider: 'Anthropic', mark: 'A', available: false, description: '面向高难度推理与长周期智能体任务。', context: '1M', tags: ['推理', 'Agent'], source: anthropic },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'Anthropic', mark: 'A', available: false, description: '适用于长时间运行的智能体编程与知识工作。', context: '1M', tags: ['代码', 'Agent'], source: anthropic },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'Anthropic', mark: 'A', available: false, description: '平衡响应速度与智能水平的通用模型。', context: '1M', tags: ['通用', '多模态'], source: anthropic },
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', provider: 'Google', mark: 'G', available: false, description: 'Gemini 4 系列多模态模型，支持文本、图像、音频与视频输入。', context: '1M', tags: ['多模态', '通用'], source: google },
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', provider: 'Google', mark: 'G', available: false, description: 'Gemini 4 系列模型，面向多模态理解与生成任务。', context: '1M', tags: ['多模态', '通用'], source: google },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', provider: 'Google', mark: 'G', available: false, description: '支持长上下文与多模态输入的 Gemini 4 系列模型。', context: '1M', tags: ['长上下文', '多模态'], source: google },
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', provider: 'DeepSeek', mark: 'D', available: false, description: 'DeepSeek-V4.1-Flash-1017，支持思考模式与视觉输入。', context: '1M', tags: ['推理', '视觉'], source: deepseek },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'DeepSeek', mark: 'D', available: false, description: 'DeepSeek-V4-Pro-0813，支持长上下文与工具调用。', context: '1M', tags: ['推理', '工具调用'], source: deepseek },
];

export function findModel(id) {
  return MODELS.find(model => model.id === (['echo-1', 'talking-tom-echo'].includes(id) ? MODEL : id));
}
