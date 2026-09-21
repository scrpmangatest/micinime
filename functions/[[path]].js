import { assetJson, json, paginate, slugFile } from './_utils.js';

const XML = (body) => new Response(body, {
  headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
});

const escapeXml = (value) => String(value || '').replace(/[<>&'\"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
const escapeHtml = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

async function catalog(context) {
  return assetJson(context, '/data/komiktap.json');
}

function sortedItems(data) {
  return [...(data.items || [])]
    .map((item, index) => ({ ...item, _index: index }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a._index - b._index)
    .map(({ _index, ...item }) => item);
}

async function detailFor(context, slug) {
  return assetJson(context, `/data/manga/${slugFile(slug)}.json`);
}

function mergeDetail(item, data) {
  if (!data) return item;
  return {
    ...item, ...data,
    image: data.image || item?.image,
    title: data.title || item?.title,
    type: data.type || item?.type,
    rating: data.rating || item?.rating,
    url: item?.url || `/manga/${item?.slug}`
  };
}

function genreSlugOf(genre) {
  const name = typeof genre === 'string' ? genre : (genre?.name || '');
  return String(name || '').toLowerCase().replace(/\s+/g, '-');
}

async function handleApi(context, segments) {
  const url = new URL(context.request.url);
  const data = await catalog(context);
  if (!data) return json({ error: 'Catalog unavailable' }, 503);

  if (segments.length === 1 && segments[0] === 'home') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const items = sortedItems(data);
    const paged = paginate(items, page, 20);
    const latest = await Promise.all(paged.items.map(async (item) => mergeDetail(item, await detailFor(context, item.slug))));
    const popularBases = (data.home?.popular?.length ? data.home.popular : items.slice(0, 15));
    const popular = await Promise.all(popularBases.map(async (item) => mergeDetail(item, await detailFor(context, item.slug))));
    return json({ popular, items: latest, latest, pagination: paged.pagination, total: items.length });
  }

  if (segments.length === 1 && segments[0] === 'popular') {
    const bases = data.home?.popular?.length ? data.home.popular : sortedItems(data).slice(0, 10);
    return json(await Promise.all(bases.map(async (item) => mergeDetail(item, await detailFor(context, item.slug)))));
  }

  if (segments.length === 1 && segments[0] === 'list') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const type = String(url.searchParams.get('type') || 'manga').toLowerCase();
    const items = (data.items || []).filter((item) => String(item.type || '').toLowerCase() === type);
    return json({ ...paginate(items, page, 20), total: items.length });
  }

  if (segments.length === 1 && segments[0] === 'genres') {
    const index = await assetJson(context, '/data/genre-index.json');
    const genres = (data.genres || []).map((genre) => ({ ...genre, count: (index && Array.isArray(index[genre.slug]) ? index[genre.slug].length : genre.count || 0) }));
    return json({ total: genres.length, totalMangaWithGenres: genres.reduce((sum, genre) => sum + genre.count, 0), genres });
  }

  if (segments.length === 2 && segments[0] === 'genres') {
    const slug = decode(segments[1]);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const genre = (data.genres || []).find((entry) => entry.slug === slug) || { name: slug, slug, count: 0 };
    const index = await assetJson(context, '/data/genre-index.json');
    let items = [];
    if (index && Array.isArray(index[slug])) {
      const set = new Set(index[slug]);
      items = sortedItems(data).filter((item) => set.has(item.slug));
    } else {
      items = sortedItems(data).filter((item) => (item.genres || []).some((entry) => genreSlugOf(entry) === slug));
    }
    return json({ genre: { ...genre, count: items.length || genre.count }, ...paginate(items, page, 20) });
  }

  if (segments.length === 2 && segments[0] === 'manga') {
    const slug = decode(segments[1]);
    const item = (data.items || []).find((entry) => entry.slug === slug);
    const found = mergeDetail(item, await detailFor(context, slug));
    return found ? json(found) : json({ error: 'Manga not found' }, 404);
  }

  if (segments.length === 2 && segments[0] === 'chapter') {
    const slug = decode(segments[1]);
    const cached = await assetJson(context, `/data/chapters/${slugFile(slug)}.json`);
    if (cached && cached.images?.length) return json(cached);
    try {
      const html = await fetch(`https://komiktap.info/${encodeURI(slug)}/`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://komiktap.info/' }, cf: { cacheTtl: 3600, cacheEverything: true } }).then((response) => response.text());
      const match = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
      if (match) {
        const reader = JSON.parse(match[1]);
        const source = reader.sources?.find((item) => item.source === reader.defaultSource) || reader.sources?.[0];
        const images = (source?.images || []).map((image) => String(image).replace(/\\\//g, '/'));
        if (images.length) return json({ slug, mangaSlug: slug.replace(/-chapter-[\d.]+(?:-end)?$/i, ''), images, imageCount: images.length, prevChapter: reader.prevUrl || null, nextChapter: reader.nextUrl || null });
      }
    } catch {}
    return cached ? json(cached) : json({ error: 'Chapter not found' }, 404);
  }

  if (segments.length === 1 && segments[0] === 'search') {
    const query = String(url.searchParams.get('s') || '').trim();
    if (!query) return json({ error: 'Query required' }, 400);
    const lower = query.toLowerCase();
    return json({ query, results: (data.items || []).filter((item) => String(item.title || '').toLowerCase().includes(lower)).slice(0, 50) });
  }

  if (segments.length === 1 && segments[0] === 'az') {
    const show = String(url.searchParams.get('show') || 'A').toUpperCase();
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const items = sortedItems(data).filter((item) => show === '#' || show === '0-9' ? /^[0-9]/.test(item.title || '') : String(item.title || '').toUpperCase().startsWith(show));
    const counts = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'].map((letter) => [letter, 0]));
    for (const item of data.items || []) {
      const letter = String(item.title || '').charAt(0).toUpperCase();
      counts[letter >= 'A' && letter <= 'Z' ? letter : '#']++;
    }
    return json({ show, counts, total: items.length, totalAll: (data.items || []).length, ...paginate(items, page, 20) });
  }

  if (segments.length === 1 && segments[0] === 'proxy') {
    const remote = url.searchParams.get('url');
    if (!remote || !/^https?:\/\//i.test(remote)) return new Response('Bad url', { status: 400 });
    const response = await fetch(remote, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://komiktap.info/' }, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!response.ok) return new Response('Image unavailable', { status: response.status });
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(response.body, { status: response.status, headers });
  }

  if (segments.length >= 1 && segments[0] === 'histats') {
    const sub = segments.slice(1).join('/');
    const base = sub.startsWith('0.gif') ? 'https://sstatic1.histats.com' : 'https://s10.histats.com';
    const remote = `${base}/${sub}${url.search}`;
    const response = await fetch(remote, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://micinime.my.id/' }, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!response.ok) return new Response('Histats unavailable', { status: response.status });
    const headers = new Headers(response.headers);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('javascript') || sub.endsWith('.js')) headers.set('Content-Type', 'application/javascript; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=3600');
    let body = await response.text();
    if (sub.endsWith('js15_as.js')) {
      body = body.replace(/s10\.histats\.com/g, 'micinime.my.id/api/histats').replace(/sstatic1\.histats\.com/g, 'micinime.my.id/api/histats');
    }
    return new Response(body, { status: 200, headers });
  }

  if (segments.length === 1 && segments[0] === 'track-read') return json({ ok: true });

  return json({ error: 'Not found' }, 404);
}

function handleApiPost(segments) {
  if (segments.length === 1 && segments[0] === 'track-read') return json({ ok: true });
  return json({ error: 'Not found' }, 404);
}

async function handleSitemap(context) {
  const data = await catalog(context);
  if (!data) return new Response('Catalog unavailable', { status: 503 });
  const now = new Date().toISOString();
  const urls = [
    `https://micinime.my.id/`,
    `https://micinime.my.id/genres`,
    `https://micinime.my.id/az-lists`,
    ...(data.genres || []).filter((genre) => genre.slug).map((genre) => `https://micinime.my.id/genres/${encodeURIComponent(genre.slug)}`),
    ...(data.items || []).filter((item) => item.slug).map((item) => `https://micinime.my.id/manga/${encodeURIComponent(decode(item.slug))}`)
  ];
  return XML(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((loc) => {
    const date = loc.includes('/manga/') ? '' : `<lastmod>${now}</lastmod>`;
    return `  <url><loc>${escapeXml(loc)}</loc>${date}<changefreq>weekly</changefreq><priority>0.6</priority></url>`;
  }).join('\n')}\n</urlset>`);
}

async function spaFallback(context) {
  const response = await context.env.ASSETS.fetch(new Request(new URL('/index.html', context.request.url)));
  let html = await response.text();
  const path = context.params.path || [];
  let title = 'micinime - Baca Manga & Manhwa Hentai Sub Indo Gratis';
  let description = 'micinime adalah situs baca manga dan manhwa hentai sub Indonesia terlengkap dengan ribuan judul dan chapter terbaru. Baca gratis tanpa daftar, update setiap hari, nyaman dibaca di HP dan PC.';
  let canonical = new URL(context.request.url).origin + '/' + (path.length ? path.join('/') : '');
  let ogImage = 'https://micinime.my.id/logo.svg';
  let content = '';
  let jsonLd = '';

  if (path[0] === 'manga' && path[1]) {
    const slug = decode(path[1]);
    const item = await catalog(context).then((data) => (data?.items || []).find((entry) => entry.slug === slug)).catch(() => null);
    const data = await detailFor(context, slug);
    const manga = mergeDetail(item, data);
    if (manga) {
      const genres = (manga.genres || []).map((g) => typeof g === 'string' ? g : g.name).filter(Boolean);
      const chapterCount = Array.isArray(manga.chapters) ? manga.chapters.length : 0;
      const synopsis = manga.synopsis || manga.description || '';
      title = `${manga.title || slug} - Baca ${manga.type || 'Manga'} Sub Indo | micinime`;
      description = `${manga.title || slug} merupakan ${manga.type || 'manga'} berbahasa Indonesia yang bisa kamu baca gratis di micinime. ${genres.length ? 'Genre: ' + genres.slice(0, 5).join(', ') + '. ' : ''}${chapterCount > 0 ? 'Tersedia ' + chapterCount + ' chapter lengkap. ' : ''}${synopsis ? synopsis.slice(0, 180).trim() : 'Baca sekarang di micinime.'}`.slice(0, 300);
      if (manga.image) ogImage = manga.image;
      content = `<main itemscope itemtype="https://schema.org/Book">`;
      content += `<h1 itemprop="name">${escapeHtml(manga.title || slug)}</h1>`;
      if (manga.image) content += `<img src="${escapeHtml(manga.image)}" alt="${escapeHtml(manga.title || slug)}" loading="lazy" itemprop="image">`;
      if (genres.length) content += `<p><strong>Genre:</strong> <span itemprop="genre">${escapeHtml(genres.join(', '))}</span></p>`;
      if (manga.type) content += `<p><strong>Tipe:</strong> ${escapeHtml(manga.type)}</p>`;
      if (manga.rating) content += `<p><strong>Rating:</strong> ${escapeHtml(String(manga.rating))}</p>`;
      if (synopsis) content += `<div itemprop="description"><strong>Sinopsis:</strong><p>${escapeHtml(synopsis)}</p></div>`;
      if (chapterCount > 0) {
        content += `<h2>Daftar Chapter (${chapterCount} chapter)</h2><ul>`;
        content += (manga.chapters || []).map((ch) => `<li><a href="${escapeHtml(ch.url || '#')}">${escapeHtml(ch.title || '')}</a></li>`).join('');
        content += '</ul>';
      }
      content += '</main>';
      jsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Book","name":${JSON.stringify(manga.title || slug)},"image":${JSON.stringify(manga.image || '')},"genre":${JSON.stringify(genres)},"numberOfChapters":${chapterCount},"description":${JSON.stringify(synopsis.slice(0, 500))},"publisher":{"@type":"Organization","name":"micinime","url":"https://micinime.my.id"}}</script>`;
    }
  } else if (path[0] === 'genres' && path[1]) {
    const genreSlug = path[1];
    const genreName = decode(genreSlug).replace(/-/g, ' ');
    const data = await catalog(context).catch(() => null);
    const index = data ? await assetJson(context, '/data/genre-index.json').catch(() => null) : null;
    const count = index && Array.isArray(index[genreSlug]) ? index[genreSlug].length : 0;
    title = `Genre ${genreName} - Baca Manga & Manhwa Sub Indo | micinime`;
    description = `Koleksi ${count > 0 ? count + ' ' : ''}manga dan manhwa genre ${genreName} sub Indonesia di micinime. Baca gratis dengan update chapter terbaru setiap hari. Lengkap dari action, romance, comedy, drama, horror, dan banyak lagi.`;
    content = `<main><h1>Genre ${escapeHtml(genreName)}</h1><p>${escapeHtml(description)}</p>`;
    if (count > 0) content += `<p>Total ${count} manga dalam genre ini.</p>`;
    content += '</main>';
  } else if (path[0] === 'az-lists') {
    title = 'Daftar Manga A-Z - Baca Manga & Manhwa Sub Indo | micinime';
    description = 'Jelajahi daftar lengkap manga dan manhwa sub Indonesia dari A sampai Z di micinime. Temukan manga favoritmu berdasarkan abjad judul, koleksi terlengkap dan gratis.';
    content = '<main><h1>Daftar Manga A-Z</h1><p>Jelajahi seluruh koleksi manga dan manhwa sub Indonesia yang tersedia di micinime secara lengkap dan gratis.</p></main>';
  } else if (path[0] === 'genres') {
    title = 'Daftar Genre Manga & Manhwa - micinime';
    description = 'Lihat semua genre manga dan manhwa yang tersedia di micinime. Pilih genre favoritmu seperti action, romance, comedy, drama, horror, slice of life, dan banyak lagi. Baca gratis sub Indonesia.';
    content = '<main><h1>Daftar Genre Manga & Manhwa</h1><p>Semua genre manga dan manhwa yang tersedia di micinime. Pilih dan baca sesuai selera kamu.</p></main>';
  }

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeXml(title)}</title>`);
  html = html.replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${escapeXml(description)}">`);
  html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${escapeXml(canonical)}">`);
  html = html.replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${escapeXml(title)}">`);
  html = html.replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${escapeXml(description)}">`);
  html = html.replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${escapeXml(canonical)}">`);
  html = html.replace(/<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${escapeXml(ogImage)}">`);
  html = html.replace(/<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${escapeXml(description)}">`);
  if (content && jsonLd) html = html.replace('<div id="content"></div>', `${jsonLd}<div id="content">${content}</div>`);
  else if (content) html = html.replace('<div id="content"></div>', `<div id="content">${content}</div>`);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(html, { status: response.status, headers });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  if (requestUrl.hostname === 'micinime.pages.dev') {
    return Response.redirect('https://micinime.my.id/', 301);
  }
  const segments = (context.params.path || []);
  if (segments.length === 1 && segments[0] === 'sitemap.xml') return handleSitemap(context);
  if (segments.length >= 1 && segments[0] === 'api') return handleApi(context, segments.slice(1));
  return spaFallback(context);
}

export async function onRequestPost(context) {
  const segments = (context.params.path || []);
  if (segments.length >= 1 && segments[0] === 'api') return handleApiPost(segments.slice(1));
  return json({ error: 'Not found' }, 404);
}
