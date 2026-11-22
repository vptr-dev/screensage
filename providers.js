// Answer providers: local first (Ollama, LM Studio), then cloud providers
// that need the user's own API key. Every provider takes the same
// message shape: { role, content, images?: [base64 JPEG] }.

class AppError extends Error {
  constructor(message, code = 'ai_error') {
    super(message);
    this.code = code;
  }
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status; // null when the server couldn't be reached
    this.body = body || '';
  }
}

// Order shown in Settings: local first, then cloud.
const PROVIDERS = {
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    kind: 'local',
    needsKey: false,
    baseUrl: 'http://localhost:11434',
    defaultModel: 'gemma4:12b',
    keyUrl: '',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'local',
    needsKey: false,
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    keyUrl: '',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    kind: 'cloud',
    needsKey: true,
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-haiku-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    kind: 'cloud',
    needsKey: true,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    kind: 'cloud',
    needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: '',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'cloud',
    needsKey: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
};

// ---------- HTTP ----------

async function send(url, { method = 'GET', headers = {}, json, signal, timeout = 300000 } = {}) {
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (signal && signal.aborted) throw new AppError('Stopped.', 'aborted');
    throw new HttpError(null, String(err));
  }
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
  return res;
}

async function getJson(url, options) {
  return (await send(url, options)).json();
}

async function postJson(url, json, options = {}) {
  return (await send(url, { ...options, method: 'POST', json })).json();
}

/** Turn an HTTP problem into a message a beginner can act on. */
function friendly(info, model, error) {
  if (!(error instanceof HttpError)) return error;
  const label = info.label;
  if (error.status === null) {
    if (info.kind === 'local') {
      return new AppError(`Couldn't reach ${label} at ${info.baseUrl}. Is it installed and running?`, 'unreachable');
    }
    return new AppError(`Couldn't reach ${label}. Check your internet connection.`, 'unreachable');
  }
  if (error.status === 401 || error.status === 403) {
    return new AppError(`${label} refused the API key. Check it in Settings.`, 'bad_key');
  }
  if (error.status === 404) {
    if (info.id === 'ollama') {
      return new AppError(`The model ${model} isn't downloaded yet. Get it in Settings → Model → Download.`, 'model_missing');
    }
    return new AppError(`${label} doesn't know the model '${model}'. Pick another in Settings.`, 'model_missing');
  }
  if (error.status === 429) {
    return new AppError(`${label} says you've hit a rate limit or run out of credits. Try again later.`, 'rate_limited');
  }
  return new AppError(`${label} returned an error (${error.status}). ${error.body.trim().slice(0, 200)}`, 'provider_error');
}

function splitSystem(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  return { system, rest: messages.filter((m) => m.role !== 'system') };
}

// ---------- Ollama (streams the answer as it is written) ----------

async function ollamaChat({ info, model, messages, onChunk, onThinking, think, temperature = 0.2, signal }) {
  const payload = {
    model,
    messages,
    stream: true,
    options: { temperature },
    // Models like gemma4 "think" first by default, which makes answers 2-3x
    // slower, so it is only on when the user asks for it.
    think: !!think,
  };
  const url = `${info.baseUrl}/api/chat`;
  let res;
  try {
    res = await send(url, { method: 'POST', json: payload, signal, timeout: 600000 });
  } catch (error) {
    // A model (or an older Ollama) that refuses the "think" setting: ask again without it.
    if (error instanceof HttpError && error.status === 400 && error.body.includes('think')) {
      const { think, ...without } = payload;
      res = await send(url, { method: 'POST', json: without, signal, timeout: 600000 });
    } else {
      throw error;
    }
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const handle = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new AppError(`Ollama: ${data.error}`);
    const thought = (data.message && data.message.thinking) || '';
    if (thought) onThinking(thought);
    const piece = (data.message && data.message.content) || '';
    if (piece) {
      text += piece;
      onChunk(piece);
    }
  };
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handle);
    }
    handle(buffer);
  } catch (err) {
    if (signal && signal.aborted) throw new AppError('Stopped.', 'aborted');
    throw err;
  }
  return text;
}

async function ollamaModels({ info }) {
  const data = await getJson(`${info.baseUrl}/api/tags`, { timeout: 5000 });
  const models = data.models || [];
  // Newer Ollama says what each model can do. If it does, only show models that can see.
  const knowsVision = models.some((m) => Array.isArray(m.capabilities));
  return models
    .filter((m) => !knowsVision || (m.capabilities || []).includes('vision'))
    .map((m) => m.name)
    .sort();
}

// ---------- Claude ----------

const ANTHROPIC_VERSION = '2023-06-01';
// Current Claude models think before answering, and that thinking counts
// toward this limit, so leave plenty of room.
const ANTHROPIC_MAX_TOKENS = 16000;

const anthropicHeaders = (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION });

async function anthropicChat({ info, model, apiKey, messages, signal, onThinking }) {
  const { system, rest } = splitSystem(messages);
  // No "temperature": current Claude models reject it (HTTP 400).
  const payload = {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages: rest.map((m) => {
      if (!m.images || !m.images.length) return { role: m.role, content: m.content };
      // Claude wants pictures as content blocks, before the text.
      const blocks = m.images.map((data) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data },
      }));
      blocks.push({ type: 'text', text: m.content });
      return { role: m.role, content: blocks };
    }),
  };
  if (system) payload.system = system;
  const data = await postJson(`${info.baseUrl}/v1/messages`, payload, { headers: anthropicHeaders(apiKey), signal });
  if (data.stop_reason === 'refusal') {
    throw new AppError('Claude declined to answer this one. Try another provider.', 'refused');
  }
  // "thinking" blocks are the model's reasoning; only "text" blocks are the answer.
  const thoughts = (data.content || [])
    .filter((b) => b.type === 'thinking' && b.thinking)
    .map((b) => b.thinking)
    .join('\n\n');
  if (thoughts) onThinking(thoughts);
  const text =(data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  if (!text) throw new AppError('Claude sent an empty answer.');
  return text;
}

async function anthropicModels({ info, apiKey }) {
  const data = await getJson(`${info.baseUrl}/v1/models?limit=100`, { headers: anthropicHeaders(apiKey) });
  return (data.data || []).map((m) => m.id).sort();
}

// ---------- OpenAI-style: OpenAI, OpenRouter, LM Studio ----------

const bearer = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

async function openaiChat({ info, model, apiKey, messages, temperature = 0.2, signal }) {
  const payload = {
    model,
    temperature,
    messages: messages.map((m) => {
      if (!m.images || !m.images.length) return { role: m.role, content: m.content };
      const parts = [{ type: 'text', text: m.content }];
      for (const data of m.images) {
        parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } });
      }
      return { role: m.role, content: parts };
    }),
  };
  const url = `${info.baseUrl}/chat/completions`;
  let data;
  try {
    data = await postJson(url, payload, { headers: bearer(apiKey), signal });
  } catch (error) {
    // Some newer models only accept their default temperature: ask again without it.
    if (error instanceof HttpError && error.status === 400 && error.body.includes('temperature')) {
      const { temperature, ...without } = payload;
      data = await postJson(url, without, { headers: bearer(apiKey), signal });
    } else {
      throw error;
    }
  }
  try {
    return String(data.choices[0].message.content || '');
  } catch {
    throw new AppError(`${info.label} sent an answer the app didn't understand.`);
  }
}

async function openaiModels({ info, apiKey }) {
  const data = await getJson(`${info.baseUrl}/models`, { headers: bearer(apiKey), timeout: 15000 });
  return (data.data || []).map((m) => m.id).sort();
}

// ---------- Gemini ----------

async function geminiChat({ info, model, apiKey, messages, temperature = 0.2, signal }) {
  const { system, rest } = splitSystem(messages);
  const payload = {
    contents: rest.map((m) => ({
      // Gemini calls the assistant "model".
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }].concat(
        (m.images || []).map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } })),
      ),
    })),
    generationConfig: { temperature },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  const name = model.replace(/^models\//, '');
  const data = await postJson(`${info.baseUrl}/models/${name}:generateContent`, payload, {
    headers: { 'x-goog-api-key': apiKey },
    signal,
  });
  try {
    return data.candidates[0].content.parts.map((p) => p.text || '').join('');
  } catch {
    throw new AppError('Gemini sent an empty answer (it may have been blocked).');
  }
}

async function geminiModels({ info, apiKey }) {
  const data = await getJson(`${info.baseUrl}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort();
}

// ---------- the one interface the app uses ----------

const IMPL = {
  ollama: { chat: ollamaChat, models: ollamaModels },
  lmstudio: { chat: openaiChat, models: openaiModels },
  anthropic: { chat: anthropicChat, models: anthropicModels },
  openai: { chat: openaiChat, models: openaiModels },
  gemini: { chat: geminiChat, models: geminiModels },
  openrouter: { chat: openaiChat, models: openaiModels },
};

function infoFor(providerId, baseUrl = '') {
  const info = PROVIDERS[providerId];
  if (!info) throw new AppError(`Unknown provider '${providerId}'.`, 'unknown_provider');
  // The user can point a provider at another address (say, Ollama on another PC).
  return baseUrl ? { ...info, baseUrl: baseUrl.replace(/\/+$/, '') } : info;
}

function requireKey(info, apiKey) {
  if (info.needsKey && !apiKey) {
    throw new AppError(`Add your ${info.label} API key in Settings first.`, 'missing_key');
  }
}

/**
 * Send the conversation and return the full reply. onChunk gets the text as it
 * arrives (Ollama streams; the cloud providers deliver it in one piece), and
 * onThinking gets the model's reasoning when the provider shares it.
 */
async function chat(
  providerId,
  { model, apiKey = '', baseUrl = '', messages, think = false, temperature, onChunk = () => {}, onThinking = () => {}, signal },
) {
  const info = infoFor(providerId, baseUrl);
  requireKey(info, apiKey);
  if (!model) throw new AppError(`Pick a ${info.label} model in Settings first.`, 'missing_model');
  try {
    if (providerId === 'ollama') {
      return await ollamaChat({ info, model, messages, onChunk, onThinking, think, temperature, signal });
    }
    const text = await IMPL[providerId].chat({ info, model, apiKey, messages, temperature, signal, onThinking });
    onChunk(text);
    return text;
  } catch (error) {
    throw friendly(info, model, error);
  }
}

async function listModels(providerId, { apiKey = '', baseUrl = '' } = {}) {
  const info = infoFor(providerId, baseUrl);
  requireKey(info, apiKey);
  try {
    return await IMPL[providerId].models({ info, apiKey });
  } catch (error) {
    throw friendly(info, '', error);
  }
}

// ---------- downloading local models ----------

// A few models that can read pictures, offered when downloading.
const SUGGESTED_DOWNLOADS = {
  ollama: ['gemma3:4b', 'gemma3:12b', 'qwen2.5vl:7b', 'llama3.2-vision', 'minicpm-v'],
  lmstudio: ['google/gemma-3-4b', 'google/gemma-3-12b', 'qwen/qwen2.5-vl-7b'],
};

async function ollamaPull({ info, model, onProgress, signal }) {
  const res = await send(`${info.baseUrl}/api/pull`, {
    method: 'POST',
    json: { model, stream: true },
    signal,
    timeout: 6 * 60 * 60 * 1000,
  });
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) {
      const missing = /not found|does not exist|manifest/i.test(data.error);
      throw new AppError(missing ? `Ollama has no model called '${model}'.` : `Ollama: ${data.error}`);
    }
    if (data.total) onProgress({ done: data.completed || 0, total: data.total });
    else if (data.status) onProgress({ status: data.status });
  };
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handle);
    }
    handle(buffer);
  } catch (err) {
    if (signal && signal.aborted) throw new AppError('Stopped.', 'aborted');
    throw err;
  }
}

async function lmstudioDownload({ info, model, onProgress, signal }) {
  // The download API lives next to the OpenAI-style one: http://host:1234/api/v1
  const root = info.baseUrl.replace(/\/v1$/, '');
  let job;
  try {
    job = await postJson(`${root}/api/v1/models/download`, { model }, { signal, timeout: 30000 });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404 && !/model/i.test(error.body)) {
      throw new AppError('Update LM Studio to 0.4 or newer to download from here.');
    }
    if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 401) {
      throw new AppError(`LM Studio couldn't find '${model}'.`);
    }
    throw error;
  }
  while (job.status !== 'completed' && job.status !== 'already_downloaded') {
    if (job.status === 'failed') throw new AppError('LM Studio couldn\'t finish the download.');
    if (job.total_size_bytes) onProgress({ done: job.downloaded_bytes || 0, total: job.total_size_bytes });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (signal && signal.aborted) throw new AppError('Stopped.', 'aborted');
    job = await getJson(`${root}/api/v1/models/download/status/${encodeURIComponent(job.job_id)}`, { signal, timeout: 15000 });
  }
}

/** Download a model into Ollama or LM Studio. onProgress gets { done, total } or { status }. */
async function downloadModel(providerId, { baseUrl = '', model, onProgress = () => {}, signal }) {
  const info = infoFor(providerId, baseUrl);
  if (info.kind !== 'local') throw new AppError('Only local models can be downloaded.');
  const name = String(model || '').trim();
  if (!name) throw new AppError('Type the name of a model first.');
  try {
    if (providerId === 'ollama') await ollamaPull({ info, model: name, onProgress, signal });
    else await lmstudioDownload({ info, model: name, onProgress, signal });
  } catch (error) {
    throw friendly(info, name, error);
  }
}

// Words that usually mark a provider's cheaper, faster models.
const CHEAP_HINTS = ['haiku', 'mini', 'flash', 'small', 'lite'];

function suggestModel(models) {
  for (const hint of CHEAP_HINTS) {
    const found = models.find((name) => name.toLowerCase().includes(hint));
    if (found) return found;
  }
  return models[0] || '';
}

module.exports = { PROVIDERS, SUGGESTED_DOWNLOADS, AppError, chat, listModels, suggestModel, downloadModel };
