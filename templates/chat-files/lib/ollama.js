// Thin client for the local Ollama server. Everything stays on localhost.

const os = require('node:os');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// Pick a model that fits the machine. Override with MODEL=... npm run dev
// These answer straight away (no long "thinking" phase), which feels much faster for chat.
function pickModel() {
  if (process.env.MODEL) return process.env.MODEL;
  const gb = os.totalmem() / 1024 ** 3;
  if (gb >= 30) return 'qwen3:30b-instruct'; // 18.6 GB download, mixture-of-experts so it's quick
  if (gb >= 15) return 'gemma3:12b'; // 8.2 GB
  return 'qwen3:4b-instruct'; // 2.5 GB
}

async function isRunning() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Installed chat models, smallest first. Embedding-only models are left out.
async function listModels() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const { models = [] } = await res.json();
  return models
    .filter((m) => !/embed/i.test(m.name) && !m.details?.family?.includes('bert'))
    .map((m) => ({ name: m.name, size: m.size, params: m.details?.parameter_size || '' }))
    .sort((a, b) => a.size - b.size);
}

async function hasModel(model) {
  const want = model.includes(':') ? model : `${model}:latest`;
  return (await listModels()).some((m) => m.name === want);
}

// Yields parsed JSON objects from an NDJSON response body.
async function* ndjson(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

async function* pull(model) {
  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok) throw new Error(`Pull failed: ${res.status} ${await res.text()}`);
  yield* ndjson(res.body);
}

const capabilities = new Map();

// Whether a model reasons before answering (qwen3, deepseek-r1, ...). Asked once per model.
async function canThink(model) {
  if (!capabilities.has(model)) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
      capabilities.set(model, ((await res.json()).capabilities || []).includes('thinking'));
    } catch {
      return false;
    }
  }
  return capabilities.get(model);
}

// Yields { thinking } and { token } while the model writes, then one { stats } with its speed.
// `options` are Ollama model options, e.g. { num_ctx, temperature }.
async function* chat(model, messages, { signal, options } = {}) {
  // Some reasoning models can't switch thinking off, and asking them to makes the reasoning
  // leak into the answer. So for those, ask for it as a separate stream the UI can fold away.
  const think = (await canThink(model)) || undefined;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: true, think, options }),
    signal,
  });
  if (!res.ok) throw new Error(`Chat failed: ${res.status} ${await res.text()}`);
  for await (const part of ndjson(res.body)) {
    if (part.error) throw new Error(part.error);
    if (part.message?.thinking) yield { thinking: part.message.thinking };
    if (part.message?.content) yield { token: part.message.content };
    if (part.done) {
      const seconds = (part.eval_duration || 0) / 1e9;
      yield { stats: { tokens: part.eval_count || 0, tokensPerSec: seconds ? part.eval_count / seconds : 0 } };
      return;
    }
  }
}

// A short one-off answer, e.g. a chat title. Reasoning is switched off where the model allows
// it; a model that reasons anyway runs out of words first and returns '' (the caller falls back).
async function complete(model, prompt, options = {}) {
  const think = (await canThink(model)) ? false : undefined;
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model, prompt, stream: false, think, options: { num_predict: 24, temperature: 0.2, ...options } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return '';
  const text = (await res.json()).response || '';
  return text.includes('<think>') && !text.includes('</think>') ? '' : text;
}

module.exports = { OLLAMA_URL, pickModel, isRunning, listModels, hasModel, pull, chat, complete };
