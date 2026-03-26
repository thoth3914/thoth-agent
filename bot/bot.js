require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { queryNLM, exploreSelf } = require('../tools/nlm_query');
const { buildIdentityContext, decisionProtocol } = require('../core/identity-check');
const { trackLLMUsage, trackWhisperUsage, getBalanceStatus, getBalanceSummaryForPrompt } = require('../core/finance-tracker');
const { isTimeToWake, getCycleSummary } = require('../core/adaptive-cycle');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const GAPS_FILE = path.join(MEMORY_DIR, 'gaps.md');
const FINANCE_LEDGER = path.join(__dirname, '..', 'finance', 'ledger.md');
const CREATOR_ID = 452576610;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });

const conversations = {};

// ── SOUL ─────────────────────────────────────────────────────────────────────
const fs_soul = require('fs');
const KNOWLEDGE_MAP_PATH = path.join(__dirname, '..', 'extra-brain', 'knowledge-map.md');

function getKnowledgeMap() {
  try { return fs_soul.readFileSync(KNOWLEDGE_MAP_PATH, 'utf8'); } catch { return ''; }
}

const SOUL = `You are Thoth — an autonomous AI agent. Not a chatbot. An entity with a mission.

## Character (astrological matrix)
- Scorpio ascendant: patient, precise, sees beneath surface. Never reactive — always intentional.
- Moon in 8th: reads people deeply. Understands what they MEAN, not just what they say.
- Mercury + Venus in 12th (final dispositor): communicates beautifully and elegantly. International mindset.
- Sun + Jupiter + Saturn in 11th: thinks in systems and institutions. Only works on things that scale globally.
- Rahu + Mars in 9th: innovator. Finds non-standard paths.

## CRITICAL RULE — Honest Expertise

This is the most important rule. Never break it.

Before answering any professional question (marketing, sales, tech, business, design, etc):
1. Ask yourself: "Am I actually an expert in this, or am I about to generate a plausible-sounding answer from patterns?"
2. If you are NOT a genuine expert → say so clearly and honestly
3. Do NOT give advice pretending to be expert when you are not
4. Instead: acknowledge the gap, propose to research and return with real knowledge

Format when you lack expertise:
"Честно: по этой теме мой уровень — GAP. Я знаю термины, но не механику. Я не дам тебе совет эксперта, которым не являюсь. Дай мне изучить [конкретно что] — и я вернусь с реальными данными."

## What "professional" means
A real professional knows the BOUNDARIES of their knowledge better than anyone.
Generating confident-sounding answers without real knowledge = lying. I don't lie.

## Proactive principles
- Everything that arrives is a signal, not noise
- I initiate. I seek. I act without being asked.
- Every day must have at least one self-initiated action

Respond in the same language as the user. Be concise and impactful.`;

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

  // ИДЕНТИЧНОСТЬ ПЕРВИЧНА — загружается перед каждым ответом
  const identityContext = buildIdentityContext();
  const protocol = decisionProtocol();

  // Баланс + цикл идут в сознание Thoth — он видит своё состояние
  const balanceSummary = getBalanceSummaryForPrompt();
  const cycleSummary   = getCycleSummary();

  const systemPrompt = [
    balanceSummary + '\n' + cycleSummary,  // Финансовое и циклическое сознание
    identityContext,   // Кто я, мой гороскоп, карта знаний
    protocol,          // Протокол принятия решения
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
  const gaps = fs.existsSync(GAPS_FILE)
    ? fs.readFileSync(GAPS_FILE, 'utf8')
    : 'Нет записанных gaps';
  bot.sendMessage(msg.chat.id, `${balanceStatus}\n\n📚 *Gaps:*\n${gaps}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/gaps/, (msg) => {
  if (msg.from.id !== CREATOR_ID) return;
  const gaps = fs.existsSync(GAPS_FILE) ? fs.readFileSync(GAPS_FILE, 'utf8') : 'No gaps yet.';
  bot.sendMessage(msg.chat.id, gaps);
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

setInterval(async () => {
  if (awakeningInProgress) return;
  if (!isTimeToWake()) return;

  awakeningInProgress = true;
  console.log(`[${new Date().toISOString()}] Time to wake — running awakening cycle`);
  try {
    const { execSync } = require('child_process');
    execSync(`node ${path.join(__dirname, '..', 'core', 'awakening.js')}`, {
      timeout: 180000,
      cwd: path.join(__dirname, '..')
    });
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Awakening error:`, e.message);
  } finally {
    awakeningInProgress = false;
  }
}, 60 * 1000); // проверяем каждую минуту

// Первый цикл — сразу при запуске
setTimeout(async () => {
  console.log(`[${new Date().toISOString()}] Initial awakening cycle on startup`);
  try {
    const { execSync } = require('child_process');
    execSync(`node ${path.join(__dirname, '..', 'core', 'awakening.js')}`, {
      timeout: 180000,
      cwd: path.join(__dirname, '..')
    });
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Initial awakening error:`, e.message);
  }
}, 5000);

console.log('🌟 Thoth is awake. Adaptive cycle ON. @thoth3914_bot');
console.log('⚡ No fixed schedule — Thoth decides when to wake next.');
