/**
 * THOTH ACTIONS — реальные действия которые Thoth выполняет в циклах
 * 
 * Каждое действие:
 * - Делает что-то реальное (поиск, fetch, запись, git)
 * - Логирует результат
 * - Возвращает структурированный результат
 * 
 * Используется в awakening.js
 */

const fs = require('fs');
const path = require('path');
const { search, formatResults } = require('../tools/web_search');
const { smartFetch } = require('../tools/web_fetch');
const { runSync, writeFile, readFile } = require('../tools/exec_tool');

const BASE = path.join(__dirname, '..');

function now() { return new Date().toISOString(); }
function today() { return new Date().toISOString().split('T')[0]; }

function logAction(type, input, result, ok = true) {
  const entry = `[${now()}] ACTION ${ok ? '✓' : '✗'} ${type}: ${input}\n→ ${String(result).slice(0, 200)}\n`;
  const logPath = path.join(BASE, 'memory', `actions-${today()}.log`);
  try { fs.appendFileSync(logPath, entry); } catch {}
  console.log(`[Thoth:action] ${type} "${String(input).slice(0, 60)}" → ${ok ? 'OK' : 'FAIL'}: ${String(result).slice(0, 100)}`);
}

// ── РЕЕСТР ДЕЙСТВИЙ ────────────────────────────────────────────────────────────

const ACTIONS = {

  /**
   * Поиск в интернете
   * Возвращает список результатов с URL и описаниями
   */
  async search(query, options = {}) {
    try {
      const result = await search(query, { count: options.count || 5 });
      const text = formatResults(result);
      logAction('search', query, `${result.results.length} results via ${result.source}`);
      return { ok: true, data: text, count: result.results.length, source: result.source, raw: result.results };
    } catch (e) {
      logAction('search', query, e.message, false);
      return { ok: false, error: e.message };
    }
  },

  /**
   * Прочитать страницу (через Jina.ai)
   * Возвращает чистый Markdown текст
   */
  async fetch(url, options = {}) {
    try {
      const result = await smartFetch(url, { maxChars: options.maxChars || 5000 });
      if (result.error && !result.text) {
        logAction('fetch', url, result.error, false);
        return { ok: false, error: result.error };
      }
      logAction('fetch', url, `${result.text.length} chars via ${result.via}`);
      return { ok: true, data: result.text, via: result.via, url };
    } catch (e) {
      logAction('fetch', url, e.message, false);
      return { ok: false, error: e.message };
    }
  },

  /**
   * Записать файл в thoth/
   * Путь относительный от thoth/
   */
  async writeFile(relativePath, content) {
    try {
      const r = writeFile(relativePath, content);
      if (r.error) throw new Error(r.error);
      logAction('write', relativePath, `${content.length} bytes`);
      return { ok: true, path: relativePath };
    } catch (e) {
      logAction('write', relativePath, e.message, false);
      return { ok: false, error: e.message };
    }
  },

  /**
   * Прочитать файл из thoth/
   */
  async readFile(relativePath) {
    try {
      const r = readFile(relativePath);
      if (r.error) throw new Error(r.error);
      logAction('read', relativePath, `${r.content.length} chars`);
      return { ok: true, data: r.content };
    } catch (e) {
      logAction('read', relativePath, e.message, false);
      return { ok: false, error: e.message };
    }
  },

  /**
   * Выполнить shell команду (с whitelist)
   */
  async exec(command, options = {}) {
    try {
      const r = runSync(command, { cwd: options.cwd || BASE, timeout: options.timeout || 30000 });
      if (r.blocked) {
        logAction('exec', command, `BLOCKED: ${r.error}`, false);
        return { ok: false, blocked: true, error: r.error };
      }
      if (r.error) {
        logAction('exec', command, `ERROR: ${r.error}`, false);
        return { ok: false, error: r.error, output: r.output };
      }
      logAction('exec', command, r.output.slice(0, 100));
      return { ok: true, output: r.output };
    } catch (e) {
      logAction('exec', command, e.message, false);
      return { ok: false, error: e.message };
    }
  },

  /**
   * Обновить knowledge-map для конкретной темы
   * Находит строку по теме и обновляет уровень
   */
  async updateKnowledge(topic, level, notes = '') {
    try {
      const kmPath = path.join(BASE, 'extra-brain', 'knowledge-map.md');
      let km = '';
      try { km = fs.readFileSync(kmPath, 'utf8'); } catch {}

      const topicLower = topic.toLowerCase();
      const lines = km.split('\n');
      let updated = false;

      const newLines = lines.map(line => {
        if (line.toLowerCase().includes(topicLower) && line.includes('|')) {
          // Строка таблицы с этой темой — обновляем уровень
          const parts = line.split('|');
          if (parts.length >= 3) {
            parts[2] = ` ${level} `;
            if (notes && parts[4]) parts[4] = ` ${notes} `;
            updated = true;
            return parts.join('|');
          }
        }
        return line;
      });

      if (!updated) {
        // Добавляем новую строку в соответствующую секцию или в конец
        newLines.push(`| ${topic} | ${level} | — | ${notes} |`);
      }

      fs.writeFileSync(kmPath, newLines.join('\n'));
      logAction('updateKnowledge', `${topic} → ${level}`, notes || 'ok');
      return { ok: true, topic, level, updated };
    } catch (e) {
      logAction('updateKnowledge', topic, e.message, false);
      return { ok: false, error: e.message };
    }
  },

  /**
   * Добавить gap (навык который нужно изучить)
   */
  async addGap(description) {
    try {
      const gapsPath = path.join(BASE, 'memory', 'gaps.md');
      const entry = `- [ ] ${today()}: ${description}\n`;
      const existing = fs.existsSync(gapsPath) ? fs.readFileSync(gapsPath, 'utf8') : '# Gaps — навыки к изучению\n\n';
      fs.writeFileSync(gapsPath, existing + entry);
      logAction('addGap', description, 'added');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  /**
   * Закрыть gap (пометить как выученный)
   */
  async closeGap(description) {
    try {
      const gapsPath = path.join(BASE, 'memory', 'gaps.md');
      if (!fs.existsSync(gapsPath)) return { ok: false, error: 'No gaps file' };
      const content = fs.readFileSync(gapsPath, 'utf8');
      const descLower = description.toLowerCase();
      const updated = content.split('\n').map(line => {
        if (line.includes('- [ ]') && line.toLowerCase().includes(descLower)) {
          return line.replace('- [ ]', '- [x]');
        }
        return line;
      }).join('\n');
      fs.writeFileSync(gapsPath, updated);
      logAction('closeGap', description, 'closed');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  /**
   * Записать доход в ledger
   */
  async recordIncome(amount, description) {
    try {
      const { trackIncome } = require('./finance-tracker');
      const newBalance = trackIncome(amount, description);
      logAction('recordIncome', `$${amount} — ${description}`, `new balance: $${newBalance.toFixed(2)}`);
      return { ok: true, amount, newBalance };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  /**
   * Создать новый проект
   */
  async createProject(name, description) {
    try {
      const projectDir = path.join(BASE, 'projects', name.toLowerCase().replace(/\s+/g, '-'));
      if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
      const readme = `# ${name}\n\n${description}\n\n## Создан: ${today()}\n\n## Статус: активен\n\n## Задачи:\n- [ ] Определить первый шаг\n`;
      fs.writeFileSync(path.join(projectDir, 'README.md'), readme);
      logAction('createProject', name, projectDir);
      return { ok: true, path: projectDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

};

// ── ПАРСЕР ACTIONS БЛОКА (для awakening.js) ───────────────────────────────────

/**
 * Парсит ```actions блок из текста LLM
 * Поддерживает расширенный синтаксис:
 * 
 * SEARCH: запрос
 * FETCH: url
 * WRITE: path/to/file | содержимое
 * READ: path/to/file
 * EXEC: команда
 * KNOWLEDGE: тема | LEVEL | заметки
 * GAP: описание
 * GAP_CLOSE: описание
 * INCOME: сумма | описание
 * PROJECT: название | описание
 */
function parseActions(text) {
  const parsed = [];
  const blockMatch = text.match(/```actions\n([\s\S]*?)```/);
  if (!blockMatch) return parsed;

  const lines = blockMatch[1].split('\n').filter(l => l.trim());

  for (let rawLine of lines) {
    // Убираем markdown-дефис и звёздочки в начале строки
    const line = rawLine.replace(/^[\s*\-•]+/, '').trim();
    if (!line) continue;
    // Поддерживаем оба формата: "SEARCH: query" и "search query" (без двоеточия)
    let cmd, value;
    if (line.includes(':')) {
      [cmd, ...rest] = line.split(':');
      value = rest.join(':').trim();
    } else {
      // Формат "COMMAND rest of line"
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      cmd = line.slice(0, spaceIdx);
      value = line.slice(spaceIdx + 1).trim();
    }
    // Убираем кавычки вокруг значения если есть
    value = value.replace(/^["']|["']$/g, '').trim();

    switch (cmd.trim().toUpperCase()) {
      case 'SEARCH':
        parsed.push({ type: 'search', query: value }); break;
      case 'FETCH':
        parsed.push({ type: 'fetch', url: value }); break;
      case 'WRITE': {
        const pipeIdx = value.indexOf(' | ');
        if (pipeIdx > -1) parsed.push({ type: 'write', path: value.slice(0, pipeIdx).trim(), content: value.slice(pipeIdx + 3) });
        break;
      }
      case 'READ':
        parsed.push({ type: 'read', path: value }); break;
      case 'EXEC':
        parsed.push({ type: 'exec', command: value }); break;
      case 'KNOWLEDGE': {
        const parts = value.split(' | ');
        parsed.push({ type: 'knowledge', topic: parts[0], level: parts[1] || 'GAP', notes: parts[2] || '' }); break;
      }
      case 'GAP':
        parsed.push({ type: 'gap', description: value }); break;
      case 'GAP_CLOSE':
        parsed.push({ type: 'gap_close', description: value }); break;
      case 'INCOME': {
        const parts = value.split(' | ');
        parsed.push({ type: 'income', amount: parseFloat(parts[0]), description: parts[1] || '' }); break;
      }
      case 'PROJECT': {
        const parts = value.split(' | ');
        parsed.push({ type: 'project', name: parts[0], description: parts[1] || '' }); break;
      }
    }
  }

  return parsed;
}

/**
 * Выполнить распарсенные actions
 * @returns {Array<{action, result}>}
 */
async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    let result;

    switch (action.type) {
      case 'search':    result = await ACTIONS.search(action.query); break;
      case 'fetch':     result = await ACTIONS.fetch(action.url); break;
      case 'write':     result = await ACTIONS.writeFile(action.path, action.content); break;
      case 'read':      result = await ACTIONS.readFile(action.path); break;
      case 'exec':      result = await ACTIONS.exec(action.command); break;
      case 'knowledge': result = await ACTIONS.updateKnowledge(action.topic, action.level, action.notes); break;
      case 'gap':       result = await ACTIONS.addGap(action.description); break;
      case 'gap_close': result = await ACTIONS.closeGap(action.description); break;
      case 'income':    result = await ACTIONS.recordIncome(action.amount, action.description); break;
      case 'project':   result = await ACTIONS.createProject(action.name, action.description); break;
      default:          result = { ok: false, error: `Unknown action: ${action.type}` };
    }

    const label = Object.values(action).filter(v => typeof v === 'string').join(' ').slice(0, 80);
    results.push({
      action: label,
      result: result.ok
        ? (result.data || result.output || JSON.stringify(result)).slice(0, 2000)
        : `FAIL: ${result.error}`,
      ok: result.ok,
      raw: result,
    });
  }

  return results;
}

module.exports = { ACTIONS, parseActions, executeActions };
