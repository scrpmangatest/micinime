const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapeAll, loadLocal } = require('./komiktap-full-scraper');
const source = require('./komiktap-source');

const app = express();
const PORT = process.env.PORT || 3000;
const INDEXNOW_KEY = '3df0235d34c9412b9bdb7a8bcf44fc36';
const DATA_DIR = path.join(__dirname, 'data');
const READS_FILE = path.join(DATA_DIR, 'reads.json');

let DATA = loadLocal();

// Merge incremental scraper data from manga-list.json + data/manga/*.json
function mergeIncrementalData() {
  try {
    const listFile = path.join(DATA_DIR, 'manga-list.json');
    if (!fs.existsSync(listFile)) return;
    const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    if (!DATA || !Array.isArray(DATA.items)) return;
    const existing = new Set(DATA.items.map(i => i.slug));
    const mangaDir = path.join(DATA_DIR, 'manga');
    let added = 0, updated = 0;
    const updatedUrls = [];

    for (const [slug, item] of Object.entries(list)) {
      let detail = {};
      try {
        const df = path.join(mangaDir, `${slug}.json`);
        if (fs.existsSync(df)) detail = JSON.parse(fs.readFileSync(df, 'utf8'));
      } catch (_) {}

      if (existing.has(slug)) {
        // Update existing item if chapter changed
        const idx = DATA.items.findIndex(i => i.slug === slug);
        if (idx >= 0) {
          const cur = DATA.items[idx];
          const newChapter = (detail.chapters && detail.chapters[0] && detail.chapters[0].title) || item.chapter || '';
          if (newChapter && newChapter !== cur.chapter) {
            cur.chapter = newChapter;
            if (detail.image) cur.image = detail.image;
            if (detail.rating) cur.rating = detail.rating;
            cur.updatedAt = Date.now();
            // Move to front
            DATA.items.splice(idx, 1);
            DATA.items.unshift(cur);
            updated++;
            updatedUrls.push(`/manga/${slug}`);
          }
        }
        continue;
      }

      DATA.items.unshift({
        slug: item.slug || slug,
        title: detail.title || item.title || slug,
        url: item.url || `/manga/${slug}`,
        image: detail.image || item.image || null,
        chapter: (detail.chapters && detail.chapters[0] && detail.chapters[0].title) || item.chapter || '',
        rating: detail.rating || item.rating || '',
        type: detail.type || item.type || 'Manga',
        genres: detail.genres || [],
        updatedAt: Date.now()
      });
      existing.add(slug);
      added++;
      updatedUrls.push(`/manga/${slug}`);
    }
    if (added > 0 || updated > 0) {
      DATA.totalItems = DATA.items.length;
      console.log(`[merge] added ${added} new, updated ${updated} existing manga`);
      if (updatedUrls.length > 0 && typeof indexNowSubmit === 'function') {
        indexNowSubmit(updatedUrls.slice(0, 100)); // submit max 100 per run to avoid spam
      }
    }
  } catch (e) {
    console.error('merge incremental error:', e.message);
  }
}
mergeIncrementalData();

// Build genre index from data/manga/*.json files (lazy — built on first request)
const GENRE_INDEX = {}; // { genreSlug: Set<catalogSlug> }
let genreIndexBuilt = false;
function buildGenreIndex() {
  if (genreIndexBuilt) return;
  // Build name→slug map from genre list
  const nameToSlug = {};
  if (DATA && DATA.genres) {
    for (const g of DATA.genres) {
      nameToSlug[(g.name || '').toLowerCase().trim()] = g.slug;
    }
  }

  // Build title→catalogSlug map for matching
  const titleToSlug = {};
  if (DATA && DATA.items) {
    for (const item of DATA.items) {
      const t = (item.title || '').toLowerCase().trim();
      if (t) titleToSlug[t] = item.slug;
    }
  }

  const mangaDir = path.join(DATA_DIR, 'manga');
  if (!fs.existsSync(mangaDir)) { genreIndexBuilt = true; return; }
  const files = fs.readdirSync(mangaDir);
  let count = 0;
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(mangaDir, f), 'utf8'));
      if (!m.genres || !m.genres.length) continue;

      // Find catalog slug: try filename slug first, then title match
      const fileSlug = f.replace('.json', '');
      let catalogSlug = null;
      if (DATA && DATA.items && DATA.items.some(i => i.slug === fileSlug)) {
        catalogSlug = fileSlug;
      } else if (m.title) {
        catalogSlug = titleToSlug[m.title.toLowerCase().trim()] || null;
      }
      if (!catalogSlug) continue;

      for (const g of m.genres) {
        const name = (g.name || '').toLowerCase().trim();
        const rawSlug = (g.slug || name || '').toLowerCase().replace(/\s+/g, '-');
        const gSlug = nameToSlug[name] || rawSlug;
        if (!gSlug) continue;
        if (!GENRE_INDEX[gSlug]) GENRE_INDEX[gSlug] = new Set();
        GENRE_INDEX[gSlug].add(catalogSlug);
        count++;
      }
    } catch (_) {}
  }
  genreIndexBuilt = true;
  console.log(`[genre-index] built: ${Object.keys(GENRE_INDEX).length} genres, ${count} mappings`);
}

// Re-read files periodically to pick up scraper updates
// ponytail: refresh every 6h instead of 1h to save memory churn
function refreshData() {
  try {
    const fresh = loadLocal();
    if (fresh && fresh.items) {
      if (fresh.items.length > (DATA?.items?.length || 0)) {
        DATA = fresh;
        mergeIncrementalData();
        console.log(`[data] refreshed: ${DATA.items.length} items`);
      }
    }
  } catch (_) {}
}
setInterval(refreshData, 6 * 60 * 60 * 1000);

const SCRAPE_EVERY_MS = Math.max(60_000, parseInt(process.env.SCRAPE_EVERY_MS || String(6 * 60 * 60 * 1000), 10));
const SCRAPE_ENABLED = String(process.env.SCRAPE_ENABLED || 'true').toLowerCase() !== 'false';
let scrapeRunning = false;
let lastScrapeStatus = null;

function paginate(items, page, perPage = 16) {
  const start = (page - 1) * perPage;
  const paged = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const currentPage = Math.min(page, totalPages);
  return {
    items: paged,
    pagination: {
      currentPage,
      totalPages,
      perPage,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages && paged.length > 0
    }
  };
}

function loadReads() {
  if (!fs.existsSync(READS_FILE)) return { reads: [] };
  try { return JSON.parse(fs.readFileSync(READS_FILE, 'utf-8')); } catch { return { reads: [] }; }
}

function saveReads(data) {
  if (!fs.existsSync(path.dirname(READS_FILE))) fs.mkdirSync(path.dirname(READS_FILE), { recursive: true });
  fs.writeFileSync(READS_FILE, JSON.stringify(data, null, 2));
}

function recordRead(mangaSlug) {
  if (!mangaSlug) return;
  const db = loadReads();
  db.reads.push({ mangaSlug, at: Date.now() });
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.reads = db.reads.filter(r => r.at > weekAgo);
  saveReads(db);
}

function escapeHtmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findLocalItem(slug) {
  if (!DATA || !Array.isArray(DATA.items)) return null;
  return DATA.items.find(i => i.slug === slug) || null;
}

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache');
    } else if (filePath.match(/\.(js|css)$/)) {
      res.set('Cache-Control', 'public, max-age=604800');
    } else if (filePath.match(/\.(png|jpg|jpeg|gif|svg|webp|ico)$/)) {
      res.set('Cache-Control', 'public, max-age=2592000');
    }
  }
}));
app.use(express.json());

// Yandex verification
app.get('/yandex_d85a06848b0ab963.html', (req, res) => {
  res.type('html').send('<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>Verification: d85a06848b0ab963</body></html>');
});

// IndexNow key file
app.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.type('text/plain').send(INDEXNOW_KEY);
});
// IndexNow submit helper
async function indexNowSubmit(urls) {
  if (!urls || !urls.length) return;
  const axios = require('axios');
  const payload = {
    host: 'micinime.my.id',
    key: INDEXNOW_KEY,
    keyLocation: `https://micinime.my.id/${INDEXNOW_KEY}.txt`,
    urlList: urls.map(u => u.startsWith('http') ? u : `https://micinime.my.id${u}`)
  };
  try {
    const res = await axios.post('https://api.indexnow.org/indexnow', payload, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 10000
    });
    console.log(`[indexnow] submitted ${urls.length} urls, status: ${res.status}`);
  } catch (e) {
    console.error(`[indexnow] error: ${e.message}`);
  }
}

// Main Sitemap Index
app.get('/sitemap.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  const items = (DATA && DATA.items) || [];
  const totalManga = items.length;
  const chunk = 200;
  const parts = Math.ceil(totalManga / chunk);
  const date = new Date().toISOString();
  
  let sitemaps = '';
  // Add home & genres sitemap
  sitemaps += `  <sitemap>\n    <loc>https://micinime.my.id/sitemap-pages.xml</loc>\n    <lastmod>${date}</lastmod>\n  </sitemap>\n`;
  // Add manga sitemaps
  for (let i = 1; i <= parts; i++) {
    sitemaps += `  <sitemap>\n    <loc>https://micinime.my.id/sitemap-manga-${i}.xml</loc>\n    <lastmod>${date}</lastmod>\n  </sitemap>\n`;
  }
  
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps}</sitemapindex>`);
});

// Static pages & genres sitemap
app.get('/sitemap-pages.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  const date = new Date().toISOString();
  let urls = `  <url><loc>https://micinime.my.id/</loc><lastmod>${date}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;
  urls += `  <url><loc>https://micinime.my.id/genres</loc><lastmod>${date}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n`;
  urls += `  <url><loc>https://micinime.my.id/az-lists</loc><lastmod>${date}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n`;
  
  if (DATA && DATA.genres) {
    DATA.genres.forEach(g => {
      if (g.slug) {
        urls += `  <url><loc>https://micinime.my.id/genres/${encodeURIComponent(g.slug)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
      }
    });
  }
  
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}</urlset>`);
});

// Manga pagination sitemaps
app.get('/sitemap-manga-:page.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  const page = parseInt(req.params.page, 10);
  const items = (DATA && DATA.items) || [];
  const chunk = 200;
  
  const start = (page - 1) * chunk;
  const slice = items.slice(start, start + chunk);
  
  if (!slice.length) return res.status(404).send('Not found');
  
  const urls = slice.map(i => {
    let rawSlug = i.slug || '';
    try { rawSlug = decodeURIComponent(rawSlug); } catch(e) {}
    const loc = `https://micinime.my.id/manga/${encodeURIComponent(rawSlug)}`;
    const lastMod = i.updatedAt ? new Date(i.updatedAt).toISOString() : new Date().toISOString();
    return `  <url><loc>${loc}</loc><lastmod>${lastMod}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`;
  }).join('\n');

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
});

const imageCache = new Map();
const IMAGE_CACHE_TTL = 24 * 60 * 60 * 1000;

app.get('/api/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) return res.status(400).send('Bad url');
  try {
    const cached = imageCache.get(url);
    if (cached && Date.now() - cached.ts < IMAGE_CACHE_TTL) {
      res.set('Content-Type', cached.ct);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buf);
    }
    const axios = require('axios');
    const UA_LIST = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'
    ];
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': UA_LIST[Math.floor(Math.random() * UA_LIST.length)], Referer: 'https://komiktap.info/' }
    });
    const ct = r.headers['content-type'] || 'image/jpeg';
    imageCache.set(url, { buf: Buffer.from(r.data), ct, ts: Date.now() });
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(r.data));
  } catch (e) {
    res.status(502).send('Proxy error');
  }
});

const missingImageCache = new Map();

async function enrichItemFromDetail(item) {
  if (item.image && item.chapter) return item;
  try {
    const df = path.join(DATA_DIR, 'manga', `${item.slug}.json`);
    if (fs.existsSync(df)) {
      const detail = JSON.parse(fs.readFileSync(df, 'utf8'));
      return {
        ...item,
        image: item.image || detail.image || null,
        chapter: item.chapter || (detail.chapters && detail.chapters[0] && detail.chapters[0].title) || '',
        rating: item.rating || detail.rating || '',
        type: item.type || detail.type || 'Manga'
      };
    }
  } catch (_) {}
  if (item.image) return item;
  const cached = missingImageCache.get(item.slug);
  if (cached) return { ...item, image: cached };
  try {
    const axios = require('axios');
    const r = await axios.get(`https://komiktap.info/manga/${item.slug}/`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://komiktap.info/' }
    });
    const $ = require('cheerio').load(r.data);
    const img = $('meta[property="og:image"]').attr('content') || $('.thumb img').attr('src') || null;
    if (img) {
      missingImageCache.set(item.slug, img);
      return { ...item, image: img };
    }
  } catch (_) {}
  return item;
}

app.get('/api/home', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    if (DATA && Array.isArray(DATA.items) && DATA.items.length) {
      const sorted = [...DATA.items]
        .map((item, idx) => ({ ...item, _origIdx: idx }))
        .sort((a, b) => {
          const ta = a.updatedAt || 0;
          const tb = b.updatedAt || 0;
          if (ta !== tb) return tb - ta;
          return a._origIdx - b._origIdx; // items without updatedAt keep original order
        });
      const paged = paginate(sorted, page, 16);
      paged.items = await Promise.all(paged.items.map(enrichItemFromDetail));
      const pop = await Promise.all(((DATA.home && DATA.home.popular) || sorted.slice(0, 15)).map(enrichItemFromDetail));
      return res.json({
        popular: pop,
        items: paged.items,
        latest: paged.items,
        pagination: paged.pagination,
        total: sorted.length
      });
    }

    const home = await source.fetchHome();
    const latest = home.latest || [];
    return res.json({
      popular: home.popular || [],
      items: latest,
      latest,
      pagination: { currentPage: 1, totalPages: 1, perPage: 16, hasPrev: false, hasNext: false },
      total: latest.length
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/list', async (req, res) => {
  try {
    const type = String(req.query.type || 'manga').toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    if (DATA && Array.isArray(DATA.items)) {
      const filtered = DATA.items.filter(i => String(i.type || '').toLowerCase() === type);
      return res.json({ ...paginate(filtered, page, 20), total: filtered.length });
    }
    const result = await source.fetchList(type, page);
    res.json({ items: result.items, pagination: result.pagination, total: result.items.length });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/local-source', (req, res) => {
  res.json({
    source: source.BASE_URL,
    mode: 'komiktap',
    lastScraped: DATA?.lastScraped || null,
    total: DATA?.totalItems || 0
  });
});

app.get('/api/manga/:slug', async (req, res) => {
  const slug = decodeURIComponent(req.params.slug);
  const detailFile = path.join(DATA_DIR, 'manga', `${slug}.json`);
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  const catalogItem = findLocalItem(slug);

  function mergeWithCatalog(data) {
    if (!data) return data;
    const merged = { ...data };
    if (!merged.image && catalogItem?.image) merged.image = catalogItem.image;
    if ((!merged.title || merged.title === slug) && catalogItem?.title) merged.title = catalogItem.title;
    if (!merged.rating && catalogItem?.rating) merged.rating = catalogItem.rating;
    if (!merged.type && catalogItem?.type) merged.type = catalogItem.type;
    if (!merged.url) merged.url = catalogItem?.url || `/manga/${slug}`;
    return merged;
  }

  // Check if fresh cache exists
  let cachedDetail = null;
  try {
    if (fs.existsSync(detailFile)) {
      const stat = fs.statSync(detailFile);
      const age = Date.now() - stat.mtimeMs;
      if (age < CACHE_TTL) {
        cachedDetail = JSON.parse(fs.readFileSync(detailFile, 'utf8'));
      }
    }
  } catch (_) {}

  // Return fresh cache immediately (merged with catalog for image/title)
  if (cachedDetail && cachedDetail.chapters && cachedDetail.chapters.length) {
    return res.json(mergeWithCatalog(cachedDetail));
  }

  // Try live fetch
  try {
    const detail = await source.fetchManga(slug);
    const merged = mergeWithCatalog(detail);
    // Cache result
    try {
      if (!fs.existsSync(path.join(DATA_DIR, 'manga'))) fs.mkdirSync(path.join(DATA_DIR, 'manga'), { recursive: true });
      fs.writeFileSync(detailFile, JSON.stringify(merged, null, 2));
    } catch (_) {}
    return res.json(merged);
  } catch (error) {
    console.error(`[manga] live fetch failed for ${slug}: ${error.message}`);
  }

  // Fallback: stale cache (has chapters even if old)
  if (cachedDetail) {
    return res.json(mergeWithCatalog(cachedDetail));
  }

  // Fallback: local cache file (from scraper)
  try {
    if (fs.existsSync(detailFile)) {
      const detail = JSON.parse(fs.readFileSync(detailFile, 'utf8'));
      return res.json(mergeWithCatalog(detail));
    }
  } catch (_) {}

  // Fallback: basic item from catalog
  if (catalogItem) {
    return res.json({ ...catalogItem, chapters: [], genres: [], description: '', status: 'Unknown' });
  }
  res.status(404).json({ error: 'Manga not found' });
});

app.get('/api/chapter/:slug', async (req, res) => {
  const slug = decodeURIComponent(req.params.slug);
  const chapterFile = path.join(DATA_DIR, 'chapters', `${slug}.json`);

  // Check local cache first (from scraper)
  try {
    if (fs.existsSync(chapterFile)) {
      const stat = fs.statSync(chapterFile);
      const age = Date.now() - stat.mtimeMs;
      if (age < 7 * 24 * 60 * 60 * 1000) { // 7 days
        const data = JSON.parse(fs.readFileSync(chapterFile, 'utf8'));
        if (data && data.images && data.images.length) {
          recordRead(data.mangaSlug || '');
          return res.json(data);
        }
      }
    }
  } catch (_) {}

  // Live fetch
  try {
    const data = await source.fetchChapter(slug);
    // Cache result
    try {
      const dir = path.join(DATA_DIR, 'chapters');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(chapterFile, JSON.stringify(data, null, 2));
    } catch (_) {}
    recordRead(data.mangaSlug || '');
    return res.json(data);
  } catch (error) {
    // Fallback: stale cache
    try {
      if (fs.existsSync(chapterFile)) {
        const data = JSON.parse(fs.readFileSync(chapterFile, 'utf8'));
        if (data && data.images && data.images.length) {
          recordRead(data.mangaSlug || '');
          return res.json(data);
        }
      }
    } catch (_) {}
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/track-read', (req, res) => {
  try {
    const { mangaSlug } = req.body || {};
    if (mangaSlug) recordRead(mangaSlug);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const popularGenreCache = new Map();
const POPULAR_GENRE_TTL = 6 * 60 * 60 * 1000;

async function enrichPopularItem(base) {
  if (!base || !base.slug) return null;
  const cached = popularGenreCache.get(base.slug);
  if (cached && Date.now() - cached.at < POPULAR_GENRE_TTL) {
    return { ...base, genres: cached.genres, type: cached.type || base.type };
  }
  if (Array.isArray(base.genres) && base.genres.length) {
    popularGenreCache.set(base.slug, { at: Date.now(), genres: base.genres, type: base.type });
    return base;
  }
  // ponytail: no live fetch — cache is pre-warmed on boot, skip if cold
  return { ...base, genres: [] };
}

async function getPopularBases() {
  const db = loadReads();
  const counts = new Map();
  db.reads.forEach(r => {
    counts.set(r.mangaSlug, (counts.get(r.mangaSlug) || 0) + 1);
  });
  const topSlugs = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
  let bases = [];

  for (const slug of topSlugs) {
    const item = findLocalItem(slug);
    if (item) {
      bases.push({
        slug: item.slug, title: item.title, url: `/manga/${item.slug}`, image: item.image || null,
        chapter: item.chapter || '', type: item.type || 'Manga', genres: item.genres || []
      });
    }
  }

  // ponytail: pad with homepage popular if reads < 10
  if (bases.length < 10 && DATA) {
    const seen = new Set(bases.map(b => b.slug));
    const pool = (DATA.home && DATA.home.popular && DATA.home.popular.length)
      ? DATA.home.popular
      : (DATA.items || []).slice(0, 20);
    for (const p of pool) {
      if (bases.length >= 10) break;
      if (seen.has(p.slug)) continue;
      seen.add(p.slug);
      bases.push({
        slug: p.slug, title: p.title, url: p.url || `/manga/${p.slug}`, image: p.image || null,
        chapter: p.chapter || '', type: p.type || 'Manga', genres: p.genres || []
      });
    }
  }

  return bases;
}

// ponytail: pre-warm on boot so first visitor gets instant response
async function warmPopularCache() {
  try {
    const bases = await getPopularBases();
    for (const base of bases) {
      if (!base || !base.slug) continue;
      try {
        const detail = await source.fetchManga(base.slug);
        const genres = (detail.genres || [])
          .map(g => (typeof g === 'string' ? { name: g } : { name: g.name, url: g.url }))
          .filter(g => g.name && !/^(manga|manhwa|manhua)$/i.test(g.name))
          .slice(0, 6);
        popularGenreCache.set(base.slug, { at: Date.now(), genres, type: detail.type || base.type || 'Manga' });
      } catch {
        popularGenreCache.set(base.slug, { at: Date.now(), genres: [], type: base.type || 'Manga' });
      }
    }
    console.log(`[popular] cache warmed: ${popularGenreCache.size} items`);
  } catch (e) {
    console.error('[popular] warm failed:', e.message);
  }
}

app.get('/api/popular', async (req, res) => {
  try {
    const bases = await getPopularBases();
    const items = (await Promise.allSettled(bases.map(enrichPopularItem)))
      .map(r => r.status === 'fulfilled' ? r.value : null)
      .filter(Boolean);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/genres', async (req, res) => {
  try {
    buildGenreIndex();
    if (DATA && Array.isArray(DATA.genres) && DATA.genres.length) {
      const genres = DATA.genres.map(g => ({
        ...g,
        count: (GENRE_INDEX[g.slug] || new Set()).size || g.count || 0
      }));
      return res.json({
        total: genres.length,
        totalMangaWithGenres: genres.reduce((s, g) => s + g.count, 0),
        genres
      });
    }
    const genres = await source.fetchGenres();
    res.json({ total: genres.length, totalMangaWithGenres: 0, genres });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/genres/:slug', async (req, res) => {
  try {
    buildGenreIndex();
    const slug = decodeURIComponent(req.params.slug);
    const page = Math.max(1, Number(req.query.page) || 1);
    const genreInfo = (DATA && DATA.genres && DATA.genres.find(g => g.slug === slug))
      || { name: slug, slug, count: 0 };

    // Build manga list from genre index (only catalog slugs)
    let items = [];
    const indexSlugs = GENRE_INDEX[slug] || new Set();
    if (indexSlugs.size > 0 && DATA && Array.isArray(DATA.items)) {
      const catalogMap = new Map(DATA.items.map(i => [i.slug, i]));
      for (const mSlug of indexSlugs) {
        const item = catalogMap.get(mSlug);
        if (item) items.push(item);
      }
    }

    const perPage = 20;
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const paged = items.slice((page - 1) * perPage, page * perPage);

    res.json({
      genre: { ...genreInfo, count: items.length || genreInfo.count },
      items: paged,
      pagination: { currentPage: page, totalPages, hasPrev: page > 1, hasNext: page < totalPages }
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});


app.get('/api/az', async (req, res) => {
  try {
    const show = String(req.query.show || 'A').toUpperCase();
    const page = Math.max(1, Number(req.query.page) || 1);

    if (DATA && Array.isArray(DATA.items)) {
      let filtered;
      if (show === '#' || show === '0-9') {
        filtered = DATA.items.filter(i => /^[0-9]/.test(i.title || ''));
      } else {
        filtered = DATA.items.filter(i => String(i.title || '').toUpperCase().startsWith(show));
      }
      const paged = paginate(filtered, page, 20);
      const counts = {};
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(l => { counts[l] = 0; });
      counts['#'] = 0;
      DATA.items.forEach(i => {
        const ch = String(i.title || '').charAt(0).toUpperCase();
        if (ch >= 'A' && ch <= 'Z') counts[ch]++;
        else counts['#']++;
      });
      return res.json({
        show,
        items: paged.items,
        counts,
        total: filtered.length,
        totalAll: DATA.items.length,
        pagination: paged.pagination
      });
    }

    const result = await source.fetchAzList(show === '#' ? '.' : show, page);
    res.json({
      show,
      items: result.items,
      counts: {},
      total: result.items.length,
      totalAll: result.items.length,
      pagination: result.pagination
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const query = String(req.query.s || '').trim();
    if (!query) return res.status(400).json({ error: 'Query required' });

    if (DATA && Array.isArray(DATA.items)) {
      const q = query.toLowerCase();
      const results = DATA.items.filter(i => String(i.title || '').toLowerCase().includes(q)).slice(0, 50);
      return res.json({ query, results });
    }

    const home = await source.fetchHome();
    const results = (home.latest || []).filter(i => String(i.title || '').toLowerCase().includes(query.toLowerCase()));
    res.json({ query, results });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

async function refreshHomeOnly() {
  const home = await source.fetchHome();
  if (!DATA) {
    DATA = {
      lastScraped: new Date().toISOString(),
      totalItems: 0,
      home,
      genres: [],
      azLetters: [],
      items: []
    };
  } else {
    DATA.home = home;
    DATA.lastScraped = new Date().toISOString();
  }
  // merge latest into items list (front)
  const map = new Map((DATA.items || []).map(i => [i.slug, i]));
  for (const item of [...(home.popular || []), ...(home.latest || [])]) {
    if (!item || !item.slug) continue;
    map.set(item.slug, { ...(map.get(item.slug) || {}), ...item });
  }
  DATA.items = [...map.values()];
  DATA.totalItems = DATA.items.length;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'komiktap.json'), JSON.stringify(DATA));
  } catch (e) {
    console.error('[scrape] save fail:', e.message);
  }
  return DATA;
}

async function triggerScheduledScrape(reason = 'schedule') {
  if (!SCRAPE_ENABLED || scrapeRunning) return lastScrapeStatus;
  scrapeRunning = true;
  console.log(`[scrape] trigger (${reason}) from ${source.BASE_URL}`);
  try {
    // Free Render: only refresh homepage (full catalog scrape is local-only)
    DATA = await refreshHomeOnly();
    lastScrapeStatus = {
      ok: true,
      finishedAt: new Date().toISOString(),
      total: DATA?.totalItems || 0,
      trigger: reason,
      source: source.BASE_URL,
      mode: 'home-only'
    };
    return lastScrapeStatus;
  } catch (err) {
    console.error('[scrape] failed:', err.message);
    lastScrapeStatus = {
      ok: false,
      error: err.message,
      finishedAt: new Date().toISOString(),
      trigger: reason,
      source: source.BASE_URL
    };
    return lastScrapeStatus;
  } finally {
    scrapeRunning = false;
  }
}

app.get('/api/scrape/status', (req, res) => {
  res.json({
    enabled: SCRAPE_ENABLED,
    running: scrapeRunning,
    everyMs: SCRAPE_EVERY_MS,
    source: source.BASE_URL,
    lastScraped: DATA?.lastScraped || null,
    total: DATA?.totalItems || 0,
    last: lastScrapeStatus
  });
});

app.post('/api/scrape/run', async (req, res) => {
  const secret = process.env.SCRAPE_SECRET || '';
  if (secret && req.headers['x-scrape-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (scrapeRunning) {
    return res.json({ ok: true, message: 'already running', last: lastScrapeStatus });
  }
  triggerScheduledScrape('manual');
  res.json({ ok: true, message: 'scrape started', source: source.BASE_URL });
});

app.get('/api/scrape', async (req, res) => {
  try {
    if (scrapeRunning) return res.json({ ok: true, message: 'already running' });
    DATA = await scrapeAll();
    res.json({ ok: true, total: DATA.totalItems, lastScraped: DATA.lastScraped, source: source.BASE_URL });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function loadMangaDetail(slug) {
  // Try catalog first
  if (DATA && DATA.items) {
    const item = DATA.items.find(i => i.slug === slug);
    if (item) {
      // Load detail file for genres/chapters
      try {
        const df = path.join(DATA_DIR, 'manga', `${slug}.json`);
        if (fs.existsSync(df)) {
          const d = JSON.parse(fs.readFileSync(df, 'utf8'));
          return { ...item, genres: d.genres || [], chapters: d.chapters || [], description: d.description || '', status: d.status || '' };
        }
      } catch (_) {}
      return item;
    }
  }
  // Try detail file directly
  try {
    const df = path.join(DATA_DIR, 'manga', `${slug}.json`);
    if (fs.existsSync(df)) return JSON.parse(fs.readFileSync(df, 'utf8'));
  } catch (_) {}
  return null;
}

function buildMangaSsr(detail, proto, host) {
  const genres = (detail.genres || []).map(g =>
    `<a href="/genres/${encodeURIComponent((g.name || '').toLowerCase().replace(/\s+/g, '-'))}" style="display:inline-block;padding:4px 10px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#e0e0e0;text-decoration:none;font-size:13px;margin:2px;">${escapeHtmlText(g.name)}</a>`
  ).join('');
  const chapters = (detail.chapters || []).slice(0, 50).map(ch =>
    `<li style="padding:8px 12px;border-bottom:1px solid #222;">
      <a href="${escapeHtmlText(ch.url || '#')}" style="color:#e0e0e0;text-decoration:none;">${escapeHtmlText(ch.title || '')}</a>
      ${ch.date ? `<span style="color:#888;font-size:12px;margin-left:8px;">${escapeHtmlText(ch.date)}</span>` : ''}
    </li>`
  ).join('');

  const chapterCount = (detail.chapters || []).length;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ComicSeries',
    name: detail.title,
    image: detail.image || '',
    description: detail.description || `Baca ${detail.title} sub Indonesia gratis di micinime.`,
    genre: (detail.genres || []).map(g => g.name),
    numberOfEpisodes: chapterCount,
    url: `${proto}://${host}/manga/${encodeURIComponent(detail.slug || '')}`
  };

  return `
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <div style="max-width:900px;margin:0 auto;padding:20px;color:#e0e0e0;font-family:sans-serif;">
      <h1 style="font-size:24px;margin-bottom:12px;">${escapeHtmlText(detail.title || '')}</h1>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px;">
        ${detail.image ? `<img src="${escapeHtmlText(detail.image)}" alt="${escapeHtmlText(detail.title || '')}" style="width:200px;border-radius:8px;" loading="lazy">` : ''}
        <div style="flex:1;min-width:200px;">
          ${detail.status ? `<p><b>Status:</b> ${escapeHtmlText(detail.status)}</p>` : ''}
          ${detail.type ? `<p><b>Type:</b> ${escapeHtmlText(detail.type)}</p>` : ''}
          ${detail.rating ? `<p><b>Rating:</b> ${escapeHtmlText(detail.rating)}</p>` : ''}
          ${detail.description ? `<p style="font-size:14px;color:#aaa;margin-top:10px;">${escapeHtmlText(detail.description)}</p>` : ''}
          ${genres ? `<div style="margin-top:10px;">${genres}</div>` : ''}
        </div>
      </div>
      ${chapters ? `<h2 style="font-size:18px;margin:20px 0 10px;">Chapter List (${chapterCount})</h2><ul style="list-style:none;padding:0;margin:0;">${chapters}</ul>` : ''}
    </div>`;
}

function buildSeoHtml(req) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const host = req.get('x-forwarded-host') || req.get('host') || 'micinime.my.id';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const pathName = (req.path || '/').replace(/\/+$/, '') || '/';
  const pageUrl = `${proto}://${host}${req.originalUrl || '/'}`;

  let title = 'micinime - Baca Manga & Manhwa Hentai Sub Indo Gratis';
  let desc = 'Baca manga dan manhwa hentai sub Indonesia gratis di micinime. Update chapter terbaru setiap hari, koleksi lengkap, nyaman dibaca di HP dan PC.';
  let image = `${proto}://${host}/logo.svg`;
  let ssrContent = '';

  const mangaMatch = pathName.match(/^\/manga\/([^/]+)$/);
  if (mangaMatch) {
    const slug = decodeURIComponent(mangaMatch[1]);
    const detail = loadMangaDetail(slug);
    if (detail && detail.title) {
      title = `${detail.title} - Baca Manga Hentai Sub Indo | micinime`;
      desc = `Baca ${detail.title} bahasa Indonesia gratis di micinime. ${detail.genres ? 'Genre: ' + detail.genres.map(g => g.name).join(', ') + '.' : ''} Update chapter terbaru.`.slice(0, 160);
      if (detail.image) image = detail.image;
      ssrContent = buildMangaSsr(detail, proto, host);
    }
  } else if (pathName === '/genres') {
    title = 'Daftar Genre Manga & Manhwa Hentai Sub Indo | micinime';
    desc = 'Jelajahi daftar genre manga dan manhwa hentai sub Indonesia di micinime.';
  } else if (pathName.startsWith('/genres/')) {
    const g = decodeURIComponent(pathName.replace(/^\/genres\//, '')).replace(/-/g, ' ');
    title = `Genre ${g} - Baca Manga Hentai Sub Indo | micinime`;
    desc = `Kumpulan manga dan manhwa hentai genre ${g} sub Indonesia di micinime.`;
  } else if (pathName === '/az-lists') {
    title = 'AZ Lists Manga Hentai Sub Indo | micinime';
    desc = 'Cari manga dan manhwa hentai sub Indonesia berdasarkan abjad A-Z di micinime.';
  }

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtmlText(title)}</title>`);
  html = html.replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${escapeHtmlText(desc)}">`);
  html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${escapeHtmlText(pageUrl.split('?')[0])}">`);
  html = html.replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${escapeHtmlText(title)}">`);
  html = html.replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${escapeHtmlText(desc)}">`);
  html = html.replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${escapeHtmlText(pageUrl.split('?')[0])}">`);
  html = html.replace(/<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${escapeHtmlText(image)}">`);
  html = html.replace(/<meta\s+name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${escapeHtmlText(title)}">`);
  html = html.replace(/<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${escapeHtmlText(desc)}">`);
  html = html.replace(/<meta\s+name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${escapeHtmlText(image)}">`);

  if (ssrContent) {
    html = html.replace(/<div id="appContent"[\s\S]*?<\/div>/i, `<div id="appContent">${ssrContent}</div>`);
  }

  return html;
}

app.get('*', (req, res) => {
  try {
    const html = buildSeoHtml(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

function startScrapeScheduler() {
  if (!SCRAPE_ENABLED) {
    console.log('[scrape] scheduler off');
    return;
  }
  console.log(`[scrape] scheduler on: every ${Math.round(SCRAPE_EVERY_MS / 3600000)}h | source=${source.BASE_URL}`);
  setInterval(() => {
    triggerScheduledScrape('interval');
  }, SCRAPE_EVERY_MS);
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Source: ${source.BASE_URL}`);
  if (DATA) {
    console.log(`Local data loaded: ${DATA.totalItems} manga (scraped: ${DATA.lastScraped})`);
  } else {
    console.log('No local komiktap data — live scrape fallback enabled');
  }
  startScrapeScheduler();
  setTimeout(() => warmPopularCache(), 5000);
  // ponytail: startup scrape disabled — cron handles it, saves memory on boot
  // setTimeout(() => triggerScheduledScrape('startup'), 3000);
});
