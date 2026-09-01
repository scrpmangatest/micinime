const fs = require('fs');
const path = require('path');
const source = require('./komiktap-source');

const DATA_DIR = path.join(__dirname, 'data');
const MANGA_DIR = path.join(DATA_DIR, 'manga');
const delay = ms => new Promise(r => setTimeout(r, ms));

// Batch mode: scrape N manga per run, skip existing
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '2000', 10);

async function main() {
  if (!fs.existsSync(MANGA_DIR)) fs.mkdirSync(MANGA_DIR, { recursive: true });

  const dataFile = path.join(DATA_DIR, 'komiktap.json');
  if (!fs.existsSync(dataFile)) { console.error('komiktap.json not found'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  const STALE_MS = parseInt(process.env.STALE_MS || String(3 * 24 * 60 * 60 * 1000), 10);
  const FORCE = String(process.env.FORCE || '').toLowerCase() === 'true';
  const now = Date.now();
  const existing = new Set(fs.readdirSync(MANGA_DIR).map(f => f.replace('.json', '')));
  let todo = data.items.filter(i => !existing.has(i.slug));
  let stale = [];
  if (FORCE || STALE_MS >= 0) {
    for (const slug of existing) {
      try {
        const file = path.join(MANGA_DIR, `${slug}.json`);
        const stat = fs.statSync(file);
        const age = now - stat.mtimeMs;
        if (FORCE || age > STALE_MS) stale.push(data.items.find(x => x.slug === slug) || { slug });
        else {
          try {
            const detail = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!detail.chapters || detail.chapters.length <= 1) stale.push(data.items.find(x => x.slug === slug) || { slug });
          } catch {}
        }
      } catch {}
    }
    stale = stale.filter(Boolean);
    if (stale.length) console.log(`Stale/incomplete: ${stale.length} (age>${Math.round(STALE_MS/3600000)}h or chapters<=1)`);
    todo = [...stale, ...todo];
  }
  todo = todo.filter((item, index, array) => array.findIndex(entry => entry.slug === item.slug) === index);
  console.log(`Total: ${data.items.length}, have detail: ${existing.size}, need: ${todo.length} (new:${todo.length - stale.length} stale:${stale.length})`);

  if (todo.length === 0) {
    console.log('All manga have detail files. Nothing to do.');
    return;
  }

  const batch = todo.slice(0, BATCH_SIZE);
  console.log(`Batch: scraping ${batch.length} of ${todo.length} remaining...`);

  let done = 0, failed = 0;
  for (const item of batch) {
    try {
      const detail = await source.fetchManga(item.slug);
      if (detail && detail.title) {
        fs.writeFileSync(path.join(MANGA_DIR, `${item.slug}.json`), JSON.stringify(detail, null, 2));
        done++;
      } else {
        failed++;
        console.error(`  EMPTY: ${item.slug}`);
      }
    } catch (e) {
      failed++;
      console.error(`  FAIL: ${item.slug} - ${e.message}`);
    }
    await delay(DELAY_MS);
  }

  const stillRemaining = todo.length - batch.length;
  console.log(`Batch done: ${done} scraped, ${failed} failed, ${stillRemaining} remaining`);
  if (stillRemaining > 0) {
    console.log(`Run again to continue, or set up cron: 0 */1 * * * /home/rclffqwl/nodevenv/micinime/24/bin/node /home/rclffqwl/micinime/scrape-details.js >> /home/rclffqwl/micinime/data/scrape-details.log 2>&1`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
