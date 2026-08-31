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
} else {
  console.warn('[build] data/ not found, skipping copy');
}
