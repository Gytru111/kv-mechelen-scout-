const fs = require('fs');
const path = require('path');

const TM_BASE = 'https://www.transfermarkt.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DELAY_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

function parseSearchResults(html) {
  const linkRe = /href="(\/[^"]*\/profil\/spieler\/(\d+))"/g;
  const match = linkRe.exec(html);
  if (!match) return null;
  return { path: match[1], id: match[2] };
}

function parseProfile(html) {
  const result = {};
  
  const contractRe = /Contract expires:\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i;
  const cm = html.match(contractRe);
  if (cm) result.contract = cm[1].trim();
  
  const mvRe = /<td class="rechts hauptlink">\s*([^<]+)<\/td>/;
  const mv = html.match(mvRe);
  if (mv) result.marketValue = mv[1].trim();
  
  const clubRe = /Current club:\s*<\/span>\s*<span[^>]*>\s*(?:<[^>]*>)*\s*<a[^>]*>([^<]+)<\/a>/is;
  const cl = html.match(clubRe);
  if (cl) result.club = cl[1].trim();
  
  const footRe = /Foot:\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i;
  const ft = html.match(footRe);
  if (ft) result.foot = ft[1].trim();
  
  const mvAltRe = /Current market value:\s*<[^>]*>([^<€]+)/i;
  const mva = html.match(mvAltRe);
  if (mva && !result.marketValue) result.marketValue = mva[1].trim();
  
  return result;
}

async function scrapePlayer(name) {
  const query = encodeURIComponent(name);
  const searchUrl = `${TM_BASE}/schnellsuche/ergebnis/schnellsuche?query=${query}`;
  
  try {
    const html = await fetchPage(searchUrl);
    const profile = parseSearchResults(html);
    if (!profile) {
      console.log(`  [SKIP] No search result for "${name}"`);
      return null;
    }
    
    await sleep(DELAY_MS);
    
    const profileUrl = `${TM_BASE}${profile.path}`;
    const profileHtml = await fetchPage(profileUrl);
    const data = parseProfile(profileHtml);
    data.tmId = profile.id;
    data.tmUrl = profileUrl;
    
    console.log(`  [OK] ${name} → contract: ${data.contract || '?'}, MV: ${data.marketValue || '?'}`);
    return data;
  } catch (e) {
    console.log(`  [ERR] ${name}: ${e.message}`);
    return null;
  }
}

async function main() {
  const playersPath = path.join(__dirname, '..', 'players.json');
  const players = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  
  console.log(`Scraping Transfermarkt for ${players.length} players...`);
  
  const tmData = {};
  const now = new Date().toISOString();
  
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    console.log(`[${i + 1}/${players.length}] ${p.name}`);
    
    const data = await scrapePlayer(p.name);
    if (data) {
      tmData[p.id] = data;
    }
    
    if (i < players.length - 1) await sleep(DELAY_MS);
  }
  
  const output = {
    lastUpdated: now,
    players: tmData
  };
  
  const outPath = path.join(__dirname, '..', 'tm-data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nDone! Saved ${Object.keys(tmData).length} player profiles to tm-data.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
