/**
 * THOTH WEB FETCH TOOL
 * 
 * Позволяет Thoth читать содержимое веб-страниц.
 * 
 * Стратегия:
 * 1. Пробует Jina.ai reader — возвращает чистый Markdown (лучший вариант)
 * 2. Fallback: прямой fetch + cleanHtml
 * 
 * Используется в awakening.js для изучения:
 * - Документации платформ
 * - GitHub репозиториев
 * - Статей и руководств
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Fetch страницы и вернуть очищенный текст
 * @param {string} url 
 * @param {object} options - { maxChars: 8000, timeout: 15000 }
 * @returns {Promise<{text: string, url: string, error?: string}>}
 */
function fetchPage(url, options = {}) {
  const maxChars = options.maxChars || 8000;
  const timeout = options.timeout || 15000;

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      const req = lib.get(url, {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ThothBot/1.0)',
          'Accept': 'text/html,text/plain,*/*',
        }
      }, (res) => {
        // Следуем редиректам
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchPage(res.headers.location, options).then(resolve);
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > maxChars * 3) req.destroy(); // Хватит, обрезаем
        });
        res.on('end', () => {
          const text = cleanHtml(data).slice(0, maxChars);
          resolve({ text, url, statusCode: res.statusCode });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ text: '', url, error: 'Timeout' });
      });

      req.on('error', (err) => {
        resolve({ text: '', url, error: err.message });
      });
    } catch (err) {
      resolve({ text: '', url, error: err.message });
    }
  });
}

/**
 * Очистить HTML → читаемый текст
 */
function cleanHtml(html) {
  return html
    // Убираем скрипты и стили полностью
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    // Заменяем блочные теги на переносы строк
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|section|article)[^>]*>/gi, '\n')
    // Убираем все оставшиеся HTML теги
    .replace(/<[^>]+>/g, ' ')
    // Декодируем HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    // Убираем лишние пробелы и переносы
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch нескольких страниц параллельно
 * @param {string[]} urls
 * @param {object} options
 * @returns {Promise<Array>}
 */
async function fetchPages(urls, options = {}) {
  return Promise.all(urls.map(url => fetchPage(url, options)));
}

/**
 * Fetch страницы через Jina.ai reader (возвращает чистый Markdown)
 * Работает без API ключа, лучше справляется с JS-сайтами
 * @param {string} url
 * @param {object} options - { maxChars: 6000, timeout: 20000 }
 */
async function fetchViaJina(url, options = {}) {
  const maxChars = options.maxChars || 6000;
  const timeout = options.timeout || 25000;
  const jinaUrl = `https://r.jina.ai/${url}`;

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    // Глобальный таймаут — гарантия что не зависнем
    const timer = setTimeout(() => {
      safeResolve({ text: '', url, error: 'Timeout (jina)', via: 'jina' });
    }, timeout);

    try {
      const req = https.get(jinaUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ThothBot/1.0)',
          'Accept': 'text/plain, text/markdown, */*',
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timer);
          return fetchViaJina(res.headers.location, options).then(safeResolve);
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > maxChars * 2) res.destroy();
        });
        const finish = () => {
          clearTimeout(timer);
          safeResolve({ text: data.trim().slice(0, maxChars), url, statusCode: res.statusCode, via: 'jina' });
        };
        res.on('end', finish);
        res.on('close', finish); // res.destroy() fires 'close', not 'end'
        res.on('error', (err) => {
          clearTimeout(timer);
          if (data.length > 100) safeResolve({ text: data.trim().slice(0, maxChars), url, via: 'jina' });
          else safeResolve({ text: '', url, error: err.message, via: 'jina' });
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        safeResolve({ text: '', url, error: err.message, via: 'jina' });
      });
    } catch (err) {
      clearTimeout(timer);
      safeResolve({ text: '', url, error: err.message, via: 'jina' });
    }
  });
}

/**
 * Умный fetch — пробует Jina, fallback на прямой HTML scrape
 */
async function smartFetch(url, options = {}) {
  const jinaResult = await fetchViaJina(url, options);
  if (jinaResult.text && jinaResult.text.length > 100) return jinaResult;
  // Fallback
  return fetchPage(url, options);
}

module.exports = { fetchPage, fetchPages, fetchViaJina, smartFetch, cleanHtml };
