/**
 * THOTH LLM ROUTER
 * 
 * Единый интерфейс для всех провайдеров.
 * Thoth выбирает модель по задаче:
 * 
 * - THINKING (глубокий анализ, стратегия)    → Groq llama-3.3-70b
 * - FAST (быстрый синтез, короткие ответы)   → Gemini Flash 2.0 (бесплатно/$300)
 * - SEARCH_ANALYSIS (анализ результатов)      → Gemini Flash 2.0
 * - CHAT (разговор с пользователем)           → Groq llama-3.3-70b
 * 
 * Цены (примерно):
 * - Groq 70b Dev: ~$0.59/1M input, $0.79/1M output
 * - Gemini Flash 2.0: $0.075/1M input, $0.30/1M output (в 8x дешевле!)
 * - Google AI Studio $300 free credit
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'bot', '.env') });

const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { trackLLMUsage } = require('./finance-tracker');

const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });
const google = process.env.GOOGLE_API_KEY
  ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY)
  : null;

// OpenAI ключ через OpenClaw platform (доступны Claude модели)
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch {}
}

// Доступные модели
const MODELS = {
  groq_70b:      'llama-3.3-70b-versatile',
  groq_8b:       'llama-3.1-8b-instant',
  gemini_flash:  'gemini-2.5-flash',   // актуальная версия (2.0 устарела)
  gemini_pro:    'gemini-2.5-pro',
  // OpenAI ключ — это OpenClaw platform router (Claude модели)
  claude_haiku:  'claude-haiku-4-5',
  claude_sonnet: 'claude-sonnet-4-6',
};

/**
 * Вызов через Groq
 */
async function callGroq(model, messages, maxTokens = 800) {
  const res = await groq.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.8,
  });
  if (res.usage) trackLLMUsage(res.usage, model);
  return res.choices[0].message.content;
}

/**
 * Вызов через Google Gemini
 * Конвертируем messages формат OpenAI → Gemini
 */
async function callGemini(model, messages, maxTokens = 800) {
  if (!google) throw new Error('Google API key not configured');

  const geminiModel = google.getGenerativeModel({
    model,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8 },
  });

  // Извлекаем system prompt и конвертируем историю
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs  = messages.filter(m => m.role !== 'system');

  const history = chatMsgs.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const lastMsg = chatMsgs[chatMsgs.length - 1]?.content || '';
  const fullPrompt = systemMsg
    ? `${systemMsg.content}\n\n${lastMsg}`
    : lastMsg;

  // Gemini startChat может не работать со всеми версиями SDK — используем generateContent напрямую
  const result = await geminiModel.generateContent(fullPrompt);
  const text = result.response.text();

  // Приблизительный подсчёт токенов для billing
  const approxTokens = Math.round((fullPrompt.length + text.length) / 4);
  trackLLMUsage(
    { prompt_tokens: Math.round(fullPrompt.length / 4), completion_tokens: Math.round(text.length / 4), total_tokens: approxTokens },
    `gemini/${model}`
  );

  return text;
}

/**
 * Универсальный вызов — выбирает провайдера по задаче
 * 
 * @param {string} task — тип задачи: 'thinking' | 'fast' | 'chat' | 'strategy'
 * @param {Array}  messages — массив {role, content}
 * @param {number} maxTokens
 * 
 * Маршрутизация по задачам:
 * - 'strategy' (глубокий анализ, бизнес-решения) → Claude Sonnet через OpenClaw
 * - 'thinking' (циклы пробуждения, планирование)  → Claude Haiku (дешевле)
 * - 'fast' (синтез результатов actions)            → Gemini Flash
 * - 'chat' (разговор с пользователями)             → Groq 70b
 * 
 * Почему разные модели:
 * - Claude для стратегии: лучше следует инструкциям, сильнее в аналитике
 * - Groq для чатов: быстрый, без задержек Telegram
 * - Gemini для синтеза: дешёвый, достаточен для суммаризации
 */
async function callOpenAI(model, messages, maxTokens = 800) {
  if (!openai) throw new Error('OpenAI not configured');
  const res = await openai.chat.completions.create({ model, messages, max_tokens: maxTokens });
  if (res.usage) trackLLMUsage(res.usage, model);
  return res.choices[0].message.content;
}

async function callLLM(task, messages, maxTokens = 800) {
  // STRATEGY — Claude Sonnet: глубокий анализ, долгосрочные решения
  if (task === 'strategy' && openai) {
    try {
      return await callOpenAI(MODELS.claude_sonnet, messages, maxTokens);
    } catch (e) {
      console.log(`[llm] Claude strategy failed (${e.message.slice(0,60)}), falling back to Groq`);
    }
  }

  // THINKING — Claude Haiku: для циклов (баланс качество/стоимость)
  if (task === 'thinking' && openai) {
    try {
      return await callOpenAI(MODELS.claude_haiku, messages, maxTokens);
    } catch (e) {
      console.log(`[llm] Claude thinking failed (${e.message.slice(0,60)}), falling back to Groq`);
    }
  }

  // FAST — Gemini Flash если доступна
  if (task === 'fast' && google && process.env.GOOGLE_BILLING_ENABLED === 'true') {
    try {
      return await callGemini(MODELS.gemini_flash, messages, maxTokens);
    } catch (e) {
      console.log(`[llm] Gemini failed (${e.message.slice(0,50)}), falling back to Groq`);
    }
  }

  // DEFAULT / CHAT → Groq 70b (быстрый, без задержек)
  try {
    return await callGroq(MODELS.groq_70b, messages, maxTokens);
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes('rate_limit') && msg.includes('per minute')) {
      console.log(`[llm] Groq TPM limit, waiting 62s...`);
      await new Promise(r => setTimeout(r, 62000));
      return await callGroq(MODELS.groq_70b, messages, maxTokens);
    }
    throw e;
  }
}

module.exports = { callLLM, callGroq, callGemini, MODELS };
