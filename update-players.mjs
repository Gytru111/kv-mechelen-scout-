import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYERS_PATH = join(__dirname, 'players.json');
const DRY_RUN = process.argv.includes('--dry-run');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.sofascore.com/',
  'Origin': 'https://www.sofascore.com'
};

const PARENT_CLUBS = {
  'Gabriele Calvani': 'Genoa',
  'Giacomo De Pieri': 'Inter Milan',
};

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
];

function extractSofascoreId(imgUrl) {
  const m = imgUrl.match(/\/player\/(\d+)\//);
  return m ? parseInt(m[1]) : null;
}

function timestampToDateFrench(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return `${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}`;
}

function formatValue(v) {
  if (!v) return '0 €';
  return v.toLocaleString('fr-FR') + ' €';
}

function calcAge(dobStr) {
  if (!dobStr) return null;
  const dob = new Date(dobStr);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

function mapFoot(f) {
  if (!f) return 'Droit';
  const map = { 'Right': 'Droit', 'Left': 'Gauche', 'Both': 'Les deux' };
  return map[f] || f;
}

function detectSeasonKey(statSeasons) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  let startYear = year;
  if (month < 7) startYear = year - 1;
  return `${startYear % 100}/${(startYear + 1) % 100}`;
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function fetchPlayerProfile(id) {
  const data = await fetchJSON(`https://api.sofascore.com/api/v1/player/${id}`);
  return data.player || data;
}

async function fetchPlayerStats(id) {
  const data = await fetchJSON(`https://api.sofascore.com/api/v1/player/${id}/statistics`);
  return data.seasons || [];
}

function mergeStats(existingSeasons, apiSeasons) {
  const seasonKey = detectSeasonKey(apiSeasons);
  let totalMatches = 0, totalGoals = 0, totalAssists = 0;
  let totalMinutes = 0, totalYc = 0, totalRc = 0, totalCs = 0;
  let ratingSum = 0, ratingCount = 0;

  for (const s of apiSeasons) {
    if (s.year === seasonKey && s.statistics) {
      const st = s.statistics;
      totalMatches += st.appearances || 0;
      totalGoals += st.goals || 0;
      totalAssists += st.assists || 0;
      totalMinutes += st.minutesPlayed || 0;
      totalYc += st.yellowCards || 0;
      totalRc += (st.redCards || 0) + (st.yellowRedCards || 0);
      totalCs += st.cleanSheet || 0;
      if (st.rating) { ratingSum += st.rating; ratingCount++; }
    }
  }

  if (totalMatches === 0) return null;

  return {
    matches: totalMatches,
    goals: totalGoals,
    assists: totalAssists,
    rating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0,
    minutes: totalMinutes,
    yc: totalYc,
    rc: totalRc,
    cs: totalCs
  };
}

async function updatePlayer(player) {
  const sofaId = extractSofascoreId(player.img);
  if (!sofaId) {
    console.log(`  ⚠ No Sofascore ID found in img URL for ${player.name}`);
    return null;
  }

  const profile = await fetchPlayerProfile(sofaId);
  const apiSeasons = await fetchPlayerStats(sofaId);

  const changes = {};
  const newPlayer = { ...player };

  if (profile.team?.name) {
    const teamName = profile.team.name;
    const parent = PARENT_CLUBS[player.name];
    if (parent && teamName !== parent) {
      newPlayer.club = `${teamName} (prêt ${parent})`;
    } else {
      newPlayer.club = teamName;
    }
    if (newPlayer.club !== player.club) changes.club = { old: player.club, new: newPlayer.club };
  }

  if (profile.dateOfBirth) {
    const newAge = calcAge(profile.dateOfBirth);
    if (newAge !== null && newAge !== player.age) {
      newPlayer.age = newAge;
      changes.age = { old: player.age, new: newAge };
    }
  }

  if (profile.height) {
    const newHeight = `${profile.height} cm`;
    if (newHeight !== player.height) {
      newPlayer.height = newHeight;
      changes.height = { old: player.height, new: newHeight };
    }
  }

  if (profile.preferredFoot) {
    const newFoot = mapFoot(profile.preferredFoot);
    if (newFoot !== player.foot) {
      newPlayer.foot = newFoot;
      changes.foot = { old: player.foot, new: newFoot };
    }
  }

  if (profile.proposedMarketValue) {
    const newValNum = profile.proposedMarketValue;
    const newVal = formatValue(newValNum);
    if (newValNum !== player.valNum) {
      newPlayer.valNum = newValNum;
      newPlayer.val = newVal;
      changes.val = { old: player.val, new: newVal };
    }
  }

  if (profile.contractUntilTimestamp) {
    const newContract = timestampToDateFrench(profile.contractUntilTimestamp);
    if (newContract && newContract !== player.contract) {
      newPlayer.contract = newContract;
      changes.contract = { old: player.contract, new: newContract };
    }
  }

  const newStats = mergeStats(player.stats, apiSeasons);
  if (newStats) {
    const seasonKey = detectSeasonKey(apiSeasons);
    const fmKey = `fm${seasonKey.replace('/', '')}`;
    if (!newPlayer.stats) newPlayer.stats = {};
    if (JSON.stringify(newPlayer.stats[fmKey]) !== JSON.stringify(newStats)) {
      newPlayer.stats[fmKey] = newStats;
      changes.stats = { old: player.stats?.[fmKey], new: newStats };
    }
  }

  if (Object.keys(changes).length === 0) {
    console.log(`  ✓ ${player.name} — déjà à jour`);
    return null;
  }

  console.log(`  ✏ ${player.name} — changements:`);
  for (const [field, { old: o, new: n }] of Object.entries(changes)) {
    console.log(`    ${field}: ${JSON.stringify(o)} → ${JSON.stringify(n)}`);
  }

  return { player: newPlayer, changes };
}

async function main() {
  console.log(DRY_RUN ? '🔍 Mode dry-run — aucun fichier ne sera modifié\n' : '');

  let players;
  try {
    let raw = await readFile(PLAYERS_PATH, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    players = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ Impossible de lire ${PLAYERS_PATH}: ${e.message}`);
    process.exit(1);
  }

  console.log(`${players.length} joueurs trouvés dans players.json\n`);

  let updatedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    console.log(`[${i + 1}/${players.length}] ${p.name}`);

    try {
      const result = await updatePlayer(p);
      if (result) {
        players[i] = result.player;
        updatedCount++;
      }
    } catch (e) {
      console.log(`  ✗ Erreur: ${e.message}`);
      errorCount++;
    }

    if (i < players.length - 1) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  console.log(`\n── Résumé ──`);
  console.log(`Mis à jour: ${updatedCount}`);
  console.log(`Déjà à jour: ${players.length - updatedCount - errorCount}`);
  console.log(`Erreurs: ${errorCount}`);

  if (!DRY_RUN && updatedCount > 0) {
    try {
      await writeFile(PLAYERS_PATH, JSON.stringify(players, null, 2) + '\n', 'utf-8');
      console.log(`\n✅ players.json mis à jour`);
    } catch (e) {
      console.error(`\n❌ Erreur d'écriture: ${e.message}`);
      process.exit(1);
    }
  } else if (DRY_RUN && updatedCount > 0) {
    console.log(`\nℹ️  Aucune modification écrite (dry-run)`);
  } else {
    console.log(`\nℹ️  Rien à mettre à jour`);
  }
}

main().catch(e => {
  console.error(`❌ Erreur fatale: ${e.message}`);
  process.exit(1);
});
