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

const CEAPI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
];

const FOOT_MAP = { 'right': 'Droit', 'left': 'Gauche', 'both': 'Les deux' };

const FRIENDLY_COMP_IDS = new Set(['FS']);
const FIRST_TEAM_COMP_TYPES = new Set([1, 2, 4, 8, 9, 10, 14]);

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

async function fetchJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: CEAPI_HEADERS, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
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

function seasonIdToKey(seasonId) {
  return `${seasonId}-${seasonId + 1}`;
}

function resolveClubForSeason(career, seasonKey) {
  if (!career || !career.length || !seasonKey) return null;
  const [startStr] = seasonKey.split('-');
  const seasonStart = parseInt(startStr);
  const seasonEnd = seasonStart + 1;
  for (const c of career) {
    const m = c.period?.match(/(\d{4})\s*-\s*(?:(\d{4})|$)/);
    if (!m) continue;
    const cStart = parseInt(m[1]);
    const cEnd = m[2] ? parseInt(m[2]) : 9999;
    if (seasonStart >= cStart && seasonStart < cEnd) return c.club;
  }
  return null;
}

async function fetchPlayerStats(tmId, career) {
  const url = `https://www.transfermarkt.com/ceapi/performance-game/${tmId}`;
  const json = await fetchJSON(url);
  if (!json?.data?.performance) return null;

  const games = json.data.performance;
  const seasonMap = {};

  for (const game of games) {
    const gi = game.gameInformation;
    const compId = gi.competitionId;
    if (FRIENDLY_COMP_IDS.has(compId)) continue;
    if (!FIRST_TEAM_COMP_TYPES.has(gi.competitionTypeId)) continue;

    const seasonId = gi.seasonId;
    const key = seasonIdToKey(seasonId);

    if (!seasonMap[key]) {
      seasonMap[key] = { matches: 0, goals: 0, assists: 0, minutes: 0, yc: 0, rc: 0, ratings: [] };
    }
    const s = seasonMap[key];
    const st = game.statistics;
    if (!st) continue;

    const played = st.generalStatistics?.participationState === 'played' || (st.playingTimeStatistics?.playedMinutes || 0) > 0;
    if (!played) continue;

    s.matches++;
    s.goals += st.goalStatistics?.goalsScoredTotalOfficial || 0;
    s.assists += st.goalStatistics?.assistsOfficial || 0;
    s.minutes += st.playingTimeStatistics?.playedMinutes || 0;
    const cs = st.cardStatistics;
    s.yc += cs?.yellowCardGross || 0;
    s.rc += (cs?.redCard ? 1 : 0) + (cs?.yellowRedCard ? 1 : 0) - (cs?.redCardsRescinded || 0);

    const grade = st.generalStatistics?.grade;
    if (grade != null && grade > 0) s.ratings.push(grade);
  }

  const allKeys = Object.keys(seasonMap).sort().reverse();
  const recentKeys = allKeys.slice(0, 3);
  const stats = {};
  for (const key of recentKeys) {
    const s = seasonMap[key];
    stats[key] = {
      club: resolveClubForSeason(career, key),
      matches: s.matches,
      goals: s.goals,
      assists: s.assists,
      minutes: s.minutes,
      yc: s.yc,
      rc: s.rc
    };
  }
  return Object.keys(stats).length > 0 ? stats : null;
}

async function updatePlayer(player) {
  const tmId = player.tmId;
  if (!tmId) {
    console.log(`  ⚠ Pas d'ID Transfermarkt — ignoré`);
    return null;
  }

  const changes = {};
  const p = { ...player };

  const html = await fetchHTML(`https://www.transfermarkt.com/x/profil/spieler/${tmId}`);
  const data = parseTMProfile(html);

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

  await new Promise(r => setTimeout(r, 1500));

  try {
    const newStats = await fetchPlayerStats(tmId, p.career);
    if (newStats) {
      const oldKeys = Object.keys(player.stats || {}).sort().join(',');
      const newKeys = Object.keys(newStats).sort().join(',');
      const oldTotals = Object.values(player.stats || {}).reduce((a, s) => a + s.matches + s.goals + s.assists + s.minutes, 0);
      const newTotals = Object.values(newStats).reduce((a, s) => a + s.matches + s.goals + s.assists + s.minutes, 0);

      if (oldKeys !== newKeys || oldTotals !== newTotals || JSON.stringify(player.stats) !== JSON.stringify(newStats)) {
        changes.stats = { old: player.stats, new: newStats };
        p.stats = newStats;
      }
    }
  } catch (e) {
    console.log(`  ⚠ Stats: ${e.message}`);
  }

  if (Object.keys(changes).length === 0) {
    console.log(`  ✓ déjà à jour`);
    return null;
  }

  console.log(`  ✏ changements:`);
  for (const [field, info] of Object.entries(changes)) {
    if (field === 'stats') {
      const seasons = Object.keys(info.new).sort();
      for (const sk of seasons) {
        const ns = info.new[sk];
        const os = info.old?.[sk];
        if (os) {
          const diffs = [];
          if (ns.matches !== os.matches) diffs.push(`matchs: ${os.matches}→${ns.matches}`);
          if (ns.goals !== os.goals) diffs.push(`buts: ${os.goals}→${ns.goals}`);
          if (ns.assists !== os.assists) diffs.push(`passes: ${os.assists}→${ns.assists}`);
          if (ns.minutes !== os.minutes) diffs.push(`min: ${os.minutes}→${ns.minutes}`);
          if (diffs.length) console.log(`    stats.${sk}: ${diffs.join(', ')}`);
        } else {
          console.log(`    stats.${sk}: nouveau (${ns.matches}M, ${ns.goals}B, ${ns.assists}P, ${ns.minutes}min)`);
        }
      }
    } else {
      console.log(`    ${field}: ${JSON.stringify(info.old)} → ${JSON.stringify(info.new)}`);
    }
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
