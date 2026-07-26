import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYERS_PATH = join(__dirname, 'players.json');
const DRY_RUN = process.argv.includes('--dry-run');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9'
};

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
];

const FOOT_MAP = { 'right': 'Droit', 'left': 'Gauche', 'both': 'Les deux' };

function parseTMProfile(html) {
  const r = {};

  const clubM = html.match(/Current club:[\s\S]*?startseite\/verein\/\d+"[^>]*>[\s\S]*?alt="([^"]+)"/i);
  if (clubM) r.club = clubM[1];

  const loanM = html.match(/On loan from ([^"]+?) until ([\d\/]+)/i);
  if (loanM) { r.loanFrom = loanM[1]; r.loanUntil = loanM[2]; }

  const heightM = html.match(/itemprop="height"[^>]*>\s*([\d,]+\s*m)/i);
  if (heightM) {
    const meters = parseFloat(heightM[1].replace(',', '.'));
    r.height = `${Math.round(meters * 100)} cm`;
  }

  const footM = html.match(/Foot:[\s\S]*?info-table__content--bold[^>]*>([\w]+)/i);
  if (footM) r.foot = footM[1].trim().toLowerCase();

  const contractM = html.match(/Contract expires:[\s\S]*?data-header__content[^>]*>([\d\/]+)/i);
  if (contractM) r.contractUntil = contractM[1];

  const mvMeta = html.match(/Market value:\s*(€[\d.,]+)([mk]?)/i);
  if (mvMeta) {
    const num = parseFloat(mvMeta[1].replace('€', '').replace(',', ''));
    const mult = mvMeta[2].toLowerCase() === 'm' ? 1e6 : mvMeta[2].toLowerCase() === 'k' ? 1e3 : 1;
    r.marketValue = Math.round(num * mult);
  }

  return r;
}

function tmDateToFrench(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const month = parseInt(parts[1]) - 1;
  const year = parts[2];
  return `${MONTHS_FR[month]} ${year}`;
}

function formatValue(v) {
  if (!v) return '0 €';
  return v.toLocaleString('fr-FR') + ' €';
}

function calcAgeFromDob(dobStr) {
  if (!dobStr) return null;
  const parts = dobStr.split('/');
  if (parts.length !== 3) return null;
  const dob = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

async function fetchHTML(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function updatePlayer(player) {
  const tmId = player.tmId;
  if (!tmId) {
    console.log(`  ⚠ Pas d'ID Transfermarkt — ignoré`);
    return null;
  }

  const html = await fetchHTML(`https://www.transfermarkt.com/x/profil/spieler/${tmId}`);
  const data = parseTMProfile(html);

  const changes = {};
  const p = { ...player };

  if (data.loanFrom) {
    const loanClub = `${data.club} (prêt ${data.loanFrom})`;
    if (loanClub !== player.club) {
      p.club = loanClub;
      changes.club = { old: player.club, new: loanClub };
    }
  }

  if (data.height) {
    if (data.height !== player.height) { p.height = data.height; changes.height = { old: player.height, new: data.height }; }
  }

  if (data.foot) {
    const f = FOOT_MAP[data.foot] || data.foot;
    if (f !== player.foot) { p.foot = f; changes.foot = { old: player.foot, new: f }; }
  }

  if (data.marketValue && data.marketValue !== player.valNum) {
    p.valNum = data.marketValue;
    p.val = formatValue(data.marketValue);
    changes.val = { old: player.val, new: p.val };
  }

  if (data.contractUntil) {
    const c = tmDateToFrench(data.contractUntil);
    if (c && c !== player.contract) { p.contract = c; changes.contract = { old: player.contract, new: c }; }
  }

  if (data.loanUntil) {
    const loanEnd = tmDateToFrench(data.loanUntil);
    if (loanEnd) {
      const careerEntry = p.career?.find(e => e.type === 'loan' && e.club === data.loanFrom);
      if (careerEntry && careerEntry.period && !careerEntry.period.includes('-')) {
        // already has end date, skip
      }
    }
  }

  if (Object.keys(changes).length === 0) {
    console.log(`  ✓ déjà à jour`);
    return null;
  }

  console.log(`  ✏ changements:`);
  for (const [field, { old: o, new: n }] of Object.entries(changes)) {
    console.log(`    ${field}: ${JSON.stringify(o)} → ${JSON.stringify(n)}`);
  }

  return { player: p, changes };
}

async function main() {
  console.log(DRY_RUN ? '🔍 Mode dry-run\n' : '');

  let players;
  try {
    let raw = await readFile(PLAYERS_PATH, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    players = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ ${PLAYERS_PATH}: ${e.message}`);
    process.exit(1);
  }

  console.log(`${players.length} joueurs\n`);
  let updated = 0, errors = 0;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    console.log(`[${i + 1}/${players.length}] ${p.name}`);
    try {
      const result = await updatePlayer(p);
      if (result) { players[i] = result.player; updated++; }
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
      errors++;
    }
    if (i < players.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n── Résumé ──`);
  console.log(`Mis à jour: ${updated} | À jour: ${players.length - updated - errors} | Erreurs: ${errors}`);

  if (!DRY_RUN && updated > 0) {
    await writeFile(PLAYERS_PATH, JSON.stringify(players, null, 2) + '\n', 'utf-8');
    console.log(`✅ players.json sauvegardé`);
  } else if (DRY_RUN && updated > 0) {
    console.log(`ℹ️  Dry-run — rien écrit`);
  }
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
