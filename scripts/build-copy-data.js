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
} else {
  console.warn('[build] data/ not found, skipping copy');
}
