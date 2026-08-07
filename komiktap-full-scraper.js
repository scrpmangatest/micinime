const fs = require('fs');
const path = require('path');
const source = require('./komiktap-source');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'komiktap.json');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function scrapeAllTypes() {
  const allItems = [];
  for (const type of ['manga', 'manhwa', 'manhua']) {
    console.log(`Scraping ${type}...`);
    const first = await source.fetchList(type, 1);
    const totalPages = first.pagination.totalPages;
    console.log(`  ${type}: ${totalPages} pages`);
    allItems.push(...first.items.map(i => ({ ...i, type })));
    for (let p = 2; p <= totalPages; p++) {
      await delay(200);
      try {
        const result = await source.fetchList(type, p);
        allItems.push(...result.items.map(i => ({ ...i, type })));
        if (p % 10 === 0) console.log(`  ${type}: page ${p}/${totalPages}`);
      } catch (e) {
        console.error(`  ${type} page ${p} error: ${e.message}`);
      }
    }
  }
  return allItems;
}

async function scrapeHome() {
  console.log('Scraping homepage...');
  return await source.fetchHome();
}

async function scrapeGenres() {
  console.log('Scraping genres with counts...');
  const genres = await source.fetchGenres();
  console.log(`  Found ${genres.length} genres, fetching counts...`);
  for (let i = 0; i < genres.length; i++) {
    const g = genres[i];
    await delay(200);
    try {
      const result = await source.fetchGenreDetail(g.slug, 1);
      g.count = result.pagination.totalPages * 10;
      if ((i + 1) % 20 === 0) console.log(`  genres: ${i + 1}/${genres.length}`);
    } catch (e) {
      g.count = 0;
    }
  }
  return genres;
}

async function scrapeAzLetters() {
  console.log('Scraping A-Z letters...');
  return await source.fetchAzLetters();
}

async function scrapeAll() {
  const startTime = Date.now();
  console.log('=== Full Scraper Start ===');

  const [home, genres, azLetters, items] = await Promise.all([
    scrapeHome(),
    scrapeGenres(),
    scrapeAzLetters(),
    scrapeAllTypes()
  ]);

  const unique = new Map();
  items.forEach(i => {
    if (!unique.has(i.slug)) unique.set(i.slug, i);
  });

  const data = {
    lastScraped: new Date().toISOString(),
    totalItems: unique.size,
    home,
    genres,
    azLetters,
    items: [...unique.values()]
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== Done: ${unique.size} manga in ${elapsed}s ===`);
  return data;
}

function loadLocal() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch { return null; }
}

module.exports = { scrapeAll, loadLocal, DATA_FILE };

if (require.main === module) {
  scrapeAll().catch(e => { console.error('Scraper failed:', e.message); process.exit(1); });
}
