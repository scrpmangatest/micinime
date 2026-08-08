const fs = require('fs');
const path = require('path');
const source = require('./komiktap-source');

const DATA_DIR = path.join(__dirname, 'data');
const MANGA_DIR = path.join(DATA_DIR, 'manga');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(MANGA_DIR)) fs.mkdirSync(MANGA_DIR, { recursive: true });

  const dataFile = path.join(DATA_DIR, 'komiktap.json');
  if (!fs.existsSync(dataFile)) { console.error('komiktap.json not found'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  const existing = new Set(fs.readdirSync(MANGA_DIR).map(f => f.replace('.json', '')));
  const todo = data.items.filter(i => !existing.has(i.slug));
  console.log(`Total: ${data.items.length}, have detail: ${existing.size}, need: ${todo.length}`);

  let done = 0, failed = 0;
  for (const item of todo) {
    try {
      const detail = await source.fetchManga(item.slug);
      fs.writeFileSync(path.join(MANGA_DIR, `${item.slug}.json`), JSON.stringify(detail, null, 2));
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${todo.length} done, ${failed} failed`);
    } catch (e) {
      failed++;
      console.error(`  FAIL: ${item.slug} - ${e.message}`);
    }
    await delay(500);
  }
  console.log(`Done: ${done} scraped, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
