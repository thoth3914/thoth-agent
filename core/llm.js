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

// Доступные модели
const MODELS = {
  groq_70b:      'llama-3.3-70b-versatile',
  groq_8b:       'llama-3.1-8b-instant',
  gemini_flash:  'gemini-2.0-flash',
  gemini_pro:    'gemini-1.5-pro',
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

  const chat = geminiModel.startChat({ history });
  const result = await chat.sendMessage(fullPrompt);
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
 * @param {string} task — тип задачи: 'thinking' | 'fast' | 'chat'
 * @param {Array}  messages — массив {role, content}
 * @param {number} maxTokens
 */
async function callLLM(task, messages, maxTokens = 800) {
  // FAST задачи → Gemini Flash если доступна (дешевле, быстрее)
  // Требует: Google Cloud billing включён + $300 credit активирован
  if (task === 'fast' && google && process.env.GOOGLE_BILLING_ENABLED === 'true') {
    try {
      return await callGemini(MODELS.gemini_flash, messages, maxTokens);
    } catch (e) {
      console.log(`[llm] Gemini failed (${e.message.slice(0,50)}), falling back to Groq`);
    }
  }

  // Всё остальное → Groq 70b
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
