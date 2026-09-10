// Copies data/ into public/data/ so Cloudflare Pages serves JSON as static assets.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'data');
const dst = path.join(root, 'public', 'data');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

if (fs.existsSync(src)) {
  fs.rmSync(dst, { recursive: true, force: true });
  copyDir(src, dst);
  console.log(`[build] copied ${src} -> ${dst}`);
  try {
    const mangaDir = path.join(dst, 'manga');
    const map = {};
    if (fs.existsSync(mangaDir)) {
      for (const file of fs.readdirSync(mangaDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const detail = JSON.parse(fs.readFileSync(path.join(mangaDir, file), 'utf8'));
          const slug = detail.slug || file.replace(/\.json$/, '');
          for (const genre of detail.genres || []) {
            const name = typeof genre === 'string' ? genre : genre.name;
            const gslug = String(name || '').toLowerCase().replace(/\s+/g, '-');
            if (!gslug) continue;
            if (!map[gslug]) map[gslug] = [];
            map[gslug].push(slug);
          }
        } catch {}
      }
    }
    fs.writeFileSync(path.join(dst, 'genre-index.json'), JSON.stringify(map));
    console.log(`[build] genre-index: ${Object.keys(map).length} genres`);
  } catch (error) {
    console.warn('[build] genre-index failed:', error.message);
  }
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(dst, 'komiktap.json'), 'utf8'));
    const now = new Date().toISOString();
    const esc = (value) => String(value || '').replace(/[<>&']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;' })[c]);
    const urls = [
      { loc: 'https://micinime.my.id/', lastmod: now, freq: 'daily', pri: '1.0' },
      { loc: 'https://micinime.my.id/genres', lastmod: now, freq: 'weekly', pri: '0.8' },
      { loc: 'https://micinime.my.id/az-lists', lastmod: now, freq: 'weekly', pri: '0.8' },
      ...(catalog.genres || []).filter((g) => g.slug).map((g) => ({ loc: `https://micinime.my.id/genres/${encodeURIComponent(g.slug)}`, lastmod: now, freq: 'weekly', pri: '0.7' })),
      ...(catalog.items || []).filter((i) => i.slug).map((i) => ({ loc: `https://micinime.my.id/manga/${encodeURIComponent(i.slug)}`, lastmod: i.updatedAt ? new Date(i.updatedAt).toISOString() : now, freq: 'weekly', pri: '0.6' }))
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}\n</urlset>\n`;
    fs.writeFileSync(path.join(root, 'public', 'sitemap.xml'), xml);
    console.log(`[build] sitemap.xml: ${urls.length} URLs`);
  } catch (error) {
    console.warn('[build] sitemap failed:', error.message);
  }
} else {
  console.warn('[build] data/ not found, skipping copy');
}
