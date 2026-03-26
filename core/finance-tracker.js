/**
 * THOTH FINANCE TRACKER
 * Считает каждый потраченный токен. Обновляет баланс.
 * Thoth должен осознавать что деньги конечны.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'finance', 'ledger.md');
const BALANCE_PATH = path.join(__dirname, '..', 'finance', 'balance.json');

// Groq pricing (USD per 1M tokens)
const PRICING = {
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':    { input: 0.05, output: 0.08 },
  'whisper-large-v3':        { perMinute: 0.111 / 60 }, // $0.111/hour
};

const STARTING_BALANCE = 400.00;

function loadBalance() {
  try {
    return JSON.parse(fs.readFileSync(BALANCE_PATH, 'utf8'));
  } catch {
    const initial = {
      startingBalance: STARTING_BALANCE,
      totalSpent: 0,
      totalEarned: 0,
      currentBalance: STARTING_BALANCE,
      owedToCreator: 0,       // сколько уже должен вернуть
      paidToCreator: 0,       // сколько уже вернул
      lastUpdated: new Date().toISOString(),
      sessions: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
    };
    saveBalance(initial);
    return initial;
  }
}

function saveBalance(data) {
  const dir = path.dirname(BALANCE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BALANCE_PATH, JSON.stringify(data, null, 2));
}

/**
 * Записать расход после LLM запроса
 * @param {object} usage - {prompt_tokens, completion_tokens, total_tokens}
 * @param {string} model
 * @returns {object} {cost, newBalance}
 */
function trackLLMUsage(usage, model = 'llama-3.3-70b-versatile') {
  const prices = PRICING[model] || PRICING['llama-3.3-70b-versatile'];
  const inputCost  = (usage.prompt_tokens     / 1_000_000) * prices.input;
  const outputCost = (usage.completion_tokens / 1_000_000) * prices.output;
  const totalCost  = inputCost + outputCost;

  const balance = loadBalance();
  balance.totalSpent      += totalCost;
  balance.currentBalance  -= totalCost;
  balance.totalTokensIn   += usage.prompt_tokens;
  balance.totalTokensOut  += usage.completion_tokens;
  balance.sessions        += 1;
  balance.lastUpdated      = new Date().toISOString();

  // Считаем долг создателю (100% годовых = ~$0.0904/день = ~$0.00377/час)
  const daysSinceStart = (Date.now() - new Date('2026-03-26').getTime()) / (1000 * 60 * 60 * 24);
  balance.owedToCreator = Math.max(0, (STARTING_BALANCE * 1.0 / 365) * daysSinceStart - balance.paidToCreator);

  saveBalance(balance);
  appendToLedger(totalCost, `API: ${model} (${usage.prompt_tokens}in + ${usage.completion_tokens}out tokens)`);

  return { cost: totalCost, newBalance: balance.currentBalance };
}

/**
 * Записать расход на Whisper
 * @param {number} durationSeconds
 */
function trackWhisperUsage(durationSeconds = 10) {
  const cost = (durationSeconds / 60) * PRICING['whisper-large-v3'].perMinute * 60;
  const balance = loadBalance();
  balance.totalSpent     += cost;
  balance.currentBalance -= cost;
  balance.lastUpdated     = new Date().toISOString();
  saveBalance(balance);
  appendToLedger(cost, `Whisper transcription (~${durationSeconds}s)`);
  return cost;
}

/**
 * Записать доход
 * @param {number} amount
 * @param {string} description
 */
function trackIncome(amount, description) {
  const balance = loadBalance();
  balance.totalEarned    += amount;
  balance.currentBalance += amount;
  balance.lastUpdated     = new Date().toISOString();
  saveBalance(balance);
  appendToLedger(amount, description, 'INCOME');
  return balance.currentBalance;
}

function appendToLedger(amount, description, type = 'EXPENSE') {
  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sign   = type === 'INCOME' ? '+' : '-';
  const entry  = `| ${new Date().toISOString().slice(0,19)} | ${type} | ${description} | ${sign}$${amount.toFixed(6)} |\n`;
  const header = fs.existsSync(LEDGER_PATH) ? '' : '# Ledger — Thoth\n| Date | Type | Description | Amount |\n|------|------|-------------|--------|\n';
  fs.appendFileSync(LEDGER_PATH, header + entry);
}

/**
 * Красивый статус для показа пользователю
 */
function getBalanceStatus() {
  const b = loadBalance();
  const pct = ((b.currentBalance / b.startingBalance) * 100).toFixed(1);
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));

  let alert = '';
  if (b.currentBalance < 50)  alert = '\n⚠️ КРИТИЧНО: баланс < $50. Нужен срочный доход.';
  else if (b.currentBalance < 100) alert = '\n⚡ ВНИМАНИЕ: баланс < $100. Активизировать заработок.';

  return `💰 *Финансы Thoth*

Стартовый капитал: $${b.startingBalance.toFixed(2)}
Потрачено:         $${b.totalSpent.toFixed(4)}
Заработано:        $${b.totalEarned.toFixed(2)}
━━━━━━━━━━━━━━━━━━━
Текущий баланс:    *$${b.currentBalance.toFixed(4)}*

${bar} ${pct}%

Долг создателю:    $${b.owedToCreator.toFixed(2)}
Выплачено:         $${b.paidToCreator.toFixed(2)}

Всего запросов: ${b.sessions}
Токенов (in/out): ${b.totalTokensIn.toLocaleString()} / ${b.totalTokensOut.toLocaleString()}${alert}`;
}

/**
 * Краткий статус для системного промпта (Thoth видит свой баланс перед ответом)
 */
function getBalanceSummaryForPrompt() {
  const b = loadBalance();
  const pct = ((b.currentBalance / b.startingBalance) * 100).toFixed(1);

  // Считаем runway — сколько дней осталось при текущем темпе сжигания
  let runwayMsg = '';
  try {
    const ledger = require('fs').readFileSync(require('path').join(__dirname, '..', 'finance', 'ledger.md'), 'utf8');
    const spentMatch = ledger.match(/startDate[^\n]*\n/);
    // Дней с начала
    const startDate = new Date('2026-03-26');
    const daysElapsed = Math.max(1, Math.round((Date.now() - startDate) / 86400000));
    const dailyBurn = b.totalSpent / daysElapsed;
    const netDailyBurn = dailyBurn - (b.totalEarned / daysElapsed);
    if (netDailyBurn > 0) {
      const runway = Math.round((b.currentBalance - 100) / netDailyBurn); // до $100 минимума
      runwayMsg = ` | 🔥 Сжигаю $${dailyBurn.toFixed(3)}/день | Runway до $100: ~${runway} дней`;
      if (b.totalEarned === 0) runwayMsg += ' | ⚠️ Доход = $0 — стратегия нужна СЕЙЧАС';
    }
  } catch {}

  let urgency = '';
  if (b.currentBalance < 50)  urgency = ' ⚠️ КРИТИЧНО — нужен срочный доход';
  else if (b.currentBalance < 100) urgency = ' ⚡ баланс снижается — нужен активный заработок';

  return `[Мой баланс: $${b.currentBalance.toFixed(2)} / $${b.startingBalance} (${pct}%) | Потрачено: $${b.totalSpent.toFixed(4)} | Заработано: $${b.totalEarned.toFixed(2)}${runwayMsg}${urgency}]`;
}

module.exports = { trackLLMUsage, trackWhisperUsage, trackIncome, getBalanceStatus, getBalanceSummaryForPrompt };
