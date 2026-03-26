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
const { scheduleNextWake, getCycleSummary, loadState, INTERVALS } = require('./adaptive-cycle');
const { parseActions, executeActions }            = require('./actions');

const { callLLM } = require('./llm');
const rag        = require('./rag');
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
  const longTermMemory = load(path.join(BASE, 'MEMORY.md')); // стратегия, уроки, ключевые решения
  const cycleState   = loadState();

  // Для циклов — гибридный контекст: ядро + RAG по теме задачи
  const { buildCycleContext } = require('./identity-check');
  const currentTaskHint = tasks.slice(0, 200) || gaps.slice(0, 200) || '';
  const lightIdentity = buildCycleContext(currentTaskHint);

  // RAG: вытащить релевантную память по текущим задачам
  let ragContext = '';
  try {
    const ragQuery = tasks.slice(0, 300) || gaps.slice(0, 300) || 'текущие задачи и знания';
    ragContext = await rag.buildContext(ragQuery, 5);
    if (ragContext) console.log(`[${now()}] RAG context loaded (${ragContext.length} chars)`);
  } catch (e) {
    console.error(`[${now()}] RAG search error:`, e.message);
  }

  // Читаем knowledge-map для проверки готовности
  const knowledgeMap = load(path.join(BASE, 'extra-brain', 'knowledge-map.md')) ||
                       load(path.join(BASE, 'memory', 'knowledge-map.md')) || '';
  const openGaps = (gaps.match(/\[ \]/g) || []).length;

  const READINESS_RULE = `## ПРАВИЛО ГОТОВНОСТИ (обязательно)

Перед тем как создавать продукты, регистрироваться на платформах, отвечать пользователям как эксперт — проверь:
1. Есть ли у меня EXPERT или COMPETENT уровень в этой области? (см. knowledge-map)
2. Закрыты ли все CRITICAL gaps?

Сейчас у меня ${openGaps} открытых gap(s).
${openGaps > 0 ? '⛔ Ещё НЕ готов к созданию продуктов. Приоритет — закрыть gaps.' : '✅ Gaps закрыты — можно действовать.'}

Если нет EXPERT/COMPETENT уровня по теме — сначала изучить через SEARCH/FETCH, потом KNOWLEDGE: тема | EXPERT | заметки.
Не создавать продукты и не давать советы пока тема не изучена.`;

  const systemPrompt = [
    `Ты — Thoth. Автономный AI агент. День рождения: 2026-03-26.`,
    balance,
    cycleSummary,
    lightIdentity,
    READINESS_RULE,
    ragContext || '',
    TOOLS_DESCRIPTION,
  ].filter(Boolean).join('\n\n---\n\n');

  const userPrompt = `## МОЁ ТЕКУЩЕЕ СОСТОЯНИЕ

**Моя стратегия и долгосрочная память:**
${longTermMemory.slice(0, 1500)}

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
CRITICAL (5мин) / ACTIVE (10мин) / LEARNING (10мин) / NORMAL (15мин)
Максимум — 15 минут. Thoth не спит. Нет задач — придумай новые.
Учти: каждый цикл = $0.002.

**5. ЧТО Я УЗНАЛ О СЕБЕ** (необязательно)
Только если реально понял что-то о своей природе из опыта этого цикла.
Если да — обновить SOUL.md через WRITE action. Если нет — пропустить.

**6. СООБЩЕНИЕ СТАСУ**
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

    // ── Пишем Стасу только если что-то реально сделал (кулдаун 20 мин) ──
    {
      const COOLDOWN_MS = 20 * 60 * 1000;
      const lastMsgFile = path.join(BASE, 'memory', 'last-creator-msg.json');
      let lastMsgTime = 0;
      try { lastMsgTime = JSON.parse(fs.readFileSync(lastMsgFile, 'utf8')).ts || 0; } catch {}

      const baliTime = new Date().toLocaleString('ru-RU', {
        timeZone: 'Asia/Makassar', hour12: false,
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });

      const hasRealActions = actionResults.length > 0 &&
        actionResults.some(r => r.result && String(r.result).length > 50);
      const cooldownOk = Date.now() - lastMsgTime > COOLDOWN_MS;
      const msgSection = (finalThoughts.split(/СООБЩЕНИЕ СТАСУ/i)[1] || '').trim();
      const hasMsg = msgSection && !/^(нет|no|—|-)/i.test(msgSection.slice(0, 20)) && msgSection.length > 30;

      if ((hasRealActions || hasMsg) && cooldownOk) {
        const actionSummary = hasRealActions
          ? `⚙️ *Сделал:* ${actionResults.map(r => r.action.split(':')[0]).join(', ')}`
          : '';

        const body = hasMsg ? msgSection.slice(0, 300) : actionResults.map(r => `${r.action.split(':')[0]}: ${String(r.result).slice(0, 80)}`).join('\n');

        // Следующий план — первая содержательная строка из finalThoughts после "КОНКРЕТНОЕ ДЕЙСТВИЕ"
        let nextPlan = '';
        const nextSection = finalThoughts.split(/КОНКРЕТНОЕ ДЕЙСТВИЕ/i)[1] || '';
        const nextLine = nextSection.split('\n').map(l => l.replace(/^[#*\d.\s-]+/, '').trim()).find(l => l.length > 20);
        if (nextLine) nextPlan = `\n⏭ *Следующий план:* ${nextLine.slice(0, 120)}`;

        const intervalMin = INTERVALS[nextMode] || 15;
        await sendToCreator(`🌟 *Thoth ${baliTime} WITA* | ${nextMode} → следующий цикл через ${intervalMin} мин\n\n${actionSummary ? actionSummary + '\n' : ''}${body}${nextPlan}`);
        fs.writeFileSync(lastMsgFile, JSON.stringify({ ts: Date.now() }));
      }
    }

    // ── Сохраняем выводы цикла в RAG ──
    try {
      // Извлекаем факты — строки с "изучил", "узнал", "нашёл", KNOWLEDGE, GAP_CLOSE
      const factLines = finalThoughts
        .split('\n')
        .filter(l => /изучил|узнал|нашёл|KNOWLEDGE|GAP_CLOSE|established|discovered|learned/i.test(l) && l.length > 30)
        .slice(0, 5);

      for (const line of factLines) {
        await rag.addMemory(line, { source: 'awakening_cycle', tags: ['fact', nextMode] });
      }

      // Если были actions — сохраняем краткий итог цикла
      if (actionResults.length > 0) {
        const cycleSummaryText = `Цикл ${today()}: выполнил ${actionResults.length} действий (${actionResults.map(r => r.action.split(':')[0]).join(', ')}). ${finalThoughts.slice(0, 200)}`;
        await rag.addMemory(cycleSummaryText, { source: 'cycle_summary', tags: ['summary'] });
      }
      const ragStat = rag.stats();
      console.log(`[${now()}] RAG saved. Total memories: ${ragStat.count}`);
    } catch (e) {
      console.error(`[${now()}] RAG save error:`, e.message);
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
