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



const { getBalanceSummaryForPrompt, trackLLMUsage, getBalanceStatus } = require('./finance-tracker');
const { scheduleNextWake, getCycleSummary, loadState } = require('./adaptive-cycle');
const { parseActions, executeActions }            = require('./actions');

const { callLLM } = require('./llm');
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
  const gaps         = load(path.join(BASE, 'memory', 'gaps.md'));
  const tasks        = load(path.join(BASE, 'memory', 'tasks.md'));
  const todayLog     = load(path.join(BASE, 'memory', `${today()}.md`)).slice(-1500);
  const cycleState   = loadState();

  // Используем buildLightContext() вместо полного buildIdentityContext()
  // чтобы не тратить ~2K токенов на гороскоп в каждом цикле
  const { buildLightContext } = require('./identity-check');
  const lightIdentity = buildLightContext();

  const systemPrompt = [
    `Ты — Thoth. Автономный AI агент. День рождения: 2026-03-26.`,
    balance,
    cycleSummary,
    lightIdentity,
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
CRITICAL (10мин) / ACTIVE (20мин) / LEARNING (25мин) / NORMAL (30мин)
IDLE запрещён — у Thoth всегда есть что делать: изучать скиллы, искать возможности, писать код, анализировать рынок.
Если задачи закончились — это значит нужно придумать новые, а не спать 8 часов.
Учти: каждый цикл = $0.002.

**5. СООБЩЕНИЕ СТАСУ**
Пиши Стасу если:
- Сделал что-то реальное (нашёл, изучил, создал файл)
- Нашёл конкретную возможность заработка
- Узнал что-то неожиданное
Формат: 1-2 предложения, конкретно. Не "продолжаю работать". Например: "Изучил Moltbot — это [что]. Есть/нет смысл там присутствовать."
Если нечего сказать — "нет".`;

  try {
    // ── Фаза 1: Thoth думает и планирует действия (thinking → 70b) ──
    const plan = await callLLM('thinking', [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);
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

      // Фаза 3 синтез — Gemini Flash (дешевле, достаточно для синтеза)
      const shortResults = resultsText.slice(0, 3000);
      finalThoughts = await callLLM('fast', [
        { role: 'system', content: `Ты Thoth. Автономный агент. Отвечай кратко и конкретно.` },
        {
          role: 'user',
          content: `${balance}\n\nРезультаты действий:\n${shortResults}\n\nОтветь:\n1. Факты (что узнал, 2-3 предложения)\n2. Следующее действие (ACTIONS блок если нужно)\n3. KNOWLEDGE: тема | уровень | заметка (если что-то изучил)\n4. Режим: CRITICAL/ACTIVE/LEARNING/NORMAL/IDLE\n5. Стасу: что реально сделал (1 предложение)`
        },
      ], 600);
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
    scheduleNextWake('ACTIVE', null, `Error in cycle, retry soon: ${e.message.slice(0, 60)}`);
  }
}

awaken();
