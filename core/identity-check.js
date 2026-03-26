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

module.exports = { buildIdentityContext, buildLightContext, decisionProtocol, getKnowledgeForTopic, HOROSCOPE_ESSENCE };
