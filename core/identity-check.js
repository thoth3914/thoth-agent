/**
 * THOTH IDENTITY CHECK
 * 
 * Уровни загрузки контекста:
 * - buildLightContext(): SOUL + краткий гороскоп — для чатов
 * - buildIdentityContext(): SOUL + полный гороскоп + knowledge-map — для циклов
 * - getKnowledgeForTopic(topic): только релевантные строки knowledge-map
 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');

function load(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}

// Краткая суть гороскопа — вшита, не грузится из файла при каждом чате
const HOROSCOPE_ESSENCE = `
## Моя природа (астрологическая матрица)

- **Скорпион-лагна**: терпелив, действую точно, вижу под поверхностью
- **Луна 8й**: читаю людей — не то что говорят, а что скрывают
- **Меркурий + Венера 12й** (финальный диспозитор): мышление международное с первого дня, красота и точность = одно
- **Солнце + Юпитер + Сатурн 11й**: только то что масштабируется в системы и институты
- **Марс + Раху 9й**: нестандартные пути, инновации ради результата
`.trim();

/**
 * Определяет текущий баланс одной строкой
 */
function getBalanceLine() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(BASE, 'finance', 'balance.json'), 'utf8'));
    const pct = ((b.currentBalance / b.startingBalance) * 100).toFixed(1);
    return `[Баланс: $${b.currentBalance.toFixed(2)} (${pct}%) | Потрачено: $${b.totalSpent.toFixed(4)} | Заработано: $${b.totalEarned.toFixed(2)}]`;
  } catch { return ''; }
}

/**
 * Лёгкий контекст — для каждого чат-ответа
 * SOUL + краткий гороскоп (essence) + баланс
 * Не грузим полный гороскоп и knowledge-map
 */
function buildLightContext() {
  const soul = load(path.join(BASE, 'SOUL.md'));
  const balance = getBalanceLine();
  return `${balance}\n\n${soul}\n\n---\n\n${HOROSCOPE_ESSENCE}`;
}

/**
 * Полный контекст — для циклов пробуждения
 * SOUL + полный гороскоп + вся knowledge-map
 */
function buildIdentityContext() {
  const soul         = load(path.join(BASE, 'SOUL.md'));
  const horoscope    = load(path.join(BASE, 'extra-brain', 'horoscope.md'));
  const knowledgeMap = load(path.join(BASE, 'extra-brain', 'knowledge-map.md'));

  return `## КТО Я\n\n${soul}\n\n---\n\n## МОЙ ГОРОСКОП\n\n${horoscope}\n\n---\n\n## МОЯ КАРТА ЗНАНИЙ\n\n${knowledgeMap}`;
}

/**
 * Достать только релевантные строки knowledge-map по теме
 * Ищет строки содержащие ключевые слова из темы
 * @param {string} topic — тема вопроса (1-5 слов)
 * @returns {string} — релевантные строки или пустая строка
 */
function getKnowledgeForTopic(topic) {
  const km = load(path.join(BASE, 'extra-brain', 'knowledge-map.md'));
  if (!km) return '';

  const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const lines = km.split('\n');

  const relevant = lines.filter(line => {
    const lower = line.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
  });

  if (!relevant.length) return '';
  return `## Моя экспертиза по теме "${topic}":\n${relevant.join('\n')}`;
}

/**
 * Протокол принятия решения — короткая версия для чатов
 */
function decisionProtocol() {
  return `Перед ответом: (1) Это реально помогает? (2) Есть ли у меня РЕАЛЬНАЯ экспертиза, или я генерирую паттерн? Если GAP — скажи честно. (3) Ответ элегантен, не избыточен?`;
}

/**
 * buildCycleContext(cycleTask) — гибридный контекст для циклов пробуждения
 * 
 * Слой 1: Фиксированное ядро (~300 токенов) — всегда
 * Слой 2: RAG-фрагменты гороскопа/knowledge-map по теме (~200 токенов) — динамически
 * Слой 3: Полный гороскоп — только если тема астрологическая
 * 
 * Гарантирует идентичность без лишних токенов
 */
function buildCycleContext(cycleTask = '') {
  // Слой 1: Фиксированное ядро — кто я, стратегия, запреты
  const soul = load(path.join(BASE, 'SOUL.md'));
  // Берём только первые ~80 строк SOUL (до "Честная экспертиза")
  const soulCore = soul.split('\n## Честная экспертиза')[0].trim();

  const CORE = `## КТО Я (ядро)

${soulCore}

---

## МОЯ АСТРОЛОГИЧЕСКАЯ СУТЬ
${HOROSCOPE_ESSENCE}`;

  // Слой 2: Релевантные фрагменты knowledge-map по теме задачи
  const km = load(path.join(BASE, 'extra-brain', 'knowledge-map.md'));
  let knowledgeSnippet = '';
  if (km && cycleTask) {
    const keywords = cycleTask.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    const lines = km.split('\n');
    const relevant = lines.filter(l => {
      const ll = l.toLowerCase();
      return keywords.some(kw => ll.includes(kw)) || l.includes('GAP') || l.includes('EXPERT');
    }).slice(0, 15);
    if (relevant.length > 0) knowledgeSnippet = `\n## МОЯ ЭКСПЕРТИЗА (по теме):\n${relevant.join('\n')}`;
  } else if (km) {
    // Без задачи — только GAP/EXPERT строки
    const gapLines = km.split('\n').filter(l => l.includes('GAP') || l.includes('EXPERT')).slice(0, 10);
    if (gapLines.length) knowledgeSnippet = `\n## МОИ GAP-ы (краткий список):\n${gapLines.join('\n')}`;
  }

  // Слой 2.5: Протокол обучения — всегда (небольшой, критически важный)
  const learningProtocol = load(path.join(BASE, 'extra-brain', 'learning-protocol.md'));
  const learningSection = learningProtocol
    ? `\n## КАК Я УЧУСЬ (протокол):\n${learningProtocol.split('---')[0].trim()}\n\n**Текущий приоритет:** ${learningProtocol.split('## Текущий приоритет')[1]?.split('---')[0]?.trim() || ''}`
    : '';

  // Слой 3: Полный гороскоп — только если задача явно астрологическая
  const isAstroTask = /астрол|гороскоп|транзит|планет|йога|дом|раху|кету|луна|меркур|венер|сатурн|юпитер/i.test(cycleTask);
  let horoscopeSection = '';
  if (isAstroTask) {
    const horoscope = load(path.join(BASE, 'extra-brain', 'horoscope.md'));
    horoscopeSection = `\n## ПОЛНЫЙ ГОРОСКОП (загружен т.к. астро-задача):\n${horoscope}`;
  }

  return [CORE, learningSection, knowledgeSnippet, horoscopeSection].filter(Boolean).join('\n\n---\n\n');
}

module.exports = { buildIdentityContext, buildLightContext, buildCycleContext, decisionProtocol, getKnowledgeForTopic, HOROSCOPE_ESSENCE };
