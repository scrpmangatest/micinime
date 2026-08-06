const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://komikhentaiku.com';
const DATA_DIR = path.join(__dirname, 'data');
const DELAY_MS = 700;

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function toLocalPath(href) {
  if (!href) return null;
  try {
    if (href.startsWith('http')) {
      const u = new URL(href);
      href = u.pathname + u.search;
    }
  } catch (_) {
    href = href.replace(/^https?:\/\/[^/]+/i, '');
  }
  if (!href.startsWith('/')) href = '/' + href;
  return href.replace(/\/+$/, '') || '/';
}

function extractGenres($) {
  const genres = [];
  const seen = new Set();

  // Multiple selectors used by mangareader theme
  const selectors = [
    '.wd-full .mgen a',
    '.mgen a',
    '.seriestugenre a',
    'span.mgen a',
    '.info-desc .mgen a',
    'a[rel="tag"]',
    '.genre-info a'
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (!name) return;
      // skip non-genre tags
      if (href.includes('/author/') || href.includes('/artist/') || href.includes('/status/')) return;
      if (href && !href.includes('/genres/') && !href.includes('/genre/') && !href.includes('/tag') && sel.includes('rel="tag"')) {
        // keep rel=tag only if looks genre-like or has genres path
      }
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      genres.push({
        name,
        url: toLocalPath(href)
      });
    });
    if (genres.length > 0 && sel !== 'a[rel="tag"]') break;
  }

  // Prefer genres with /genres/ path if we got mixed tags
  const withPath = genres.filter(g => g.url && (g.url.includes('/genres/') || g.url.includes('/genre/')));
  return withPath.length > 0 ? withPath : genres;
}

async function fetchPage(url) {
  try {
    const res = await axios.get(url, { headers, timeout: 25000 });
    return res.data;
  } catch (e) {
    console.error('fetch fail', url, e.message);
    return null;
  }
}

async function main() {
  const onlyEmpty = !process.argv.includes('--all');
  const mangaDir = path.join(DATA_DIR, 'manga');
  if (!fs.existsSync(mangaDir)) {
    console.log('No manga dir');
    return;
  }

  const files = fs.readdirSync(mangaDir).filter(f => f.endsWith('.json'));
  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = path.join(mangaDir, files[i]);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      failed++;
      continue;
    }

    const hasGenres = Array.isArray(data.genres) && data.genres.length > 0;
    if (onlyEmpty && hasGenres) {
      skipped++;
      continue;
    }

    const slug = data.slug || files[i].replace(/\.json$/, '');
    process.stdout.write(`[${i + 1}/${files.length}] ${slug} ... `);

    const html = await fetchPage(`${BASE_URL}/manga/${slug}/`);
    if (!html) {
      console.log('FAIL fetch');
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    const $ = cheerio.load(html);
    const genres = extractGenres($);

    // also refresh description/status/type if empty
    if (!data.description) {
      data.description = $('.entry-content p').first().text().trim() || data.description;
    }
    if (!data.status) {
      data.status = $('.imptdt:contains("Status") i').first().text().trim() || data.status;
    }
    if (!data.type) {
      data.type = $('.imptdt:contains("Type") a').first().text().trim() || data.type;
    }
    if (!data.rating) {
      data.rating = $('.rating-prc .num, .numscore').first().text().trim() || data.rating;
    }

    data.genres = genres;
    data.genresFixedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

    console.log(genres.length ? `${genres.length} genres` : '0 genres');
    if (genres.length) fixed++;
    else failed++;

    await sleep(DELAY_MS);
  }

  console.log('\nDone.');
  console.log('Fixed/updated:', fixed);
  console.log('Skipped (already had genres):', skipped);
  console.log('Empty/fail:', failed);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
