const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapeAll, loadLocal } = require('./komiktap-full-scraper');
const source = require('./komiktap-source');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const READS_FILE = path.join(DATA_DIR, 'reads.json');

let DATA = loadLocal();

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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/home', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    if (DATA && Array.isArray(DATA.items) && DATA.items.length) {
      const allItems = DATA.items;
      const paged = paginate(allItems, page, 16);
      return res.json({
        popular: (DATA.home && DATA.home.popular) || allItems.slice(0, 15),
        items: paged.items,
        latest: paged.items,
        pagination: paged.pagination,
        total: allItems.length
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
  try {
    const slug = decodeURIComponent(req.params.slug);
    const detail = await source.fetchManga(slug);
    res.json(detail);
  } catch (error) {
    const local = findLocalItem(decodeURIComponent(req.params.slug));
    if (local) {
      return res.json({ ...local, chapters: [], genres: [], description: '', status: 'Unknown' });
    }
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/chapter/:slug', async (req, res) => {
  try {
    const slug = decodeURIComponent(req.params.slug);
    const data = await source.fetchChapter(slug);
    recordRead(data.mangaSlug || '');
    res.json(data);
  } catch (error) {
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
        slug: item.slug, title: item.title, image: item.image || null,
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
        slug: p.slug, title: p.title, image: p.image || null,
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
    if (DATA && Array.isArray(DATA.genres) && DATA.genres.length) {
      return res.json({
        total: DATA.genres.length,
        totalMangaWithGenres: DATA.genres.reduce((s, g) => s + (g.count || 0), 0),
        genres: DATA.genres
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
    const slug = decodeURIComponent(req.params.slug);
    const page = Math.max(1, Number(req.query.page) || 1);
    const genreInfo = (DATA && DATA.genres && DATA.genres.find(g => g.slug === slug))
      || { name: slug, slug, count: 0 };
    const result = await source.fetchGenreDetail(slug, page);
    res.json({ genre: genreInfo, items: result.items, pagination: result.pagination });
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

  const mangaMatch = pathName.match(/^\/manga\/([^/]+)$/);
  if (mangaMatch) {
    const slug = decodeURIComponent(mangaMatch[1]);
    const local = findLocalItem(slug);
    if (local && local.title) {
      title = `${local.title} - Baca Manga Hentai Sub Indo | micinime`;
      desc = `Baca ${local.title} bahasa Indonesia gratis di micinime. Update chapter terbaru.`.slice(0, 160);
      if (local.image) image = local.image;
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
});
