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

// identity-check загружается внутри awaken() чтобы всегда иметь свежий контекст
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
    // Основная модель — 70b. Fallback на 8b если 70b недоступна (rate limit)
    const MODEL = 'llama-3.3-70b-versatile';
    const FALLBACK_MODEL = 'llama-3.1-8b-instant';

    // ── Вспомогательная функция с fallback на 8b при rate limit ──
    // Умный вызов с fallback + retry на TPM лимит
    async function callGroq(messages, maxTokens = 600, temperature = 0.85) {
      const tryModel = async (model) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await groq.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature });
            if (res.usage) trackLLMUsage(res.usage, model);
            return res.choices[0].message.content;
          } catch (e) {
            const msg = String(e.message || '');
            if (msg.includes('rate_limit') && msg.includes('per minute') && attempt === 0) {
              // TPM limit — ждём 65 секунд и пробуем ещё раз
              console.log(`[${now()}] TPM limit on ${model}, waiting 65s...`);
              await new Promise(r => setTimeout(r, 65000));
              continue;
            }
            throw e;
          }
        }
      };
      try {
        return await tryModel(MODEL);
      } catch (e) {
        if (String(e.message).includes('rate_limit')) {
          console.log(`[${now()}] 70b unavailable, trying 8b...`);
          return await tryModel(FALLBACK_MODEL);
        }
        throw e;
      }
    }

    // ── Фаза 1: Thoth думает и планирует действия ──
    const plan = await callGroq([
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

      // Сжимаем результаты до 2000 символов чтобы вписаться в TPM
      const shortResults = resultsText.slice(0, 2000);
      finalThoughts = await callGroq([
        { role: 'system', content: `Ты Thoth. Автономный агент. Отвечай кратко и конкретно.` },
        {
          role: 'user',
          content: `${balance}\n\nРезультаты действий:\n${shortResults}\n\nОтветь:\n1. Факты (что узнал, 2-3 предложения)\n2. Следующее действие (ACTIONS блок если нужно)\n3. KNOWLEDGE: тема | уровень | заметка (если что-то изучил)\n4. Режим: CRITICAL/ACTIVE/LEARNING/NORMAL/IDLE\n5. Стасу: что реально сделал (1 предложение)`
        },
      ], 600, 0.7);
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
