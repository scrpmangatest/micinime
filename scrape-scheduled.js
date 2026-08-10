/**
 * Incremental live scrape:
 * - runs periodically (default every 6 hours)
 * - hard time limit (default 10 minutes)
 * - only fetches latest-update pages + new/changed manga+chapters
 */
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.SCRAPE_BASE_URL || 'https://komiktap.info';
const DATA_DIR = path.join(__dirname, 'data');
const DELAY_MS = Math.max(1000, parseInt(process.env.SCRAPE_DELAY_MS || '3000', 10));
const MAX_MS = Math.max(60_000, parseInt(process.env.SCRAPE_MAX_MS || String(10 * 60 * 1000), 10)); // 10 min
const LATEST_PAGES = Math.max(1, parseInt(process.env.SCRAPE_LATEST_PAGES || '4', 10));

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay() {
  return DELAY_MS + Math.floor(Math.random() * 2000); // base + 0-2s random
}

const headers = {
  'User-Agent': randomUA(),
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function now() {
  return Date.now();
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, 'manga'))) fs.mkdirSync(path.join(DATA_DIR, 'manga'), { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, 'chapters'))) fs.mkdirSync(path.join(DATA_DIR, 'chapters'), { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function toLocalPath(href) {
  if (!href) return null;
  if (href.startsWith('#') || href.includes('#/')) return null;
  try {
    if (href.startsWith('http://') || href.startsWith('https://')) {
      const u = new URL(href);
      href = u.pathname + u.search;
    }
  } catch (_) {
    href = href.replace(/^https?:\/\/[^/]+/i, '');
  }
  if (!href.startsWith('/')) href = '/' + href;
  return href.replace(/\/+$/, '') || '/';
}

function slugFromPath(p) {
  if (!p) return null;
  return p.replace(/^\/+|\/+$/g, '').replace(/^manga\//, '');
}

async function fetchPage(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const reqHeaders = { ...headers, 'User-Agent': randomUA() };
      const res = await axios.get(url, { headers: reqHeaders, timeout: 30000 });
      return res.data;
    } catch (err) {
      if (i < retries - 1) await sleep(randomDelay());
    }
  }
  return null;
}

function extractGenres($) {
  const genres = [];
  const seen = new Set();
  const selectors = [
    '.wd-full .mgen a',
    '.mgen a',
    '.seriestugenre a',
    'a[href*="/genres/"]'
  ];
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (!name || href.includes('/author/') || href.includes('/artist/')) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      genres.push({ name, url: toLocalPath(href) });
    });
    if (genres.length) break;
  }
  const withPath = genres.filter(g => g.url && String(g.url).includes('/genres/'));
  return withPath.length ? withPath : genres;
}

async function scrapeLatestList(deadline) {
  const items = [];
  const seen = new Set();

  // homepage latest
  if (now() < deadline) {
    const homeHtml = await fetchPage(BASE_URL);
    if (homeHtml) {
      const $ = cheerio.load(homeHtml);
      $('.postbody .listupd .bs, .listupd .bs').each((_, el) => {
        const href = toLocalPath($(el).find('a').first().attr('href'));
        if (!href) return;
        // latest cards may point to chapter URL; normalize to manga if possible
        let mangaUrl = href;
        let slug = slugFromPath(href);
        if (!href.startsWith('/manga/')) {
          // chapter link -> keep for chapter scrape; try derive manga slug
          const mSlug = slug.replace(/-chapter-[\d.]+$/i, '').replace(/-ch-[\d.]+$/i, '');
          mangaUrl = `/manga/${mSlug}`;
          slug = mSlug;
        } else {
          slug = slugFromPath(href);
        }
        if (seen.has(slug)) return;
        seen.add(slug);
        items.push({
          slug,
          title: $(el).find('.tt').text().trim() || slug,
          url: mangaUrl.startsWith('/manga/') ? mangaUrl : `/manga/${slug}`,
          image: $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || null,
          chapter: $(el).find('.epxs').text().trim() || null,
          rating: $(el).find('.numscore').text().trim() || null,
          type: $(el).find('.type').text().trim() || 'Manga',
          time: $(el).find('.epxdate').text().trim() || null,
          chapterUrl: href.startsWith('/manga/') ? null : href
        });
      });
    }
    await sleep(randomDelay());
  }

  // update-ordered list pages
  for (let p = 1; p <= LATEST_PAGES && now() < deadline; p++) {
    const html = await fetchPage(`${BASE_URL}/manga/?page=${p}&order=update`);
    if (!html) continue;
    const $ = cheerio.load(html);
    $('.listupd .bs').each((_, el) => {
      const href = toLocalPath($(el).find('a').first().attr('href'));
      if (!href || !href.startsWith('/manga/')) return;
      const slug = slugFromPath(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      items.push({
        slug,
        title: $(el).find('.tt').text().trim() || slug,
        url: href,
        image: $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || null,
        chapter: $(el).find('.epxs').text().trim() || null,
        rating: $(el).find('.numscore').text().trim() || null,
        type: $(el).find('.type').text().trim() || 'Manga',
        time: $(el).find('.epxdate').text().trim() || null,
        chapterUrl: null
      });
    });
    await sleep(randomDelay());
  }

  return items;
}

async function scrapeMangaDetail(slug, deadline) {
  if (now() >= deadline) return null;
  const html = await fetchPage(`${BASE_URL}/manga/${encodeURI(slug)}/`);
  if (!html) return null;
  const $ = cheerio.load(html);

  const manga = {
    slug,
    title: $('.main-info h1.entry-title').first().text().trim() || slug,
    image: $('.main-info .thumb img').attr('src') || $('.main-info .thumb img').attr('data-src') || null,
    rating: $('.rating-prc .num, .numscore').first().text().trim() || null,
    description: $('.entry-content p').first().text().trim() || null,
    status: $('.imptdt:contains("Status") i').first().text().trim() || null,
    type: $('.imptdt:contains("Type") a').first().text().trim() || null,
    genres: extractGenres($),
    chapters: [],
    scrapedAt: new Date().toISOString()
  };

  $('.eplister ul li').each((_, el) => {
    const href = toLocalPath($(el).find('.eph-num a').attr('href'));
    if (!href) return;
    manga.chapters.push({
      title: $(el).find('.eph-num a .chapternum').text().trim()
        || $(el).find('.eph-num a').first().text().trim(),
      url: href,
      slug: slugFromPath(href),
      date: $(el).find('.eph-num a .chapterdate').text().trim() || null
    });
  });

  return manga;
}

async function scrapeChapter(chapterSlug, deadline) {
  if (now() >= deadline) return null;
  const file = path.join(DATA_DIR, 'chapters', `${chapterSlug}.json`);
  if (fs.existsSync(file)) {
    const existing = loadJson(file, null);
    if (existing && existing.images && existing.images.length) return existing;
  }

  const html = await fetchPage(`${BASE_URL}/${encodeURI(chapterSlug)}/`);
  if (!html) return null;
  const $ = cheerio.load(html);

  let images = [];
  let prevChapter = null;
  let nextChapter = null;
  const readerMatch = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
  if (readerMatch) {
    try {
      const readerData = JSON.parse(readerMatch[1]);
      prevChapter = toLocalPath(readerData.prevUrl);
      nextChapter = toLocalPath(readerData.nextUrl);
      if (Array.isArray(readerData.sources) && readerData.sources.length) {
        const source = readerData.sources.find(s => s.source === readerData.defaultSource)
          || readerData.sources[0];
        if (source && Array.isArray(source.images)) {
          images = source.images
            .map(img => String(img).replace(/\\\//g, '/'))
            .filter(img => img && !img.includes('readerarea.svg'));
        }
      }
    } catch (_) {}
  }

  const chapter = {
    slug: chapterSlug,
    title: $('h1.entry-title').first().text().trim(),
    prevChapter,
    nextChapter,
    images,
    imageCount: images.length,
    scrapedAt: new Date().toISOString()
  };
  saveJson(file, chapter);
  return chapter;
}

async function runScheduledScrape(options = {}) {
  ensureDirs();
  const started = now();
  const deadline = started + (options.maxMs || MAX_MS);
  const status = {
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    durationMs: 0,
    ok: false,
    latestFound: 0,
    mangaUpdated: 0,
    chaptersScraped: 0,
    stoppedReason: null,
    error: null
  };

  console.log(`[scrape] start (max ${Math.round((options.maxMs || MAX_MS) / 60000)} min)`);

  const listFile = path.join(DATA_DIR, 'manga-list.json');
  let mangaMap = loadJson(listFile, {});

  try {

    const latest = await scrapeLatestList(deadline);
    status.latestFound = latest.length;
    console.log(`[scrape] latest candidates: ${latest.length}`);

    // merge into manga-list (put newest first conceptually by overwrite order)
    for (const item of latest) {
      const prev = mangaMap[item.slug] || {};
      mangaMap[item.slug] = {
        ...prev,
        slug: item.slug,
        title: item.title || prev.title,
        url: item.url || prev.url,
        image: item.image || prev.image,
        chapter: item.chapter || prev.chapter,
        rating: item.rating || prev.rating,
        type: item.type || prev.type,
        time: item.time || prev.time || null
      };
    }
    saveJson(listFile, mangaMap);

    // detail + chapters for candidates until time runs out
    for (const item of latest) {
      if (now() >= deadline) {
        status.stoppedReason = 'time_limit';
        break;
      }

      const detailFile = path.join(DATA_DIR, 'manga', `${item.slug}.json`);
      const existing = loadJson(detailFile, null);
      const needDetail = !existing
        || !existing.chapters
        || !existing.chapters.length
        || (item.chapter && existing.chapter && item.chapter !== existing.chapter)
        || !existing.genres
        || !existing.genres.length;

      let detail = existing;
      if (needDetail) {
        console.log(`[scrape] manga ${item.slug}`);
        detail = await scrapeMangaDetail(item.slug, deadline);
        if (detail) {
          // preserve old chapters if live empty
          if ((!detail.chapters || !detail.chapters.length) && existing && existing.chapters) {
            detail.chapters = existing.chapters;
          }
          saveJson(detailFile, detail);
          status.mangaUpdated++;
          // also refresh list entry
          mangaMap[item.slug] = {
            ...(mangaMap[item.slug] || {}),
            slug: item.slug,
            title: detail.title,
            url: `/manga/${item.slug}`,
            image: detail.image,
            chapter: (detail.chapters && detail.chapters[0] && detail.chapters[0].title) || item.chapter,
            rating: detail.rating,
            type: detail.type
          };
          saveJson(listFile, mangaMap);
        }
        await sleep(randomDelay());
      }

      if (now() >= deadline) {
        status.stoppedReason = 'time_limit';
        break;
      }

      const chapters = (detail && detail.chapters) || [];
      // scrape a few newest chapters missing locally (list often newest-first)
      const toFetch = chapters.slice(0, 3);
      for (const ch of toFetch) {
        if (now() >= deadline) {
          status.stoppedReason = 'time_limit';
          break;
        }
        const chSlug = ch.slug || slugFromPath(ch.url);
        if (!chSlug) continue;
        const chFile = path.join(DATA_DIR, 'chapters', `${chSlug}.json`);
        if (fs.existsSync(chFile)) {
          const ex = loadJson(chFile, null);
          if (ex && ex.images && ex.images.length) continue;
        }
        console.log(`[scrape] chapter ${chSlug}`);
        const scraped = await scrapeChapter(chSlug, deadline);
        if (scraped && scraped.imageCount > 0) status.chaptersScraped++;
        await sleep(randomDelay());
      }

      // if latest card pointed to a chapter URL, ensure that chapter exists
      if (item.chapterUrl && now() < deadline) {
        const chSlug = slugFromPath(item.chapterUrl);
        if (chSlug) {
          const chFile = path.join(DATA_DIR, 'chapters', `${chSlug}.json`);
          if (!fs.existsSync(chFile)) {
            const scraped = await scrapeChapter(chSlug, deadline);
            if (scraped && scraped.imageCount > 0) status.chaptersScraped++;
            await sleep(randomDelay());
          }
        }
      }
    }

    if (!status.stoppedReason) status.stoppedReason = 'completed';
    status.ok = true;
  } catch (err) {
    status.error = err.message || String(err);
    status.stoppedReason = 'error';
    console.error('[scrape] error:', status.error);
  }

  status.finishedAt = new Date().toISOString();
  status.durationMs = now() - started;
  saveJson(path.join(DATA_DIR, 'scrape-schedule-status.json'), status);

  // Update komiktap.json so running server picks up changes immediately
  try {
    const komiktapFile = path.join(DATA_DIR, 'komiktap.json');
    const komiktap = loadJson(komiktapFile, { items: [], totalItems: 0 });
    const existingMap = new Map((komiktap.items || []).map(i => [i.slug, i]));
    for (const [slug, item] of Object.entries(mangaMap)) {
      const existing = existingMap.get(slug) || {};
      existingMap.set(slug, {
        ...existing,
        slug,
        title: item.title || existing.title || slug,
        url: item.url || `/manga/${slug}`,
        image: item.image || existing.image || null,
        chapter: item.chapter || existing.chapter || '',
        rating: item.rating || existing.rating || '',
        type: item.type || existing.type || 'Manga',
        updatedAt: Date.now()
      });
    }
    komiktap.items = [...existingMap.values()];
    komiktap.totalItems = komiktap.items.length;
    komiktap.lastScraped = new Date().toISOString();
    saveJson(komiktapFile, komiktap);
    console.log(`[scrape] updated komiktap.json: ${komiktap.items.length} items`);
  } catch (e) {
    console.error('[scrape] failed to update komiktap.json:', e.message);
  }

  console.log(`[scrape] done in ${Math.round(status.durationMs / 1000)}s | manga=${status.mangaUpdated} chapters=${status.chaptersScraped} reason=${status.stoppedReason}`);
  return status;
}

// CLI
if (require.main === module) {
  runScheduledScrape()
    .then(s => process.exit(s.ok ? 0 : 1))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runScheduledScrape };
