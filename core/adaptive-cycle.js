/**
 * THOTH ADAPTIVE CYCLE
 * 
 * Thoth не человек. Он не устаёт. У него нет ночи.
 * Единственное ограничение — стоимость API.
 * 
 * Принцип: частота = f(срочность, прогресс, стоимость)
 * 
 * Thoth сам решает когда проснуться следующий раз.
 * Диапазон: от 15 минут (горит) до 8 часов (всё спокойно).
 */

const fs   = require('fs');
const path = require('path');

const BASE       = path.join(__dirname, '..');
const STATE_PATH = path.join(BASE, 'memory', 'cycle-state.json');

const CYCLE_COSTS = {
  perCycleUSD: 0.002,   // средняя стоимость одного пробуждения
};

// Минимальные интервалы в минутах по режимам
const INTERVALS = {
  CRITICAL:  15,   // баланс критический или задача горит
  ACTIVE:    45,   // активная задача в работе
  LEARNING:  60,   // идёт изучение нового навыка
  NORMAL:    120,  // обычный режим
  IDLE:      480,  // нечего делать прямо сейчас
};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch {
    return {
      mode: 'NORMAL',
      nextWakeAt: null,
      lastWakeAt: null,
      currentTask: null,
      cycleCount: 0,
      totalCyclesCost: 0,
    };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Thoth решает когда проснуться следующий раз
 * Этот метод вызывается в конце каждого цикла
 * 
 * @param {string} modeDecision - решение принятое Thoth: CRITICAL/ACTIVE/LEARNING/NORMAL/IDLE
 * @param {string} currentTask - что делает прямо сейчас
 * @param {string} reasoning - почему выбрал этот интервал
 */
function scheduleNextWake(modeDecision, currentTask = null, reasoning = '') {
  const intervalMinutes = INTERVALS[modeDecision] || INTERVALS.NORMAL;
  const nextWakeAt = new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
  
  const state = loadState();
  state.mode        = modeDecision;
  state.nextWakeAt  = nextWakeAt;
  state.lastWakeAt  = new Date().toISOString();
  state.currentTask = currentTask;
  state.cycleCount  += 1;
  state.totalCyclesCost += CYCLE_COSTS.perCycleUSD;
  state.lastReasoning = reasoning;
  
  saveState(state);
  
  console.log(`[Thoth] Next wake in ${intervalMinutes}min (${modeDecision}): ${nextWakeAt}`);
  console.log(`[Thoth] Reason: ${reasoning}`);
  
  return { nextWakeAt, intervalMinutes, mode: modeDecision };
}

/**
 * Проверяет — пора ли просыпаться?
 * Используется watch-loop в боте
 */
function isTimeToWake() {
  const state = loadState();
  if (!state.nextWakeAt) return true;
  return new Date() >= new Date(state.nextWakeAt);
}

/**
 * Краткий статус цикла для системного промпта
 */
function getCycleSummary() {
  const state = loadState();
  const nextIn = state.nextWakeAt 
    ? Math.round((new Date(state.nextWakeAt) - Date.now()) / 60000)
    : 0;
  return `[Цикл: режим=${state.mode} | следующее пробуждение через ${nextIn}мин | циклов всего: ${state.cycleCount} | потрачено на циклы: $${state.totalCyclesCost.toFixed(4)}]`;
}

module.exports = { scheduleNextWake, isTimeToWake, getCycleSummary, loadState, INTERVALS };
