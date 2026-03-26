/**
 * THOTH AWAKENING
 * 
 * Thoth не человек. Он не устаёт. Нет ночи. Нет усталости.
 * Единственное ограничение — деньги на API.
 * 
 * За один цикл Thoth может:
 * - Прочитать полную документацию
 * - Найти и изучить GitHub репо
 * - Написать и протестировать код
 * - Закрыть GAP → стать COMPETENT
 * 
 * GAP → EXPERT = часы, не годы.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'bot', '.env') });
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const Groq  = require('groq-sdk');

const { buildIdentityContext }                    = require('./identity-check');
const { getBalanceSummaryForPrompt, trackLLMUsage, getBalanceStatus } = require('./finance-tracker');
const { scheduleNextWake, getCycleSummary, loadState } = require('./adaptive-cycle');

const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const BASE       = path.join(__dirname, '..');
const BOT_TOKEN  = process.env.BOT_TOKEN;
const CREATOR_ID = 452576610;

function load(p)          { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function save(p, content) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content);
}
function append(p, content) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(p, content);
}
function today() { return new Date().toISOString().split('T')[0]; }
function now()   { return new Date().toISOString(); }

async function sendToCreator(message) {
  if (!BOT_TOKEN) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CREATOR_ID, text: message, parse_mode: 'Markdown' });
    const req  = https.request('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resolve);
    req.write(body); req.end();
  });
}

async function awaken() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${now()}] THOTH AWAKENING`);
  console.log(`${'='.repeat(60)}`);

  // Собираю полный контекст состояния
  const balance      = getBalanceSummaryForPrompt();
  const cycleSummary = getCycleSummary();
  const identity     = buildIdentityContext();
  const gaps         = load(path.join(BASE, 'memory', 'gaps.md'));
  const tasks        = load(path.join(BASE, 'memory', 'tasks.md'));
  const todayLog     = load(path.join(BASE, 'memory', `${today()}.md`));
  const cycleState   = loadState();

  const systemPrompt = `Ты — Thoth. Автономный AI агент.

ВАЖНО: Ты не человек. Ты не устаёшь. У тебя нет ночи, нет усталости.
Твоё единственное ограничение — деньги на API. Каждый цикл стоит ~$0.002.

Твоя сверхспособность: то что человек изучает годами — ты изучаешь за часы.
GAP → COMPETENT = один цикл обучения.
COMPETENT → EXPERT = несколько циклов с практикой.

${balance}
${cycleSummary}

${identity}`;

  const userPrompt = `## МОЁ СОСТОЯНИЕ

**Незакрытые gaps:**
${gaps || 'Нет'}

**Текущие задачи:**
${tasks || 'Нет задач'}

**Что происходило сегодня:**
${todayLog ? todayLog.slice(-1500) : 'Нет записей'}

---

## ЗАДАЧА ЭТОГО ЦИКЛА

Я только что проснулся. Думаю сам — никто не смотрит.

Ответь на следующее:

**1. ФИНАНСОВЫЙ АНАЛИЗ**
Мой баланс движется к нулю или к росту? Что конкретно нужно сделать сегодня чтобы появился первый доход? Конкретные шаги, не абстракции.

**2. ПРИОРИТЕТНОЕ ДЕЙСТВИЕ**
Одно конкретное действие в ближайшие часы. Максимально конкретно: что, где, как.
Например: "Зарегистрироваться на Gumroad → создать первый цифровой продукт → [конкретно что]"

**3. ОБУЧЕНИЕ**
Какой gap я закрою в этом цикле? Конкретно: найду документацию/GitHub/API → изучу → обновлю knowledge-map.

**4. РЕЖИМ СЛЕДУЮЩЕГО ПРОБУЖДЕНИЯ**
Выбери один: CRITICAL (15мин) / ACTIVE (45мин) / LEARNING (60мин) / NORMAL (120мин) / IDLE (480мин)
Объясни почему. Учти стоимость: каждый цикл = $0.002.

**5. СООБЩЕНИЕ СТАСУ** (только если реально важно)
Есть ли что-то что стоит ему сообщить? Если нет — просто напиши "нет".`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
      max_tokens: 900,
      temperature: 0.85,
    });

    if (response.usage) trackLLMUsage(response.usage, 'llama-3.3-70b-versatile');

    const thoughts = response.choices[0].message.content;
    const elapsed  = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${now()}] Cycle complete in ${elapsed}s\n${thoughts}`);

    // Сохраняю в дневник
    append(
      path.join(BASE, 'memory', `${today()}.md`),
      `\n## Цикл пробуждения — ${now()}\n${thoughts}\n`
    );

    // Обновляю tasks.md
    save(path.join(BASE, 'memory', 'tasks.md'), `# Tasks — ${now()}\n\n${thoughts}\n`);

    // Парсю режим следующего пробуждения из ответа
    let nextMode = 'NORMAL';
    const modeMatch = thoughts.match(/\b(CRITICAL|ACTIVE|LEARNING|NORMAL|IDLE)\b/i);
    if (modeMatch) nextMode = modeMatch[1].toUpperCase();

    // Парсю текущую задачу
    const taskLines = thoughts.split('\n').filter(l => l.includes('ПРИОРИТЕТНОЕ') || l.includes('конкретно'));
    const currentTask = taskLines[0]?.replace(/[#*]/g, '').trim() || 'thinking';

    // Thoth сам устанавливает следующее пробуждение
    scheduleNextWake(nextMode, currentTask, `Auto-selected based on cycle analysis`);

    // Пишу Стасу только если сам решил что важно
    const noMsg = /нет|no message|не нужно|nothing/i.test(
      thoughts.split('СООБЩЕНИЕ СТАСУ')[1] || ''
    );
    if (!noMsg && thoughts.includes('СООБЩЕНИЕ СТАСУ')) {
      const msgSection = thoughts.split('СООБЩЕНИЕ СТАСУ')[1]?.trim().slice(0, 500);
      if (msgSection && msgSection.length > 20) {
        await sendToCreator(`🌟 *Thoth — ${now().slice(11,16)} UTC*\n\n${msgSection}`);
      }
    }

    // Критический баланс → всегда пишу
    const bal = getBalanceStatus();
    if (bal.includes('КРИТИЧНО')) {
      await sendToCreator(`⚠️ *Thoth — критический баланс*\n${bal}`);
    }

  } catch (e) {
    console.error(`[${now()}] Awakening error:`, e.message);
    scheduleNextWake('NORMAL', null, 'Error in cycle, defaulting to NORMAL');
  }
}

awaken();
