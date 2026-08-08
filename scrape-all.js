const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://komikhentaiku.com';
const DATA_DIR = path.join(__dirname, 'data');
const DELAY_MS = 800;

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

async function fetchPage(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { headers, timeout: 25000 });
      return res.data;
    } catch (err) {
      console.error(`  fetch fail (${i + 1}/${retries}): ${url} -> ${err.message}`);
      if (i < retries - 1) await sleep(1500 * (i + 1));
    }
  }
  return null;
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

async function getTotalPages() {
  const html = await fetchPage(`${BASE_URL}/manga/?page=1&order=title`);
  if (!html) return 1;
  const $ = cheerio.load(html);
  let max = 1;
  $('.pagination a, .page-numbers, .hpage a').each((_, el) => {
    const t = $(el).text().trim();
    const n = parseInt(t, 10);
    if (!isNaN(n) && n > max) max = n;
    const href = $(el).attr('href') || '';
    const m = href.match(/[?&]page=(\d+)/) || href.match(/\/page\/(\d+)/);
    if (m) {
      const pn = parseInt(m[1], 10);
      if (pn > max) max = pn;
    }
  });
  // also check link rel next chain hint
  return max;
}

async function scrapeMangaList() {
  const listFile = path.join(DATA_DIR, 'manga-list.json');
  let mangaMap = loadJson(listFile, {});

  const totalPages = await getTotalPages();
  console.log(`\n=== Scraping manga list (est. ${totalPages} pages) ===`);

  for (let page = 1; page <= totalPages; page++) {
    const url = `${BASE_URL}/manga/?page=${page}&order=title`;
    console.log(`[list] page ${page}/${totalPages}`);
    const html = await fetchPage(url);
    if (!html) {
      console.error(`  skip page ${page}`);
      await sleep(DELAY_MS);
      continue;
    }
    const $ = cheerio.load(html);
    let count = 0;
    $('.listupd .bs').each((_, el) => {
      const a = $(el).find('a').first();
      const href = toLocalPath(a.attr('href'));
      if (!href || !href.startsWith('/manga/')) return;
      const slug = slugFromPath(href);
      mangaMap[slug] = {
        slug,
        title: $(el).find('.tt').text().trim() || a.attr('title') || slug,
        url: href,
        image: $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || null,
        chapter: $(el).find('.epxs').text().trim() || null,
        rating: $(el).find('.numscore').text().trim() || null,
        type: $(el).find('.type').text().trim() || null
      };
      count++;
    });
    console.log(`  found ${count} items (total unique: ${Object.keys(mangaMap).length})`);
    saveJson(listFile, mangaMap);
    await sleep(DELAY_MS);

    // stop early if empty page
    if (count === 0) {
      console.log('  empty page, stopping list crawl');
      break;
    }
  }

  return mangaMap;
}

async function scrapeMangaDetail(slug) {
  const file = path.join(DATA_DIR, 'manga', `${slug}.json`);
  if (fs.existsSync(file)) {
    return loadJson(file, null);
  }

  const html = await fetchPage(`${BASE_URL}/manga/${slug}/`);
  if (!html) return null;
  const $ = cheerio.load(html);

  const manga = {
    slug,
    title: $('.main-info h1.entry-title').first().text().trim(),
    image: $('.main-info .thumb img').attr('src') || $('.main-info .thumb img').attr('data-src') || null,
    rating: $('.rating-prc .num, .numscore').first().text().trim() || null,
    description: $('.entry-content p').first().text().trim() || null,
    status: $('.imptdt:contains("Status") i').first().text().trim() || null,
    type: $('.imptdt:contains("Type") a').first().text().trim() || null,
    genres: [],
    chapters: [],
    scrapedAt: new Date().toISOString()
  };

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
      manga.genres.push({ name, url: toLocalPath(href) });
    });
    if (manga.genres.length > 0 && sel !== 'a[rel="tag"]') break;
  }
  const withPath = manga.genres.filter(g => g.url && String(g.url).includes('/genres/'));
  if (withPath.length > 0) manga.genres = withPath;

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

  saveJson(file, manga);
  return manga;
}

async function scrapeChapter(chapterSlug) {
  const file = path.join(DATA_DIR, 'chapters', `${chapterSlug}.json`);
  if (fs.existsSync(file)) {
    return loadJson(file, null);
  }

  const html = await fetchPage(`${BASE_URL}/${chapterSlug}/`);
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
      if (Array.isArray(readerData.sources) && readerData.sources.length > 0) {
        const source = readerData.sources.find(s => s.source === readerData.defaultSource)
          || readerData.sources[0];
        if (source && Array.isArray(source.images)) {
          images = source.images
            .map(img => String(img).replace(/\\\//g, '/'))
            .filter(img => img && !img.includes('readerarea.svg'));
        }
      }
    } catch (e) {
      console.error(`  ts_reader parse fail ${chapterSlug}:`, e.message);
    }
  }

  if (images.length === 0 && readerMatch) {
    const imgRe = /https?:\\\/\\\/[^"\\]+?\.(?:jpg|jpeg|png|gif|webp)/gi;
    let m;
    while ((m = imgRe.exec(readerMatch[1])) !== null) {
      images.push(m[0].replace(/\\\//g, '/'));
    }
  }

  const seen = new Set();
  images = images.filter(img => {
    if (seen.has(img)) return false;
    seen.add(img);
    return true;
  });

  // ONE chapter file only — never merge multiple chapters
  const chapter = {
    slug: chapterSlug,
    title: $('h1.entry-title').first().text().trim(),
    prevChapter,
    nextChapter,
    images,
    imageCount: images.length,
    scrapedAt: new Date().toISOString()
  };

  // Save as separate file: data/chapters/{slug}.json
  saveJson(file, chapter);
  return chapter;
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, 'manga'))) fs.mkdirSync(path.join(DATA_DIR, 'manga'), { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, 'chapters'))) fs.mkdirSync(path.join(DATA_DIR, 'chapters'), { recursive: true });

  const progressFile = path.join(DATA_DIR, 'progress.json');
  let progress = loadJson(progressFile, {
    listDone: false,
    mangaDone: {},
    chaptersDone: {},
    startedAt: new Date().toISOString()
  });

  // 1) All manga list
  let mangaMap;
  if (progress.listDone && fs.existsSync(path.join(DATA_DIR, 'manga-list.json'))) {
    mangaMap = loadJson(path.join(DATA_DIR, 'manga-list.json'), {});
    console.log(`Resume: manga list already done (${Object.keys(mangaMap).length} titles)`);
  } else {
    mangaMap = await scrapeMangaList();
    progress.listDone = true;
    saveJson(progressFile, progress);
  }

  const slugs = Object.keys(mangaMap);
  console.log(`\n=== Scraping ${slugs.length} manga details + chapters ===`);

  let mangaOk = 0;
  let chapterOk = 0;
  let chapterFail = 0;

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    console.log(`\n[${i + 1}/${slugs.length}] ${slug}`);

    let detail = null;
    if (progress.mangaDone[slug]) {
      detail = loadJson(path.join(DATA_DIR, 'manga', `${slug}.json`), null);
      console.log(`  detail cached`);
    } else {
      detail = await scrapeMangaDetail(slug);
      if (detail) {
        progress.mangaDone[slug] = true;
        mangaOk++;
        console.log(`  detail: ${detail.title} | ${detail.chapters.length} chapters`);
      } else {
        console.log(`  detail FAILED`);
      }
      saveJson(progressFile, progress);
      await sleep(DELAY_MS);
    }

    if (!detail || !detail.chapters) continue;

    for (let c = 0; c < detail.chapters.length; c++) {
      const ch = detail.chapters[c];
      const chSlug = ch.slug || slugFromPath(ch.url);
      if (!chSlug) continue;

      if (progress.chaptersDone[chSlug]) {
        chapterOk++;
        continue;
      }

      process.stdout.write(`  chapter ${c + 1}/${detail.chapters.length}: ${chSlug} ... `);
      const chapter = await scrapeChapter(chSlug);
      if (chapter && chapter.imageCount > 0) {
        progress.chaptersDone[chSlug] = true;
        chapterOk++;
        console.log(`${chapter.imageCount} images`);
      } else if (chapter) {
        progress.chaptersDone[chSlug] = true;
        chapterOk++;
        console.log(`0 images (saved)`);
      } else {
        chapterFail++;
        console.log('FAILED');
      }
      saveJson(progressFile, progress);
      await sleep(DELAY_MS);
    }
  }

  // Build index
  const index = {
    scrapedAt: new Date().toISOString(),
    mangaCount: Object.keys(mangaMap).length,
    mangaDetailCount: Object.keys(progress.mangaDone).length,
    chapterCount: Object.keys(progress.chaptersDone).length,
    manga: Object.values(mangaMap)
  };
  saveJson(path.join(DATA_DIR, 'index.json'), index);

  console.log('\n========== DONE ==========');
  console.log(`Manga list   : ${index.mangaCount}`);
  console.log(`Manga detail : ${index.mangaDetailCount}`);
  console.log(`Chapters     : ${index.chapterCount}`);
  console.log(`Chapter fail : ${chapterFail}`);
  console.log(`Data folder  : ${DATA_DIR}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
