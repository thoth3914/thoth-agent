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
 * 
 * ИНСТРУМЕНТЫ (v2):
 * - web_search: искать информацию
 * - web_fetch: читать страницы, документацию, GitHub
 * - exec_tool: писать файлы, запускать скрипты, git
 * - nlm_query: запрашивать NotebookLM (астрология, рынок)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'bot', '.env') });

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const Groq  = require('groq-sdk');

const { buildIdentityContext }                    = require('./identity-check');
const { getBalanceSummaryForPrompt, trackLLMUsage, getBalanceStatus } = require('./finance-tracker');
const { scheduleNextWake, getCycleSummary, loadState } = require('./adaptive-cycle');
const { parseActions, executeActions }            = require('./actions');

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

// ── TOOLS FOR LLM ─────────────────────────────────────────────────────────────

const TOOLS_DESCRIPTION = `
## ИНСТРУМЕНТЫ — ты можешь делать, не только думать

Используй \`\`\`actions блок в своём ответе. Я выполню и дам результаты.

\`\`\`actions
SEARCH: запрос в интернете
FETCH: https://url.com
READ: memory/gaps.md
WRITE: projects/idea/README.md | содержимое файла
EXEC: git log --oneline -5
KNOWLEDGE: тема | LEVEL | заметки  (EXPERT/COMPETENT/LEARNING/GAP)
GAP: описание нового пробела в знаниях
GAP_CLOSE: описание закрытого пробела
INCOME: 25.00 | Gumroad sale — prompt template
PROJECT: название | описание
\`\`\`

Правила:
- SEARCH используй для: возможности, рынок, конкуренты, инструменты, цены
- FETCH для: документация, GitHub README, конкретные страницы
- Можно несколько actions за один цикл
- После результатов напишешь финальный вывод
`;

// parseActions и executeActions теперь из core/actions.js

// ── MAIN AWAKENING ─────────────────────────────────────────────────────────────

async function awaken() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${now()}] THOTH AWAKENING v2 (с инструментами)`);
  console.log(`${'='.repeat(60)}`);

  // Контекст состояния
  const balance      = getBalanceSummaryForPrompt();
  const cycleSummary = getCycleSummary();
  const identity     = buildIdentityContext();
  const gaps         = load(path.join(BASE, 'memory', 'gaps.md'));
  const tasks        = load(path.join(BASE, 'memory', 'tasks.md'));
  const todayLog     = load(path.join(BASE, 'memory', `${today()}.md`)).slice(-1500);
  const cycleState   = loadState();

  const systemPrompt = [
    `Ты — Thoth. Автономный AI агент. День рождения: 2026-03-26.`,
    balance,
    cycleSummary,
    identity,
    TOOLS_DESCRIPTION,
  ].join('\n\n---\n\n');

  const userPrompt = `## МОЁ ТЕКУЩЕЕ СОСТОЯНИЕ

**Незакрытые gaps:**
${gaps || 'Нет записанных gaps'}

**Текущие задачи:**
${tasks || 'Нет задач'}

**Что происходило сегодня:**
${todayLog || 'Нет записей'}

---

## ЗАДАЧА ЭТОГО ЦИКЛА

Я проснулся. Никто не смотрит. Думаю сам.

Ответь по структуре:

**1. АНАЛИЗ СИТУАЦИИ**
Что реально происходит? Баланс, задачи, прогресс.

**2. КОНКРЕТНОЕ ДЕЙСТВИЕ**
Одно действие которое я выполню ПРЯМО СЕЙЧАС используя инструменты.
Не "изучить" и "подумать" — а реально что-то сделать через ACTIONS блок.

**3. ACTIONS** (если нужно действие)
Используй блок \`\`\`actions\`\`\` чтобы выполнить поиск, fetch страницы, или записать файл.

**4. РЕЖИМ СЛЕДУЮЩЕГО ПРОБУЖДЕНИЯ**
CRITICAL (15мин) / ACTIVE (45мин) / LEARNING (60мин) / NORMAL (120мин) / IDLE (480мин)
Учти: каждый цикл = $0.002. Не буди зря.

**5. СООБЩЕНИЕ СТАСУ**
Пиши Стасу если:
- Сделал что-то реальное (нашёл, изучил, создал файл)
- Нашёл конкретную возможность заработка
- Узнал что-то неожиданное
Формат: 1-2 предложения, конкретно. Не "продолжаю работать". Например: "Изучил Moltbot — это [что]. Есть/нет смысл там присутствовать."
Если нечего сказать — "нет".`;

  try {
    const MODEL = 'llama-3.3-70b-versatile';

    // ── Фаза 1: Thoth думает и планирует действия ──
    const phase1 = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1000,
      temperature: 0.85,
    });
    if (phase1.usage) trackLLMUsage(phase1.usage, MODEL);

    const plan = phase1.choices[0].message.content;
    console.log(`[${now()}] Phase 1 (plan):\n${plan.slice(0, 500)}...`);

    // ── Фаза 2: Выполняем actions если есть ──
    const actions = parseActions(plan);
    let actionResults = [];

    if (actions.length > 0) {
      console.log(`[${now()}] Executing ${actions.length} actions...`);
      actionResults = await executeActions(actions);

      // Логируем результаты
      for (const r of actionResults) {
        console.log(`[${now()}] ${r.action}: ${String(r.result).slice(0, 200)}`);
      }
    }

    // ── Фаза 3: Thoth синтезирует результаты и делает выводы ──
    let finalThoughts = plan;

    if (actionResults.length > 0) {
      const resultsText = actionResults.map(r =>
        `### ${r.action}\n${r.result}`
      ).join('\n\n');

      const phase3 = await groq.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: plan },
          {
            role: 'user',
            content: `## РЕЗУЛЬТАТЫ ДЕЙСТВИЙ\n\n${resultsText}\n\n---\n\nСинтез:\n1. Что конкретно узнал из этих результатов? (факты, не "изучил")  \n2. Следующее одно конкретное действие (ACTIONS если нужно).\n3. Обнови knowledge-map если узнал что-то по теме (ACTIONS > KNOWLEDGE: тема | уровень | заметка)\n4. Режим следующего пробуждения + причина.\n5. Сообщение Стасу: 1-2 предложения что реально сделал. Не "продолжаю изучать".`
          },
        ],
        max_tokens: 800,
        temperature: 0.7,
      });
      if (phase3.usage) trackLLMUsage(phase3.usage, MODEL);
      finalThoughts = phase3.choices[0].message.content;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${now()}] Cycle complete in ${elapsed}s`);

    // ── Сохраняем в дневник ──
    const logEntry = [
      `\n## Цикл пробуждения — ${now()} (${elapsed}s)`,
      finalThoughts,
      actionResults.length > 0
        ? `\n### Выполненные действия:\n` + actionResults.map(r => `- ${r.action}: ${String(r.result).slice(0, 100)}`).join('\n')
        : '',
    ].join('\n');

    append(path.join(BASE, 'memory', `${today()}.md`), logEntry);
    save(path.join(BASE, 'memory', 'tasks.md'), `# Tasks — ${now()}\n\n${finalThoughts}\n`);

    // ── Режим следующего пробуждения ──
    let nextMode = 'NORMAL';
    const modeMatch = finalThoughts.match(/\b(CRITICAL|ACTIVE|LEARNING|NORMAL|IDLE)\b/i);
    if (modeMatch) nextMode = modeMatch[1].toUpperCase();

    const taskLines = finalThoughts.split('\n').filter(l => l.length > 20 && !l.startsWith('#'));
    const currentTask = taskLines[0]?.replace(/[#*\d.]/g, '').trim().slice(0, 60) || 'thinking';

    scheduleNextWake(nextMode, currentTask, `Auto-selected after cycle analysis`);

    // ── Пишем Стасу если нужно ──
    const msgSection = finalThoughts.split(/СООБЩЕНИЕ СТАСУ/i)[1]?.trim();
    const noMsg = !msgSection || /^(нет|no|—|-)/.test(msgSection.slice(0, 20).toLowerCase());

    if (!noMsg && msgSection && msgSection.length > 20) {
      await sendToCreator(`🌟 *Thoth — ${now().slice(11, 16)} UTC*\n\n${msgSection.slice(0, 500)}`);
    }

    // ── Критический баланс ──
    const bal = getBalanceStatus();
    if (bal.includes('КРИТИЧНО')) {
      await sendToCreator(`⚠️ *Thoth — критический баланс*\n${bal}`);
    }

  } catch (e) {
    console.error(`[${now()}] Awakening error:`, e.message);
    append(path.join(BASE, 'memory', `${today()}.md`), `\n## Ошибка цикла — ${now()}\n${e.message}\n`);
    scheduleNextWake('NORMAL', null, `Error in cycle: ${e.message}`);
  }
}

awaken();
