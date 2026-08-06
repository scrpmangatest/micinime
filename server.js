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

app.get('/api/home', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const perPage = 36;

    // Page 1: popular from homepage + latest page 1
    // Page 2+: only latest from site list order=update
    let popularItems = [];

    if (page === 1) {
      const homeHtml = await fetchPage(BASE_URL);
      if (homeHtml) {
        const $h = cheerio.load(homeHtml);
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
    }

    // Latest update: scrape update-ordered list pages until we fill 36 items
    // Site typically shows ~12-20 per page; collect from consecutive pages
    const latestItems = [];
    let sourcePage = page;
    let hasMore = true;
    let guard = 0;

    // Map our "home latest page" to source pages:
    // each of our pages needs 36 items; source pages often have ~12 items
    // So for page N we start around source page ((N-1)*3 + 1) approx, but better: fetch sequentially
    const startSource = (page - 1) * 3 + 1;
    sourcePage = startSource;

    while (latestItems.length < perPage && guard < 6) {
      guard++;
      const listUrl = `${BASE_URL}/manga/?page=${sourcePage}&order=update`;
      const html = await fetchPage(listUrl);
      if (!html) {
        hasMore = false;
        break;
      }
      const $ = cheerio.load(html);
      let found = 0;
      $('.listupd .bs').each((_, el) => {
        if (latestItems.length >= perPage) return;
        latestItems.push({
          title: $(el).find('.tt').text().trim(),
          url: toLocalPath($(el).find('a').first().attr('href')),
          image: $(el).find('img').attr('src'),
          chapter: $(el).find('.epxs').text().trim(),
          time: $(el).find('.epxdate').text().trim(),
          rating: $(el).find('.numscore').text().trim(),
          type: $(el).find('.type').text().trim()
        });
        found++;
      });

      if (found === 0) {
        hasMore = false;
        break;
      }

      // check if next source page exists
      const nextLink = $('.pagination .next, .hpage a, a.next, a.page-numbers.next').attr('href')
        || ($('.page-numbers').filter((_, e) => $(e).text().trim().toLowerCase().includes('next')).attr('href'));
      if (!nextLink && found < 10) {
        // likely last pages
      }
      sourcePage++;
    }

    // Estimate total pages from site pagination if available
    let totalPages = page + (latestItems.length >= perPage ? 1 : 0);
    try {
      const probe = await fetchPage(`${BASE_URL}/manga/?page=1&order=update`);
      if (probe) {
        const $p = cheerio.load(probe);
        let max = 1;
        $p('.pagination a, .page-numbers, .hpage a').each((_, el) => {
          const t = $p(el).text().trim();
          const n = parseInt(t, 10);
          if (!isNaN(n) && n > max) max = n;
          const href = $p(el).attr('href') || '';
          const m = href.match(/[?&]page=(\d+)/) || href.match(/\/page\/(\d+)/);
          if (m) {
            const pn = parseInt(m[1], 10);
            if (pn > max) max = pn;
          }
        });
        // site pages * ~12 items / 36 ≈ total home pages
        totalPages = Math.max(page, Math.ceil((max * 12) / perPage));
      }
    } catch (_) {}

    res.json({
      popular: popularItems,
      latest: latestItems,
      pagination: {
        currentPage: page,
        perPage,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages && latestItems.length > 0
      }
    });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
