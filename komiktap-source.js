const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://komiktap.info';
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8'
};

async function fetchHtml(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.get(url, { headers, timeout: 30000 });
      return data;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function localPath(href) {
  if (!href || href.startsWith('#')) return null;
  try {
    const url = new URL(href, BASE_URL);
    return `${url.pathname}${url.search}`.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

function slugFromPath(href) {
  const path = localPath(href) || href || '';
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/^manga\//, '');
}

function numberFromChapter(value) {
  const match = String(value || '').match(/chapter\s*([0-9]+(?:\.[0-9]+)?)/i)
    || String(value || '').match(/-chapter-([0-9]+(?:\.[0-9]+)?)/i);
  return match ? Number(match[1]) : null;
}

function cardFromElement($, el, type) {
  const card = $(el);
  const link = card.find('.bsx > a, a').first();
  const href = localPath(link.attr('href'));
  if (!href || !href.startsWith('/manga/')) return null;
  return {
    slug: slugFromPath(href),
    title: card.find('.tt').first().text().trim() || link.attr('title') || '',
    url: href,
    image: card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || null,
    chapter: card.find('.epxs').first().text().trim() || 'Chapter 1',
    rating: card.find('.numscore').first().text().trim() || '7.00',
    type: type[0].toUpperCase() + type.slice(1)
  };
}

function parseCards(html, type) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];
  $('.listupd .bs').each((_, el) => {
    const item = cardFromElement($, el, type);
    if (!item || !item.title || seen.has(item.slug)) return;
    seen.add(item.slug);
    items.push(item);
  });
  return { $, items };
}

function listUrl(type, page = 1) {
  const base = type === 'manhwa' ? '/list-manhwa/' : type === 'manhua' ? '/list-manhua/' : '/list-manga/';
  return `${BASE_URL}${base}${page > 1 ? `page/${page}/` : ''}`;
}

async function fetchList(type = 'manga', page = 1) {
  const normalized = ['manga', 'manhwa', 'manhua'].includes(type) ? type : 'manga';
  const html = await fetchHtml(listUrl(normalized, page));
  const { $, items } = parseCards(html, normalized);
  let totalPages = page;
  $('.pagination a, .page-numbers').each((_, el) => {
    const number = Number($(el).text().trim());
    if (Number.isFinite(number)) totalPages = Math.max(totalPages, number);
    const match = String($(el).attr('href') || '').match(/\/page\/(\d+)/);
    if (match) totalPages = Math.max(totalPages, Number(match[1]));
  });
  return { items, pagination: { currentPage: page, totalPages, hasPrev: page > 1, hasNext: page < totalPages } };
}

async function fetchHome() {
  const html = await fetchHtml(`${BASE_URL}/`);
  const $ = cheerio.load(html);
  const popular = [];
  $('.hotslid .popularslider .bs, .hotslid .bs').each((_, el) => {
    const item = cardFromElement($, el, 'manhwa');
    if (item && !popular.some(existing => existing.slug === item.slug)) popular.push(item);
  });

  const latest = [];
  $('.listupd .utao .uta').each((_, el) => {
    const card = $(el);
    const link = card.find('a').first();
    const href = localPath(link.attr('href'));
    if (!href || !href.startsWith('/manga/')) return;
    const slug = slugFromPath(href);
    const title = card.find('.luf a, h2, h3').first().text().trim() || link.attr('title') || slug;
    latest.push({
      slug,
      title,
      url: href,
      image: card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || null,
      chapter: card.find('.luf li a, .chapter').first().text().trim() || 'Chapter 1',
      rating: card.find('.numscore').first().text().trim() || '7.00',
      type: card.find('.type').first().text().trim() || 'Manhwa',
      time: card.find('.epxdate, .date').first().text().trim() || null
    });
  });

  if (!latest.length) latest.push(...parseCards(html, 'manhwa').items);
  return { popular: popular.slice(0, 15), latest: latest.slice(0, 36) };
}

function parseInfoTable($) {
  const info = {};
  $('.infotable tr, .infotable .fmed, .infotable .imptdt').each((_, el) => {
    const row = $(el);
    const key = row.find('td, b, strong, span').first().text().replace(/\s+/g, ' ').trim().replace(/:$/, '');
    const text = row.text().replace(/\s+/g, ' ').trim();
    if (/status/i.test(key || text)) info.status = text.replace(/status:?/i, '').trim();
    if (/type/i.test(key || text)) info.type = text.replace(/type:?/i, '').trim();
  });
  return info;
}

async function fetchManga(slug) {
  const html = await fetchHtml(`${BASE_URL}/manga/${encodeURI(slug)}/`);
  const $ = cheerio.load(html);
  const table = parseInfoTable($);
  const genres = [];
  const seenGenres = new Set();
  $('.seriestugenre a[href*="/genres/"], .mgen a[href*="/genres/"]').each((_, el) => {
    const name = $(el).text().trim();
    if (!name || /^genres$/i.test(name) || seenGenres.has(name.toLowerCase())) return;
    seenGenres.add(name.toLowerCase());
    genres.push({ name, url: localPath($(el).attr('href')) });
  });
  const chapters = [];
  $('.eplister li, #chapterlist li').each((_, el) => {
    const link = $(el).find('.eph-num a, a').first();
    const href = localPath(link.attr('href'));
    if (!href) return;
    const title = $(el).find('.chapternum').first().text().trim() || link.text().replace(/\s+/g, ' ').trim();
    chapters.push({
      slug: slugFromPath(href),
      title,
      url: href,
      number: numberFromChapter(title),
      date: $(el).find('.chapterdate').first().text().trim() || null
    });
  });
  const typeGenre = genres.find(genre => /^(manga|manhwa|manhua)$/i.test(genre.name));
  return {
    slug,
    title: $('h1.entry-title').first().text().trim(),
    image: $('.thumb img.wp-post-image, .info-left .thumb img, .main-info .thumb img').first().attr('src') || $('.thumb img.wp-post-image, .info-left .thumb img, .main-info .thumb img').first().attr('data-src') || null,
    rating: $('.rating-prc .num, .numscore').first().text().trim() || '7.00',
    description: $('.entry-content-single p, .entry-content p').first().text().replace(/\s+/g, ' ').trim(),
    status: table.status || 'Ongoing',
    type: table.type || typeGenre?.name || 'Manga',
    genres,
    chapters
  };
}

async function fetchChapter(slug) {
  const html = await fetchHtml(`${BASE_URL}/${encodeURI(slug)}/`);
  const $ = cheerio.load(html);
  let images = [];
  let prevChapter = null;
  let nextChapter = null;
  let hasReaderNavigation = false;
  const match = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
  if (match) {
    const reader = JSON.parse(match[1]);
    hasReaderNavigation = true;
    const source = reader.sources?.find(item => item.source === reader.defaultSource) || reader.sources?.[0];
    images = (source?.images || []).map(image => String(image).replace(/\\\//g, '/'));
    prevChapter = localPath(reader.prevUrl);
    nextChapter = localPath(reader.nextUrl);
  }
  const seriesUrl = localPath($('.allc a, .backseries a').first().attr('href'));
  const mangaSlug = seriesUrl ? slugFromPath(seriesUrl) : slug.replace(/-chapter-[\d.]+(?:-end)?$/i, '');
  let manga = null;
  try { manga = await fetchManga(mangaSlug); } catch {}
  const chapters = manga?.chapters || [];
  const currentIndex = chapters.findIndex(chapter => chapter.slug === slug);
  // Komiktap already supplies authoritative prev/next values in ts_reader.
  // Only infer navigation when a reader block is unavailable.
  if (!hasReaderNavigation && currentIndex >= 0) {
    const currentNumber = chapters[currentIndex].number;
    const lower = chapters
      .filter(chapter => chapter.number != null && chapter.number < currentNumber)
      .sort((a, b) => b.number - a.number)[0];
    const higher = chapters
      .filter(chapter => chapter.number != null && chapter.number > currentNumber)
      .sort((a, b) => a.number - b.number)[0];
    prevChapter = lower?.url || null;
    nextChapter = higher?.url || null;
  }
  return {
    slug,
    mangaSlug,
    title: $('h1.entry-title').first().text().trim(),
    seriesTitle: manga?.title || $('.allc a').first().text().trim(),
    seriesUrl: seriesUrl || `/manga/${mangaSlug}`,
    chapterNumber: numberFromChapter(slug),
    prevChapter,
    nextChapter,
    chapters,
    images,
    imageCount: images.length
  };
}

async function fetchGenres() {
  const html = await fetchHtml(`${BASE_URL}/genres/`);
  const $ = cheerio.load(html);
  const genres = [];
  const seen = new Set();
  $('a[href*="/genres/"]').each((_, el) => {
    const name = $(el).text().trim().replace(/\s*\d+$/, '');
    const href = localPath($(el).attr('href'));
    if (!href || !/^\/genres\/[a-z]/.test(href) || !name || name.length <= 1) return;
    const slug = href.replace('/genres/', '');
    if (seen.has(slug)) return;
    seen.add(slug);
    genres.push({ name, slug, url: href });
  });
  return genres;
}

async function fetchGenreDetail(slug, page = 1) {
  const url = page > 1 ? `${BASE_URL}/genres/${slug}/page/${page}/` : `${BASE_URL}/genres/${slug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const { items } = parseCards(html, 'manga');
  let totalPages = page;
  $('.pagination a, .page-numbers').each((_, el) => {
    const number = Number($(el).text().trim());
    if (Number.isFinite(number)) totalPages = Math.max(totalPages, number);
    const match = String($(el).attr('href') || '').match(/\/page\/(\d+)/);
    if (match) totalPages = Math.max(totalPages, Number(match[1]));
  });
  return { genre: slug, items, pagination: { currentPage: page, totalPages, hasPrev: page > 1, hasNext: page < totalPages } };
}

async function fetchAzLetters() {
  const html = await fetchHtml(`${BASE_URL}/a-z-list/`);
  const $ = cheerio.load(html);
  const letters = [];
  $('a[href*="a-z-list"]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (text.length === 1 && /[A-Z0-9#]/.test(text)) {
      const show = text === '#' ? '.' : text;
      const letter = text;
      if (!letters.some(l => l.letter === letter)) letters.push({ letter, show, url: href });
    }
  });
  return letters;
}

async function fetchAzList(show = 'A', page = 1) {
  const url = page > 1 ? `${BASE_URL}/a-z-list/page/${page}/?show=${show}` : `${BASE_URL}/a-z-list/?show=${show}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  $('.bs').each((_, el) => {
    const card = $(el);
    const link = card.find('.bsx > a, a').first();
    const href = localPath(link.attr('href'));
    if (!href || !href.startsWith('/manga/')) return;
    const slug = slugFromPath(href);
    if (seen.has(slug)) return;
    seen.add(slug);
    items.push({
      slug,
      title: card.find('.tt').first().text().trim() || link.attr('title') || '',
      url: href,
      image: card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || null,
      chapter: card.find('.epxs').first().text().trim() || 'Chapter 1',
      rating: card.find('.numscore').first().text().trim() || '7.00',
      type: card.find('.type').first().text().trim() || 'Manga'
    });
  });
  let totalPages = page;
  $('.pagination a, .page-numbers').each((_, el) => {
    const number = Number($(el).text().trim());
    if (Number.isFinite(number)) totalPages = Math.max(totalPages, number);
    const match = String($(el).attr('href') || '').match(/\/page\/(\d+)/);
    if (match) totalPages = Math.max(totalPages, Number(match[1]));
  });
  return { letter: show, items, pagination: { currentPage: page, totalPages, hasPrev: page > 1, hasNext: page < totalPages } };
}

module.exports = { BASE_URL, fetchHtml, fetchHome, fetchList, fetchManga, fetchChapter, fetchGenres, fetchGenreDetail, fetchAzLetters, fetchAzList, localPath, slugFromPath };
