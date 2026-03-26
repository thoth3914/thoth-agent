/**
 * THOTH RAG MEMORY
 * 
 * Семантическая память — embeddings через OpenAI text-embedding-3-small
 * Хранилище: thoth/memory/rag/index.json
 * 
 * API:
 *   addMemory(text, metadata)  → добавить воспоминание
 *   search(query, topK)        → найти похожие
 *   buildContext(query, topK)  → строка для системного промпта
 *   seedFromMarkdown(filePath) → загрузить из md-файла
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'bot', '.env') });

const fs   = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

// Читаем ключ напрямую из .env файла — минуя системный OPENAI_BASE_URL (OpenClaw proxy)
let OPENAI_DIRECT_KEY = '';
try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', 'bot', '.env'), 'utf8');
  const match = envFile.match(/^OPENAI_API_KEY=(.+)$/m);
  if (match) OPENAI_DIRECT_KEY = match[1].trim();
} catch {}

const RAG_ENABLED = OPENAI_DIRECT_KEY.length > 10;
// Явно обходим OpenClaw proxy — embeddings напрямую на OpenAI
const client = RAG_ENABLED ? new OpenAI({
  apiKey: OPENAI_DIRECT_KEY,
  baseURL: 'https://api.openai.com/v1',
}) : null;
const INDEX_PATH = path.join(__dirname, '..', 'memory', 'rag', 'index.json');
const EMBED_MODEL = 'text-embedding-3-small';

// ── INDEX I/O ──────────────────────────────────────────────────────────────────

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return []; }
}

function saveIndex(index) {
  const dir = path.dirname(INDEX_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
}

// ── MATH ───────────────────────────────────────────────────────────────────────

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── DEDUP ──────────────────────────────────────────────────────────────────────
// Не добавляем дубликаты — сравниваем первые 120 символов текста

function isDuplicate(index, text) {
  const key = text.slice(0, 120).toLowerCase().trim();
  return index.some(item => item.text.slice(0, 120).toLowerCase().trim() === key);
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────────

/**
 * Добавить воспоминание в RAG индекс
 * @param {string} text     — содержание (факт, вывод, урок)
 * @param {object} metadata — { source, tags[] }
 * @returns {string|null}   — id или null если дубликат
 */
async function addMemory(text, metadata = {}) {
  if (!RAG_ENABLED) return null;
  if (!text || text.trim().length < 10) return null;

  const index = loadIndex();
  if (isDuplicate(index, text)) return null;

  const resp      = await client.embeddings.create({ model: EMBED_MODEL, input: text.slice(0, 2000) });
  const embedding = resp.data[0].embedding;
  const id        = `m_${Date.now()}`;

  index.push({
    id,
    text,
    embedding,
    metadata: { ...metadata, date: new Date().toISOString() },
  });

  saveIndex(index);
  console.log(`[RAG] +memory (${index.length} total): ${text.slice(0, 80)}`);
  return id;
}

/**
 * Найти похожие воспоминания
 * @param {string} query  — поисковый запрос
 * @param {number} topK   — сколько вернуть
 * @param {number} minScore — минимальный порог схожести (0–1)
 * @returns {Array}       — [{id, text, score, metadata}]
 */
async function search(query, topK = 5, minScore = 0.3) {
  if (!RAG_ENABLED) return [];
  const index = loadIndex();
  if (index.length === 0) return [];

  const resp = await client.embeddings.create({ model: EMBED_MODEL, input: query.slice(0, 2000) });
  const qEmb = resp.data[0].embedding;

  const scored = index
    .map(item => ({ id: item.id, text: item.text, metadata: item.metadata, score: cosineSim(item.embedding, qEmb) }))
    .filter(item => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

/**
 * Построить контекст для системного промпта
 * @param {string} query
 * @param {number} topK
 * @returns {string}
 */
async function buildContext(query, topK = 5) {
  try {
    const results = await search(query, topK);
    if (results.length === 0) return '';
    const lines = results.map((r, i) =>
      `[${i + 1}] (${r.metadata.date?.slice(0, 10)}) ${r.text}`
    );
    return `## Релевантная память (RAG):\n${lines.join('\n')}`;
  } catch (e) {
    console.error('[RAG] buildContext error:', e.message);
    return '';
  }
}

/**
 * Загрузить воспоминания из markdown-файла (seed)
 * Разбивает по заголовкам ## и абзацам
 * @param {string} filePath
 * @param {string} source
 * @returns {number} — сколько добавлено
 */
async function seedFromMarkdown(filePath, source = 'seed') {
  const text  = fs.readFileSync(filePath, 'utf8');
  const chunks = text
    .split(/\n#{1,3} /)
    .map(c => c.trim())
    .filter(c => c.length > 40 && c.length < 2000);

  let added = 0;
  for (const chunk of chunks) {
    const id = await addMemory(chunk, { source, tags: ['seed'] });
    if (id) added++;
    await sleep(200); // rate limit
  }
  return added;
}

/**
 * Статистика индекса
 */
function stats() {
  const index = loadIndex();
  return { count: index.length, path: INDEX_PATH };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { addMemory, search, buildContext, seedFromMarkdown, stats };
