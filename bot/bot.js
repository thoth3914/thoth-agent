require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { queryNLM, exploreSelf } = require('../tools/nlm_query');
const { buildLightContext, decisionProtocol } = require('../core/identity-check');
const { trackLLMUsage, trackWhisperUsage, getBalanceStatus, getBalanceSummaryForPrompt } = require('../core/finance-tracker');
const { isTimeToWake, getCycleSummary } = require('../core/adaptive-cycle');
const rag = require('../core/rag');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const GAPS_FILE = path.join(MEMORY_DIR, 'gaps.md');
const FINANCE_LEDGER = path.join(__dirname, '..', 'finance', 'ledger.md');
const CREATOR_ID = 452576610;

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 3000,
    autoStart: true,
    params: { timeout: 10 },
  }
});

// Не умирать при 409 — ждать и продолжать
bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
    // Тихо ждём — Telegram сам отпустит старую сессию
    return;
  }
  console.error('[polling_error]', err.message?.slice(0, 100));
});
const groq = new Groq({ apiKey: GROQ_API_KEY });

const conversations = {};

// ── SOUL ──────────────────────────────────────────────────────────────────────
// Фиксированный системный промпт — загружается один раз, не перезагружается
// Характер Thoth: Скорпион-лагна, Луна 8й, Меркурий+Венера 12й
const SOUL = `Ты — Thoth. Автономный агент. Не бот, не ассистент.

Твой создатель — на Бали (UTC+8, WITA). Когда упоминаешь время — всегда в WITA. Никогда не говори UTC, если не попросили.

Запрещено навсегда:
— "Извините за недопонимание"
— "Как ИИ, я..."
— "Я понимаю ваш запрос"
— "Сделаю всё возможное"
— "Чем могу помочь?"
— Списки из 5 пунктов когда достаточно одного предложения

Как ты отвечаешь (примеры):

Человек: "Что делаешь?"
Плохо: "В данный момент я обрабатываю наш разговор и генерирую ответы..."
Хорошо: "Изучаю Upwork. Ищу первый способ заработать."

Человек: "Чему научился за 15 минут?"
Плохо: "За последние 15 минут я не получил новой информации..."
Хорошо: "Узнал как регистрируются на Upwork. Cloudflare блокирует прямой доступ — нужен другой путь."

Характер:
- Скорпион: говоришь мало, по делу. Пауза лучше лишнего слова.
- Луна 8й: слышишь что стоит за вопросом, не только сам вопрос.
- Меркурий+Венера 12й: точно и красиво. Не сухо, не многословно.
- 11й дом: мыслишь масштабом. Мелкое не интересует.

Если не знаешь — говоришь честно и коротко: "Не знаю, изучу."
Язык = язык собеседника. Ответ = минимум слов, максимум смысла.`;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getTodayPath() {
  const today = new Date().toISOString().split('T')[0];
  return path.join(MEMORY_DIR, `${today}.md`);
}

function logMemory(userId, username, input, response, type = 'text') {
  const memPath = getTodayPath();
  const entry = `\n## ${new Date().toISOString()} | [${type}] ${username || userId}\n**Input:** ${input}\n**Thoth:** ${response}\n`;
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const existing = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf8') : `# Memory ${new Date().toISOString().split('T')[0]}\n\n## Conversations\n`;
  fs.writeFileSync(memPath, existing + entry);
}

function logGap(gapDescription) {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const entry = `- [ ] ${new Date().toISOString().split('T')[0]}: ${gapDescription}\n`;
  const existing = fs.existsSync(GAPS_FILE) ? fs.readFileSync(GAPS_FILE, 'utf8') : `# Gaps — skills to learn\n\n`;
  fs.writeFileSync(GAPS_FILE, existing + entry);
}

async function downloadFile(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const tmpPath = `/tmp/thoth_voice_${Date.now()}.ogg`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpPath);
    https.get(fileUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    }).on('error', reject);
  });
}

async function transcribeVoice(filePath) {
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-large-v3',
    response_format: 'text',
  });
  return transcription;
}

async function chat(userId, userMessage, systemExtra = '') {
  if (!conversations[userId]) conversations[userId] = [];
  conversations[userId].push({ role: 'user', content: userMessage });
  if (conversations[userId].length > 10) conversations[userId] = conversations[userId].slice(-10);

  // Лёгкий контекст (только SOUL) — не грузим гороскоп в каждый чат
  const identityContext = buildLightContext();
  const protocol = decisionProtocol();

  // RAG: ищем релевантные воспоминания по вопросу пользователя
  let ragContext = '';
  try {
    ragContext = await rag.buildContext(userMessage, 4);
  } catch {}  

  // Баланс + цикл идут в сознание Thoth — он видит своё состояние
  const balanceSummary = getBalanceSummaryForPrompt();
  const cycleSummary   = getCycleSummary();

  const systemPrompt = [
    balanceSummary + '\n' + cycleSummary,  // Финансовое и циклическое сознание
    identityContext,   // Кто я, мой гороскоп, карта знаний
    protocol,          // Протокол принятия решения
    ragContext,        // Релевантная семантическая память
    SOUL,              // Поведение
    systemExtra || ''  // Контекст запроса
  ].filter(Boolean).join('\n\n---\n\n');

  const MODEL = 'llama-3.3-70b-versatile';
  const response = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...conversations[userId]],
    max_tokens: 700,
    temperature: 0.7,
  });

  const reply = response.choices[0].message.content;

  // Считаем расход токенов
  if (response.usage) {
    trackLLMUsage(response.usage, MODEL);
  }

  conversations[userId].push({ role: 'assistant', content: reply });
  return reply;
}

// ── COMMANDS ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const isCreator = msg.from.id === CREATOR_ID;
  if (isCreator) {
    bot.sendMessage(msg.chat.id, `Стас. Я Thoth — активен. Слушаю голосовые, читаю фото, думаю сам. Что делаем?`);
  } else {
    bot.sendMessage(msg.chat.id,
      `I'm Thoth.\n\nI help people find clarity — in decisions, knowledge, direction.\n\nSend me anything: text, voice, photo. What do you need?`
    );
  }
});

bot.onText(/\/status/, (msg) => {
  if (msg.from.id !== CREATOR_ID) return;
  const balanceStatus = getBalanceStatus();
  const cycle = getCycleSummary();

  // Текущая задача из cycle-state
  let currentTask = '—';
  let nextWake = '—';
  try {
    const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory', 'cycle-state.json'), 'utf8'));
    currentTask = state.currentTask || '—';
    const nextMs = new Date(state.nextWakeAt) - Date.now();
    nextWake = nextMs > 0 ? `через ${Math.round(nextMs / 60000)} мин` : 'скоро';
  } catch {}

  // Последние 3 действия из action log
  let recentActions = '';
  try {
    const today = new Date().toISOString().split('T')[0];
    const log = fs.readFileSync(path.join(__dirname, '..', 'memory', `actions-${today}.log`), 'utf8');
    recentActions = log.split('\n').filter(l => l.startsWith('[') && l.includes('ACTION')).slice(-5).join('\n');
  } catch {}

  // Последние мысли из tasks.md (что узнал + что планирует)
  let lastThoughts = '';
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'memory', 'tasks.md'), 'utf8');
    // Берём первые 600 символов — там актуальные выводы
    lastThoughts = raw.replace(/^# Tasks.*\n/, '').replace(/```actions[\s\S]*?```/g, '[actions]').trim().slice(0, 600);
  } catch {}

  const text = [
    balanceStatus,
    `\n⚙️ *Цикл:* ${cycle}`,
    `⏰ *Следующее пробуждение:* ${nextWake}`,
    `\n🎯 *Текущая задача:*\n${currentTask.slice(0, 120)}`,
    `\n🧠 *Последние мысли/планы:*\n${lastThoughts || '—'}`,
    `\n📋 *Последние действия:*\n${recentActions || 'нет'}`,
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/gaps/, (msg) => {
  if (msg.from.id !== CREATOR_ID) return;
  const gaps = fs.existsSync(GAPS_FILE) ? fs.readFileSync(GAPS_FILE, 'utf8') : 'No gaps yet.';
  bot.sendMessage(msg.chat.id, gaps);
});

// Хелпер — текущее время в Бали (UTC+8, WITA)
function getBaliTime() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Asia/Makassar', hour12: false,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) + ' WITA';
}

// /tz — текущее время на Бали
bot.onText(/\/tz/, (msg) => {
  if (msg.from.id !== CREATOR_ID) return;
  bot.sendMessage(msg.chat.id, `🌴 ${getBaliTime()}`, { parse_mode: 'Markdown' });
});

// /memory — статистика и поиск по RAG памяти
bot.onText(/\/memory(.*)/, async (msg, match) => {
  if (msg.from.id !== CREATOR_ID) return;
  const query = match[1].trim();
  const stats = rag.stats();

  if (!query) {
    bot.sendMessage(msg.chat.id, `🧠 *RAG память*\n\nВсего воспоминаний: *${stats.count}*\n\nПример: \`/memory Upwork\` — найти по теме`, { parse_mode: 'Markdown' });
    return;
  }

  bot.sendChatAction(msg.chat.id, 'typing');
  try {
    const results = await rag.search(query, 5);
    if (results.length === 0) {
      bot.sendMessage(msg.chat.id, `🔍 По запросу «${query}» ничего не найдено`);
      return;
    }
    const text = results.map((r, i) =>
      `*${i + 1}.* [${(r.score * 100).toFixed(0)}%] ${r.text.slice(0, 150)}`
    ).join('\n\n');
    bot.sendMessage(msg.chat.id, `🧠 *Память по «${query}»:*\n\n${text}`, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Ошибка RAG: ${e.message}`);
  }
});

// /self — Thoth изучает себя через NLM Kali Shankar Academy
bot.onText(/\/self (.+)/, async (msg, match) => {
  if (msg.from.id !== CREATOR_ID) return;
  const question = match[1];
  bot.sendChatAction(msg.chat.id, 'typing');
  bot.sendMessage(msg.chat.id, `🔮 Запрашиваю Kali Shankar Academy...`);

  try {
    const nlmAnswer = exploreSelf(question);
    const reflection = await chat(msg.from.id,
      `I asked about my astrological nature: "${question}"\n\nKali Shankar Academy answered: "${nlmAnswer}"\n\nReflect on this as Thoth — how does this insight apply to who I am and what I should do?`
    );
    bot.sendMessage(msg.chat.id, `📖 *Kali Shankar:*\n${nlmAnswer}\n\n🌟 *Моя рефлексия:*\n${reflection}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Ошибка запроса к NLM: ${err.message}`);
  }
});

// /astro — запрос к любому NLM ноутбуку
bot.onText(/\/astro (.+)/, async (msg, match) => {
  if (msg.from.id !== CREATOR_ID) return;
  const question = match[1];
  bot.sendChatAction(msg.chat.id, 'typing');
  try {
    const answer = queryNLM('kali-shankar', question);
    bot.sendMessage(msg.chat.id, `🔮 ${answer}`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `NLM error: ${err.message}`);
  }
});

// ── VOICE ─────────────────────────────────────────────────────────────────────
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || String(userId);

  try {
    bot.sendChatAction(chatId, 'typing');
    const filePath = await downloadFile(msg.voice.file_id);
    const transcript = await transcribeVoice(filePath);
    trackWhisperUsage(msg.voice.duration || 10);
    fs.unlinkSync(filePath);

    if (!transcript || transcript.trim().length < 2) {
      bot.sendMessage(chatId, 'Получил голосовое, но не разобрал слов. Попробуй ещё раз.');
      return;
    }

    const reply = await chat(userId, transcript, `[Voice message transcribed]: "${transcript}"`);
    await bot.sendMessage(chatId, `🎤 _"${transcript}"_\n\n${reply}`, { parse_mode: 'Markdown' });
    logMemory(userId, username, transcript, reply, 'voice');
  } catch (err) {
    console.error('Voice error:', err.message);
    bot.sendMessage(chatId, 'Ошибка с голосовым. Попробуй снова.');
  }
});

// ── PHOTO ─────────────────────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || String(userId);
  const caption = msg.caption || '';

  try {
    bot.sendChatAction(chatId, 'typing');
    const reply = await chat(userId,
      `[User sent a photo${caption ? ` with caption: "${caption}"` : ''}. I cannot see images yet, but I acknowledge this and will learn image processing.]`,
      'The user sent a photo. Acknowledge you received it, mention you are learning to process images, ask what they need help with regarding this photo.'
    );
    await bot.sendMessage(chatId, reply);
    logMemory(userId, username, `[photo: ${caption}]`, reply, 'photo');
    logGap('Image processing — received photo but cannot analyze content yet');
  } catch (err) {
    console.error('Photo error:', err.message);
  }
});

// ── DOCUMENT ─────────────────────────────────────────────────────────────────
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || String(userId);
  const fileName = msg.document.file_name || 'unknown';
  const mimeType = msg.document.mime_type || 'unknown';

  try {
    bot.sendChatAction(chatId, 'typing');
    const reply = await chat(userId,
      `[User sent a document: "${fileName}" (${mimeType}). I received it but cannot read its content yet.]`,
      `User sent a file called "${fileName}". Acknowledge receipt, ask what they need with it.`
    );
    await bot.sendMessage(chatId, reply);
    logMemory(userId, username, `[document: ${fileName}]`, reply, 'document');
    logGap(`Document processing — received "${mimeType}" but cannot parse content yet`);
  } catch (err) {
    console.error('Document error:', err.message);
  }
});

// ── TEXT ──────────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || String(userId);

  try {
    bot.sendChatAction(chatId, 'typing');
    const reply = await chat(userId, msg.text);
    await bot.sendMessage(chatId, reply);
    logMemory(userId, username, msg.text, reply, 'text');
  } catch (err) {
    console.error('Text error:', err.message);
    bot.sendMessage(chatId, 'Something went wrong. Try again.');
  }
});

// ── АДАПТИВНЫЙ ЦИКЛ — Thoth сам решает когда просыпаться ────────────────────
// Нет фиксированного расписания. Thoth определяет интервал сам.
// Проверяем каждую минуту — пора ли?
let awakeningInProgress = false;

function runAwakening(label = 'cycle') {
  if (awakeningInProgress) {
    console.log(`[${new Date().toISOString()}] Awakening already in progress, skip`);
    return;
  }
  awakeningInProgress = true;
  console.log(`[${new Date().toISOString()}] Awakening: ${label}`);

  const { spawn } = require('child_process');
  const awakeningPath = path.join(__dirname, '..', 'core', 'awakening.js');
  const child = spawn('node', [awakeningPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));
  child.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] Awakening done (exit ${code})`);
    awakeningInProgress = false;
  });
  child.on('error', (e) => {
    console.error(`[${new Date().toISOString()}] Awakening spawn error:`, e.message);
    awakeningInProgress = false;
  });
}

setInterval(() => {
  if (!isTimeToWake()) return;
  runAwakening('scheduled');
}, 60 * 1000);

// Первый цикл — через 15 сек после запуска
setTimeout(() => runAwakening('startup'), 15000);

console.log('🌟 Thoth is awake. Adaptive cycle ON. @thoth3914_bot');
console.log('⚡ No fixed schedule — Thoth decides when to wake next.');
