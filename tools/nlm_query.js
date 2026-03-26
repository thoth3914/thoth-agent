/**
 * Thoth NLM Query Tool
 * Позволяет Thoth запрашивать данные из NotebookLM через Mac-демон
 * Основной ноутбук для самопознания: Kali Shankar Academy (652a2e5a)
 */

const { execSync } = require('child_process');
const path = require('path');

const NLM_PROXY = '/home/openclaw/.openclaw/workspace/cookie-sync/nlm-proxy/nlm_ask.py';

// Ноутбуки доступные Thoth
const NOTEBOOKS = {
  'kali-shankar': '652a2e5a',   // Астрология — основной источник самопознания
  'stas-2026': '927bb611',      // Транзиты и тренды 2026
  'market-research': '9eea38dd' // Исследование рынка / ЦА
};

/**
 * Запросить данные из NotebookLM
 * @param {string} notebookKey - ключ из NOTEBOOKS или прямой ID
 * @param {string} question - вопрос
 * @returns {string} ответ
 */
function queryNLM(notebookKey, question) {
  const notebookId = NOTEBOOKS[notebookKey] || notebookKey;
  try {
    const result = execSync(
      `python3 "${NLM_PROXY}" "${notebookId}" "${question.replace(/"/g, '\\"')}"`,
      { timeout: 60000, encoding: 'utf8' }
    );
    return result.trim();
  } catch (err) {
    return `NLM error: ${err.message}`;
  }
}

/**
 * Thoth изучает себя через астрологию
 * @param {string} question - вопрос о себе/своей природе
 */
function exploreSelf(question) {
  return queryNLM('kali-shankar', question);
}

module.exports = { queryNLM, exploreSelf, NOTEBOOKS };
