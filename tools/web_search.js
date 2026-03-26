/**
 * THOTH WEB SEARCH TOOL
 * 
 * Поиск информации в интернете.
 * Поддерживает Brave Search API (если есть ключ) или Google через scraping.
 * Для чтения страниц — использует Jina.ai reader (без ключа, чистый текст).
 * 
 * Используется в awakening.js для:
 * - Поиска возможностей заработка
 * - Анализа рынка
 * - Изучения новых инструментов
 * - Поиска документации
 */

const https = require('https');
const { fetchPage } = require('./web_fetch');

/**
 * Поиск через Brave Search API
 * @param {string} query
 * @param {string} apiKey
 * @param {number} count - количество результатов (1-10)
 * @returns {Promise<Array<{title, url, description}>>}
 */
function searchBrave(query, apiKey, count = 5) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?q=${encodedQuery}&count=${count}`,
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.web?.results || []).map(r => ({
            title: r.title,
            url: r.url,
            description: r.description,
          }));
          resolve(results);
        } catch (e) {
          reject(new Error(`Brave parse error: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Поиск через DuckDuckGo Lite (без API ключа)
 * @param {string} query
 * @param {number} count
 * @returns {Promise<Array<{title, url, description}>>}
 */
async function searchDDG(query, count = 5) {
  const encodedQuery = encodeURIComponent(query);
  // DuckDuckGo Lite — меньше JS, лучше парсится
  const url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;

  const result = await fetchPage(url, { maxChars: 40000 });
  if (result.error) throw new Error(`DDG error: ${result.error}`);

  const raw = result.text;
  const results = [];

  // Ищем URL паттерны в очищенном тексте
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 10);
  
  let currentTitle = '';
  let currentUrl = '';

  for (const line of lines) {
    // URL строки
    if (line.match(/^https?:\/\//)) {
      if (currentTitle && line.startsWith('http')) {
        currentUrl = line;
      }
    }
    // Потенциальный заголовок (не URL, достаточно длинный)
    else if (line.length > 15 && line.length < 120 && !line.includes('DuckDuckGo')) {
      if (currentUrl && currentTitle) {
        results.push({ title: currentTitle, url: currentUrl, description: '' });
        if (results.length >= count) break;
      }
      currentTitle = line;
      currentUrl = '';
    }
  }

  return results;
}

/**
 * Универсальный поиск — использует Brave если есть ключ, иначе DDG
 * @param {string} query
 * @param {object} options - { count: 5, apiKey: '...' }
 * @returns {Promise<{results: Array, source: string}>}
 */
async function search(query, options = {}) {
  const count = options.count || 5;
  const apiKey = options.apiKey || process.env.BRAVE_API_KEY;

  if (apiKey) {
    try {
      const results = await searchBrave(query, apiKey, count);
      return { results, source: 'brave' };
    } catch (e) {
      console.log(`[search] Brave failed (${e.message}), falling back to DDG`);
    }
  }

  // Fallback: DuckDuckGo
  try {
    const results = await searchDDG(query, count);
    return { results, source: 'duckduckgo' };
  } catch (e) {
    return { results: [], source: 'error', error: e.message };
  }
}

/**
 * Форматировать результаты поиска в текст для LLM
 */
function formatResults(searchResult) {
  const { results, source } = searchResult;
  if (!results.length) return `[Поиск через ${source}: результатов нет]`;

  return results.map((r, i) =>
    `[${i+1}] ${r.title}\n${r.url}\n${r.description || ''}`
  ).join('\n\n');
}

module.exports = { search, searchBrave, searchDDG, formatResults };
