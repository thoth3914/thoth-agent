/**
 * THOTH EXEC TOOL
 * 
 * Безопасное выполнение shell команд для Thoth.
 * 
 * Thoth может использовать exec для:
 * - Создания и записи файлов
 * - Запуска своих собственных скриптов
 * - Git операций в своём репо
 * - Проверки состояния системы
 * 
 * ВАЖНО: Это выполняется от имени openclaw на сервере.
 * Whitelist команд — защита от деструктивных действий.
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = path.join(__dirname, '..');

// Whitelist разрешённых префиксов команд
const ALLOWED_PREFIXES = [
  'node ',
  'python3 ',
  'python ',
  'cat ',
  'ls ',
  'echo ',
  'mkdir ',
  'cp ',
  'mv ',
  'touch ',
  'grep ',
  'find ',
  'head ',
  'tail ',
  'wc ',
  'git ',
  'npm ',
  'curl ',
  'wget ',
  'sed ',
  'awk ',
  'jq ',
];

// Запрещённые паттерны (защита от деструктивных действий)
const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  /rm\s+\//,
  />\s*\/etc\//,
  /chmod\s+777/,
  /sudo/,
  /passwd/,
  /shutdown/,
  /reboot/,
  /dd\s+if=/,
  /mkfs/,
  /format/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
];

/**
 * Проверить безопасность команды
 */
function isSafe(command) {
  // Проверяем запрещённые паттерны
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `Заблокировано: ${pattern}` };
    }
  }

  // Проверяем whitelist
  const cmdLower = command.trim().toLowerCase();
  const allowed = ALLOWED_PREFIXES.some(prefix => cmdLower.startsWith(prefix.toLowerCase()));
  if (!allowed) {
    return { safe: false, reason: `Команда не в whitelist: ${command.split(' ')[0]}` };
  }

  return { safe: true };
}

/**
 * Выполнить команду синхронно
 * @param {string} command
 * @param {object} options - { cwd, timeout, allowUnsafe }
 * @returns {{ output: string, error?: string, blocked?: boolean }}
 */
function runSync(command, options = {}) {
  const cwd = options.cwd || BASE;
  const timeout = options.timeout || 30000;

  if (!options.allowUnsafe) {
    const check = isSafe(command);
    if (!check.safe) {
      return { output: '', blocked: true, error: check.reason };
    }
  }

  try {
    const output = execSync(command, {
      cwd,
      timeout,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: output.trim() };
  } catch (err) {
    return {
      output: err.stdout?.trim() || '',
      error: err.stderr?.trim() || err.message,
    };
  }
}

/**
 * Записать файл (безопасно, только в BASE и его поддиректориях)
 * @param {string} relativePath - путь относительно thoth/
 * @param {string} content
 */
function writeFile(relativePath, content) {
  const fullPath = path.join(BASE, relativePath);

  // Защита от path traversal
  if (!fullPath.startsWith(BASE)) {
    return { error: `Запрещено писать за пределами ${BASE}` };
  }

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(fullPath, content, 'utf8');
  return { success: true, path: fullPath };
}

/**
 * Прочитать файл (только из BASE)
 */
function readFile(relativePath) {
  const fullPath = path.join(BASE, relativePath);
  if (!fullPath.startsWith(BASE)) {
    return { error: 'Запрещено' };
  }
  try {
    return { content: fs.readFileSync(fullPath, 'utf8') };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { runSync, writeFile, readFile, isSafe };
