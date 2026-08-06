const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://komikhentaiku.com';
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function readLocalJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

// Convert absolute site URL to local path for SPA routing
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

async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching ${url}:`, error.message);
    return null;
  }
}

// In-memory cache for home API (speeds up repeated visits)
const homeCache = new Map();
const HOME_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getLocalMangaArray() {
  const map = readLocalJson(path.join(DATA_DIR, 'manga-list.json')) || {};
  return Object.values(map)
    .filter(m => m && m.title)
    .map(m => ({
      title: m.title,
      url: m.url || (m.slug ? `/manga/${m.slug}` : null),
      image: m.image || null,
      chapter: m.chapter || 'Chapter 1',
      rating: m.rating || '7.00',
      type: m.type || 'Manga',
      time: m.time || null,
      slug: m.slug || null
    }))
    .filter(m => m.url);
}

app.get('/api/home', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const perPage = 36;
    const cacheKey = `home:${page}`;
    const cached = homeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HOME_CACHE_TTL) {
      res.set('X-Cache', 'HIT');
      return res.json(cached.data);
    }

    // Prefer local scraped data (fast) — no live scrape on every request
    let all = getLocalMangaArray();

    // Sort: higher rating first for "popular", keep list order for latest-ish
    let popularItems = [];
    if (page === 1 && all.length) {
      popularItems = [...all]
        .sort((a, b) => parseFloat(b.rating || 0) - parseFloat(a.rating || 0))
        .slice(0, 15)
        .map(m => ({
          title: m.title,
          url: m.url,
          image: m.image,
          chapter: m.chapter,
          rating: m.rating,
          type: m.type
        }));
    }

    // If local empty, fallback to lightweight live scrape (page 1 only)
    if (!all.length) {
      const homeHtml = await fetchPage(BASE_URL);
      if (homeHtml) {
        const $h = cheerio.load(homeHtml);
        if (page === 1) {
          $h('.hotslid .popularslider .bs').each((i, el) => {
            if (i < 16) {
              popularItems.push({
                title: $h(el).find('.tt').text().trim(),
                url: toLocalPath($h(el).find('a').attr('href')),
                image: $h(el).find('img').attr('src'),
                chapter: $h(el).find('.epxs').text().trim(),
                rating: $h(el).find('.numscore').text().trim(),
                type: $h(el).find('.type').text().trim()
              });
            }
          });
        }
        $h('.postbody .listupd .bs').each((_, el) => {
          all.push({
            title: $h(el).find('.tt').text().trim(),
            url: toLocalPath($h(el).find('a').attr('href')),
            image: $h(el).find('img').attr('src'),
            chapter: $h(el).find('.epxs').text().trim(),
            time: $h(el).find('.epxdate').text().trim(),
            rating: $h(el).find('.numscore').text().trim(),
            type: $h(el).find('.type').text().trim()
          });
        });
      }
    }

    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * perPage;
    const latestItems = all.slice(start, start + perPage).map(m => ({
      title: m.title,
      url: m.url,
      image: m.image,
      chapter: m.chapter,
      time: m.time || null,
      rating: m.rating,
      type: m.type
    }));

    const payload = {
      popular: popularItems,
      latest: latestItems,
      pagination: {
        currentPage,
        perPage,
        totalPages,
        hasPrev: currentPage > 1,
        hasNext: currentPage < totalPages && latestItems.length > 0
      }
    };

    homeCache.set(cacheKey, { at: Date.now(), data: payload });
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/manga/:slug', async (req, res) => {
  try {
    const slug = decodeURIComponent(req.params.slug).replace(/\/+$/, '');

    // Prefer local scraped data if genres already present
    const localPath = path.join(DATA_DIR, 'manga', `${slug}.json`);
    let local = readLocalJson(localPath);
    // also try encoded filename variants from scraper
    if (!local) {
      try {
        const files = fs.readdirSync(path.join(DATA_DIR, 'manga'));
        const hit = files.find(f => {
          try {
            return decodeURIComponent(f.replace(/\.json$/, '')) === slug
              || f.replace(/\.json$/, '') === slug
              || f.replace(/\.json$/, '') === encodeURIComponent(slug);
          } catch { return false; }
        });
        if (hit) local = readLocalJson(path.join(DATA_DIR, 'manga', hit));
      } catch (_) {}
    }
    if (local && local.title && Array.isArray(local.genres) && local.genres.length > 0) {
      return res.json(local);
    }

    const url = `${BASE_URL}/manga/${encodeURI(slug)}/`;
    const html = await fetchPage(url);
    if (!html) {
      // fallback to local even if genres empty
      if (local && local.title) return res.json(local);
      return res.status(500).json({ error: 'Failed to fetch page' });
    }
    
    const $ = cheerio.load(html);
    
    const mangaInfo = {
      title: $('.main-info h1.entry-title').first().text().trim() || (local && local.title) || slug,
      image: $('.main-info .thumb img').attr('src') || (local && local.image) || null,
      rating: $('.rating-prc .num, .numscore').first().text().trim() || (local && local.rating) || null,
      description: $('.entry-content p').first().text().trim() || (local && local.description) || null,
      genres: [],
      chapters: (local && local.chapters) || [],
      status: $('.imptdt:contains("Status") i').first().text().trim() || (local && local.status) || null,
      type: $('.imptdt:contains("Type") a').first().text().trim() || (local && local.type) || null,
      slug
    };
    
    // Genres: multiple selectors (theme variants)
    const genreSeen = new Set();
    const genreSelectors = [
      '.wd-full .mgen a',
      '.mgen a',
      '.seriestugenre a',
      'span.mgen a',
      '.info-desc .mgen a',
      'a[href*="/genres/"]',
      'a[rel="tag"]'
    ];
    for (const sel of genreSelectors) {
      $(sel).each((_, el) => {
        const name = $(el).text().trim();
        const href = $(el).attr('href') || '';
        if (!name) return;
        if (href.includes('/author/') || href.includes('/artist/')) return;
        const key = name.toLowerCase();
        if (genreSeen.has(key)) return;
        genreSeen.add(key);
        mangaInfo.genres.push({
          name,
          url: toLocalPath(href) || href
        });
      });
      if (mangaInfo.genres.length > 0 && sel !== 'a[rel="tag"]') break;
    }
    // Prefer /genres/ links if mixed
    const withPath = mangaInfo.genres.filter(g => g.url && String(g.url).includes('/genres/'));
    if (withPath.length > 0) mangaInfo.genres = withPath;
    
    // Refresh chapters from live page if available
    const liveChapters = [];
    $('.eplister ul li').each((i, el) => {
      const chUrl = toLocalPath($(el).find('.eph-num a').attr('href'));
      if (!chUrl) return;
      liveChapters.push({
        title: $(el).find('.eph-num a .chapternum').text().trim() || $(el).find('.eph-num a').first().text().trim(),
        url: chUrl,
        slug: chUrl.replace(/^\/+/, ''),
        date: $(el).find('.eph-num a .chapterdate').text().trim()
      });
    });
    if (liveChapters.length > 0) mangaInfo.chapters = liveChapters;

    // Cache back to local file if we found genres
    try {
      const mangaDir = path.join(DATA_DIR, 'manga');
      if (!fs.existsSync(mangaDir)) fs.mkdirSync(mangaDir, { recursive: true });
      const out = {
        ...(local || {}),
        ...mangaInfo,
        genres: mangaInfo.genres,
        chapters: mangaInfo.chapters,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(path.join(mangaDir, `${slug}.json`), JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {
      console.error('cache manga fail', e.message);
    }
    
    res.json(mangaInfo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Guess manga slug from chapter slug: "title-chapter-1" -> "title"
function mangaSlugFromChapter(chapterSlug) {
  return chapterSlug
    .replace(/-chapter-\d+(\.\d+)?$/i, '')
    .replace(/-ch-\d+(\.\d+)?$/i, '')
    .replace(/-episode-\d+(\.\d+)?$/i, '');
}

function extractChapterNumber(titleOrSlug) {
  const m = String(titleOrSlug || '').match(/(?:chapter|ch\.?|episode)\s*([0-9]+(?:\.[0-9]+)?)/i)
    || String(titleOrSlug || '').match(/-(\d+(?:\.\d+)?)$/);
  return m ? parseFloat(m[1]) : null;
}

// Build prev/next from manga chapter list (each chapter is separate)
function resolveChapterNav(chapterSlug, mangaDetail) {
  if (!mangaDetail || !Array.isArray(mangaDetail.chapters) || mangaDetail.chapters.length === 0) {
    return { prevChapter: null, nextChapter: null, chapters: [], currentIndex: -1, seriesUrl: null };
  }

  // Site lists newest first often — sort ascending by chapter number
  const chapters = mangaDetail.chapters.map((ch, i) => ({
    ...ch,
    url: ch.url || (ch.slug ? `/${ch.slug}` : null),
    slug: ch.slug || (ch.url ? ch.url.replace(/^\/+/, '') : null),
    number: extractChapterNumber(ch.title) ?? extractChapterNumber(ch.slug || ch.url) ?? (i + 1)
  })).filter(ch => ch.url || ch.slug);

  chapters.sort((a, b) => (a.number || 0) - (b.number || 0));

  const currentIndex = chapters.findIndex(ch =>
    ch.slug === chapterSlug ||
    (ch.url && ch.url.replace(/^\/+/, '') === chapterSlug)
  );

  const prev = currentIndex > 0 ? chapters[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < chapters.length - 1 ? chapters[currentIndex + 1] : null;

  return {
    prevChapter: prev ? (prev.url || `/${prev.slug}`) : null,
    nextChapter: next ? (next.url || `/${next.slug}`) : null,
    chapters: chapters.map(ch => ({
      title: ch.title,
      url: ch.url || `/${ch.slug}`,
      slug: ch.slug,
      number: ch.number,
      date: ch.date || null
    })),
    currentIndex,
    seriesUrl: mangaDetail.slug ? `/manga/${mangaDetail.slug}` : null,
    seriesTitle: mangaDetail.title || null
  };
}

app.get('/api/chapter/:slug', async (req, res) => {
  try {
    const slug = decodeURIComponent(req.params.slug).replace(/\/+$/, '');
    const mangaSlug = mangaSlugFromChapter(slug);

    // Load series chapter list for per-chapter navigation
    let mangaDetail = readLocalJson(path.join(DATA_DIR, 'manga', `${mangaSlug}.json`));
    if (!mangaDetail) {
      // live fetch series if needed
      try {
        const seriesHtml = await fetchPage(`${BASE_URL}/manga/${mangaSlug}/`);
        if (seriesHtml) {
          const $s = cheerio.load(seriesHtml);
          mangaDetail = {
            slug: mangaSlug,
            title: $s('.main-info h1.entry-title').first().text().trim(),
            chapters: []
          };
          $s('.eplister ul li').each((_, el) => {
            mangaDetail.chapters.push({
              title: $s(el).find('.eph-num a .chapternum').text().trim() || $s(el).find('.eph-num a').first().text().trim(),
              url: toLocalPath($s(el).find('.eph-num a').attr('href')),
              slug: null,
              date: $s(el).find('.eph-num a .chapterdate').text().trim()
            });
          });
          mangaDetail.chapters.forEach(ch => {
            if (ch.url) ch.slug = ch.url.replace(/^\/+/, '');
          });
        }
      } catch (_) {}
    }

    const nav = resolveChapterNav(slug, mangaDetail);

    // Prefer local scraped chapter data (ONE chapter file only)
    const local = readLocalJson(path.join(DATA_DIR, 'chapters', `${slug}.json`));
    if (local && Array.isArray(local.images) && local.images.length > 0) {
      return res.json({
        ...local,
        slug,
        mangaSlug,
        seriesUrl: nav.seriesUrl || local.seriesUrl || `/manga/${mangaSlug}`,
        seriesTitle: nav.seriesTitle || local.seriesTitle || null,
        prevChapter: nav.prevChapter || local.prevChapter || null,
        nextChapter: nav.nextChapter || local.nextChapter || null,
        chapters: nav.chapters,
        currentIndex: nav.currentIndex,
        chapterNumber: extractChapterNumber(local.title) || extractChapterNumber(slug)
      });
    }

    const url = `${BASE_URL}/${slug}/`;
    const html = await fetchPage(url);
    if (!html) {
      return res.status(500).json({ error: 'Failed to fetch page' });
    }
    
    const $ = cheerio.load(html);
    let images = [];
    let prevChapter = nav.prevChapter;
    let nextChapter = nav.nextChapter;

    // Primary source: ts_reader.run({...}) — images for THIS chapter only
    const readerMatch = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
    if (readerMatch) {
      try {
        const readerData = JSON.parse(readerMatch[1]);
        if (!prevChapter) prevChapter = toLocalPath(readerData.prevUrl);
        if (!nextChapter) nextChapter = toLocalPath(readerData.nextUrl);

        if (Array.isArray(readerData.sources) && readerData.sources.length > 0) {
          let source = readerData.sources.find(s => s.source === readerData.defaultSource)
            || readerData.sources[0];
          if (source && Array.isArray(source.images)) {
            images = source.images
              .map(img => String(img).replace(/\\\//g, '/'))
              .filter(img => img && !img.includes('readerarea.svg'));
          }
        }
      } catch (parseErr) {
        console.error('ts_reader parse error:', parseErr.message);
      }
    }

    if (images.length === 0 && readerMatch) {
      const imgRe = /https?:\\\/\\\/[^"\\]+?\.(?:jpg|jpeg|png|gif|webp)/gi;
      let m;
      while ((m = imgRe.exec(readerMatch[1])) !== null) {
        images.push(m[0].replace(/\\\//g, '/'));
      }
    }

    if (images.length === 0) {
      $('#readerarea img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && !src.includes('readerarea.svg')) images.push(src);
      });
    }

    const seen = new Set();
    const uniqueImages = images.filter(img => {
      if (seen.has(img)) return false;
      seen.add(img);
      return true;
    });

    if (!prevChapter) prevChapter = toLocalPath($('.ch-prev-btn[rel="prev"]').attr('href'));
    if (!nextChapter) nextChapter = toLocalPath($('.ch-next-btn[rel="next"]').attr('href'));

    const seriesLink = toLocalPath($('.allc a').attr('href')) || nav.seriesUrl || `/manga/${mangaSlug}`;

    const chapterInfo = {
      slug,
      mangaSlug,
      title: $('h1.entry-title').first().text().trim(),
      seriesUrl: seriesLink,
      seriesTitle: nav.seriesTitle || $('.allc a').text().trim() || null,
      prevChapter,
      nextChapter,
      chapters: nav.chapters,
      currentIndex: nav.currentIndex,
      chapterNumber: extractChapterNumber($('h1.entry-title').first().text()) || extractChapterNumber(slug),
      images: uniqueImages,
      imageCount: uniqueImages.length
    };
    
    console.log(`Chapter ${slug}: ${uniqueImages.length} images | prev=${prevChapter} next=${nextChapter}`);
    res.json(chapterInfo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/list', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const order = req.query.order || 'update';
    const url = `${BASE_URL}/manga/?page=${page}&order=${order}`;
    const html = await fetchPage(url);
    if (!html) {
      return res.status(500).json({ error: 'Failed to fetch page' });
    }
    
    const $ = cheerio.load(html);
    
    const items = [];
    $('.listupd .bs, .seriestucon .seriestucont .seriestucontr').each((i, el) => {
      items.push({
        title: $(el).find('.tt, h2, h3').first().text().trim(),
        url: toLocalPath($(el).find('a').first().attr('href')),
        image: $(el).find('img').attr('src'),
        chapter: $(el).find('.epxs').text().trim(),
        rating: $(el).find('.numscore').text().trim(),
        type: $(el).find('.type').text().trim()
      });
    });
    
    const pagination = {
      currentPage: page,
      nextPage: $('.pagination .next, .hpage a:last').attr('href'),
      prevPage: $('.pagination .prev, .hpage a:first').attr('href')
    };
    
    res.json({ items, pagination });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

function genreKeyFromName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildGenreIndex() {
  const mangaDir = path.join(DATA_DIR, 'manga');
  const map = {};
  if (!fs.existsSync(mangaDir)) return [];

  const files = fs.readdirSync(mangaDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(mangaDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(j.genres) || j.genres.length === 0) continue;
    for (const g of j.genres) {
      const name = (typeof g === 'string' ? g : g.name || '').trim();
      if (!name) continue;
      const key = genreKeyFromName(name);
      if (!key) continue;
      if (!map[key]) {
        map[key] = {
          name,
          slug: key,
          url: (typeof g === 'object' && g.url) ? g.url : `/genres/${key}`,
          count: 0
        };
      }
      map[key].count++;
      // keep nicer casing if longer/better
      if (name.length > map[key].name.length) map[key].name = name;
    }
  }

  return Object.values(map).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function getMangaByGenre(genreSlug) {
  const mangaDir = path.join(DATA_DIR, 'manga');
  const items = [];
  if (!fs.existsSync(mangaDir)) return items;
  const target = genreKeyFromName(genreSlug);

  const files = fs.readdirSync(mangaDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(mangaDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(j.genres) || !j.genres.length) continue;
    const hit = j.genres.some(g => {
      const name = typeof g === 'string' ? g : g.name || '';
      const url = typeof g === 'object' ? (g.url || '') : '';
      const key = genreKeyFromName(name);
      return key === target || url.includes(`/genres/${target}`) || url.endsWith(`/${target}`);
    });
    if (!hit) continue;
    items.push({
      title: j.title,
      url: j.slug ? `/manga/${j.slug}` : null,
      image: j.image,
      chapter: (j.chapters && j.chapters[0] && j.chapters[0].title) || 'Chapter 1',
      rating: j.rating || '7.00',
      type: j.type || 'Manga',
      slug: j.slug
    });
  }

  return items
    .filter(i => i.url)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

app.get('/api/genres', async (req, res) => {
  try {
    const genres = buildGenreIndex();
    res.json({
      total: genres.length,
      totalMangaWithGenres: genres.reduce((s, g) => s + g.count, 0),
      genres
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/genres/:slug', async (req, res) => {
  try {
    const slug = decodeURIComponent(req.params.slug).replace(/\/+$/, '');
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const perPage = Math.max(1, Math.min(60, parseInt(req.query.perPage || '36', 10) || 36));

    const allGenres = buildGenreIndex();
    const genreMeta = allGenres.find(g => g.slug === genreKeyFromName(slug)) || {
      name: slug,
      slug: genreKeyFromName(slug),
      count: 0
    };

    const all = getMangaByGenre(slug);
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * perPage;
    const items = all.slice(start, start + perPage);

    res.json({
      genre: { ...genreMeta, count: total },
      items,
      pagination: {
        currentPage,
        totalPages,
        perPage,
        hasPrev: currentPage > 1,
        hasNext: currentPage < totalPages
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.s;
    if (!query) {
      return res.status(400).json({ error: 'Query required' });
    }
    
    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    const html = await fetchPage(url);
    if (!html) {
      return res.status(500).json({ error: 'Failed to fetch page' });
    }
    
    const $ = cheerio.load(html);
    
    const results = [];
    $('.listupd .bs, .search-result .bs').each((i, el) => {
      results.push({
        title: $(el).find('.tt, h2, h3').first().text().trim(),
        url: toLocalPath($(el).find('a').first().attr('href')),
        image: $(el).find('img').attr('src'),
        chapter: $(el).find('.epxs').text().trim(),
        type: $(el).find('.type').text().trim()
      });
    });
    
    res.json({ results, query });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// A-Z Lists from local scraped data (fallback: live scrape title list)
function getFirstLetterKey(title) {
  const t = String(title || '').trim();
  if (!t) return '#';
  const ch = t.charAt(0).toUpperCase();
  if (ch >= 'A' && ch <= 'Z') return ch;
  if (ch >= '0' && ch <= '9') return '0-9';
  return '#';
}

function loadAllMangaItems() {
  const map = readLocalJson(path.join(DATA_DIR, 'manga-list.json')) || {};
  return Object.values(map)
    .filter(m => m && m.title)
    .map(m => ({
      title: m.title,
      url: m.url || (m.slug ? `/manga/${m.slug}` : null),
      image: m.image || null,
      chapter: m.chapter || 'Chapter 1',
      rating: m.rating || '7.00',
      type: m.type || 'Manga',
      slug: m.slug || null,
      letter: getFirstLetterKey(m.title)
    }))
    .filter(m => m.url)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

app.get('/api/az', async (req, res) => {
  try {
    const show = String(req.query.show || 'A').toUpperCase();
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const perPage = Math.max(1, Math.min(60, parseInt(req.query.perPage || '20', 10) || 20));

    let all = loadAllMangaItems();

    // If local empty, try live first page of title-ordered list as fallback
    if (all.length === 0) {
      const html = await fetchPage(`${BASE_URL}/manga/?page=1&order=title`);
      if (html) {
        const $ = cheerio.load(html);
        $('.listupd .bs').each((_, el) => {
          const title = $(el).find('.tt').text().trim();
          const url = toLocalPath($(el).find('a').first().attr('href'));
          if (!title || !url) return;
          all.push({
            title,
            url,
            image: $(el).find('img').attr('src'),
            chapter: $(el).find('.epxs').text().trim() || 'Chapter 1',
            rating: $(el).find('.numscore').text().trim() || '7.00',
            type: $(el).find('.type').text().trim() || 'Manga',
            slug: url.replace(/^\/manga\//, ''),
            letter: getFirstLetterKey(title)
          });
        });
        all.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      }
    }

    const validKeys = ['#', '0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
    const key = validKeys.includes(show) ? show : 'A';

    const filtered = all.filter(m => m.letter === key);
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * perPage;
    const items = filtered.slice(start, start + perPage);

    // counts per letter for UI
    const counts = {};
    validKeys.forEach(k => { counts[k] = 0; });
    all.forEach(m => {
      if (counts[m.letter] != null) counts[m.letter]++;
      else counts['#']++;
    });

    res.json({
      show: key,
      items,
      counts,
      total,
      totalAll: all.length,
      pagination: {
        currentPage,
        totalPages,
        perPage,
        hasPrev: currentPage > 1,
        hasNext: currentPage < totalPages
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Scheduled live scrape (every 6 hours, max ~10 minutes) =====
const SCRAPE_EVERY_MS = Math.max(60_000, parseInt(process.env.SCRAPE_EVERY_MS || String(6 * 60 * 60 * 1000), 10));
const SCRAPE_MAX_MS = Math.max(60_000, parseInt(process.env.SCRAPE_MAX_MS || String(10 * 60 * 1000), 10));
const SCRAPE_ENABLED = String(process.env.SCRAPE_ENABLED || 'true').toLowerCase() !== 'false';

let scrapeRunning = false;
let scrapeTimer = null;
let lastScrapeStatus = readLocalJson(path.join(DATA_DIR, 'scrape-schedule-status.json'));

async function triggerScheduledScrape(reason = 'schedule') {
  if (!SCRAPE_ENABLED) {
    console.log('[scrape] disabled via SCRAPE_ENABLED=false');
    return null;
  }
  if (scrapeRunning) {
    console.log('[scrape] skip, already running');
    return lastScrapeStatus;
  }
  scrapeRunning = true;
  console.log(`[scrape] trigger (${reason})`);
  try {
    // clear home cache so visitors see updated list after scrape
    if (typeof homeCache !== 'undefined' && homeCache.clear) homeCache.clear();
    const { runScheduledScrape } = require('./scrape-scheduled');
    lastScrapeStatus = await runScheduledScrape({ maxMs: SCRAPE_MAX_MS });
    lastScrapeStatus.trigger = reason;
    // clear cache again after success
    if (typeof homeCache !== 'undefined' && homeCache.clear) homeCache.clear();
    return lastScrapeStatus;
  } catch (err) {
    console.error('[scrape] failed:', err.message);
    lastScrapeStatus = {
      ok: false,
      error: err.message,
      finishedAt: new Date().toISOString(),
      trigger: reason
    };
    return lastScrapeStatus;
  } finally {
    scrapeRunning = false;
  }
}

function startScrapeScheduler() {
  if (!SCRAPE_ENABLED) {
    console.log('[scrape] scheduler off');
    return;
  }
  console.log(`[scrape] scheduler on: every ${Math.round(SCRAPE_EVERY_MS / 3600000)}h, max ${Math.round(SCRAPE_MAX_MS / 60000)} min/run`);

  // first run shortly after boot (don't block listen)
  setTimeout(() => {
    triggerScheduledScrape('startup');
  }, 30_000);

  scrapeTimer = setInterval(() => {
    triggerScheduledScrape('interval');
  }, SCRAPE_EVERY_MS);

  if (scrapeTimer.unref) scrapeTimer.unref();
}

app.get('/api/scrape/status', (req, res) => {
  res.json({
    enabled: SCRAPE_ENABLED,
    running: scrapeRunning,
    everyMs: SCRAPE_EVERY_MS,
    maxMs: SCRAPE_MAX_MS,
    last: lastScrapeStatus || null,
    note: 'On free hosts (Render), disk is ephemeral — scraped files may reset on redeploy/sleep. Prefer always-on hosting for persistent updates.'
  });
});

// Manual trigger (optional secret)
app.post('/api/scrape/run', async (req, res) => {
  const secret = process.env.SCRAPE_SECRET || '';
  if (secret && req.headers['x-scrape-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (scrapeRunning) {
    return res.json({ ok: true, message: 'already running', last: lastScrapeStatus });
  }
  // run async
  triggerScheduledScrape('manual');
  res.json({ ok: true, message: 'scrape started', maxMs: SCRAPE_MAX_MS });
});

// Dynamic SEO for manga / chapter pages (crawlers get useful title & description)
function escapeHtmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  // /manga/:slug
  const mangaMatch = pathName.match(/^\/manga\/([^/]+)$/);
  if (mangaMatch) {
    const slug = decodeURIComponent(mangaMatch[1]);
    const local = readLocalJson(path.join(DATA_DIR, 'manga', `${slug}.json`));
    if (local && local.title) {
      title = `${local.title} - Baca Manga Hentai Sub Indo | micinime`;
      const genres = Array.isArray(local.genres)
        ? local.genres.map(g => (typeof g === 'string' ? g : g.name)).filter(Boolean).slice(0, 6).join(', ')
        : '';
      const base = local.description
        ? String(local.description).replace(/\s+/g, ' ').trim().slice(0, 120)
        : `Baca ${local.title} bahasa Indonesia`;
      desc = `${base}${genres ? ` Genre: ${genres}.` : ''} Baca manga hentai sub indo gratis di micinime.`.slice(0, 160);
      if (local.image) image = local.image;
    }
  } else if (pathName !== '/' && !pathName.startsWith('/api') && !pathName.includes('.')) {
    // chapter-like path
    const slug = decodeURIComponent(pathName.replace(/^\//, ''));
    const ch = readLocalJson(path.join(DATA_DIR, 'chapters', `${slug}.json`));
    const mangaSlug = slug.replace(/-chapter-[\d.]+$/i, '').replace(/-ch-[\d.]+$/i, '');
    const series = readLocalJson(path.join(DATA_DIR, 'manga', `${mangaSlug}.json`));
    const chTitle = (ch && ch.title) || slug.replace(/-/g, ' ');
    const seriesTitle = (series && series.title) || mangaSlug.replace(/-/g, ' ');
    title = `${chTitle} - Baca Chapter Sub Indo | micinime`;
    desc = `Baca ${chTitle} sub Indonesia gratis. Lanjut baca ${seriesTitle} di micinime, update chapter hentai manga & manhwa setiap hari.`.slice(0, 160);
    if (series && series.image) image = series.image;
  } else if (pathName === '/genres') {
    title = 'Daftar Genre Manga & Manhwa Hentai Sub Indo | micinime';
    desc = 'Jelajahi daftar genre manga dan manhwa hentai sub Indonesia di micinime. Pilih genre favorit dan baca chapter terbaru gratis.';
  } else if (pathName.startsWith('/genres/')) {
    const g = decodeURIComponent(pathName.replace(/^\/genres\//, '')).replace(/-/g, ' ');
    title = `Genre ${g} - Baca Manga Hentai Sub Indo | micinime`;
    desc = `Kumpulan manga dan manhwa hentai genre ${g} sub Indonesia. Baca gratis dan update terbaru di micinime.`;
  } else if (pathName === '/az-lists') {
    title = 'AZ Lists Manga Hentai Sub Indo | micinime';
    desc = 'Cari manga dan manhwa hentai sub Indonesia berdasarkan abjad A-Z di micinime.';
  }

  const seoBlock = `
    <title>${escapeHtmlText(title)}</title>
    <meta name="description" content="${escapeHtmlText(desc)}">
    <link rel="canonical" href="${escapeHtmlText(pageUrl.split('?')[0])}">
    <meta property="og:title" content="${escapeHtmlText(title)}">
    <meta property="og:description" content="${escapeHtmlText(desc)}">
    <meta property="og:url" content="${escapeHtmlText(pageUrl.split('?')[0])}">
    <meta property="og:image" content="${escapeHtmlText(image)}">
    <meta name="twitter:title" content="${escapeHtmlText(title)}">
    <meta name="twitter:description" content="${escapeHtmlText(desc)}">
    <meta name="twitter:image" content="${escapeHtmlText(image)}">
  `;

  // Replace default title + inject/replace key SEO tags
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

  // Ensure description exists if missing after replace fail
  if (!/name=["']description["']/.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${seoBlock}`);
  }

  return html;
}

app.get('*', (req, res) => {
  // static files still handled above; this is SPA HTML only
  try {
    const html = buildSeoHtml(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  startScrapeScheduler();
});
