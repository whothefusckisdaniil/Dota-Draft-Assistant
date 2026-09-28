/**
 * ТЗ №9 analysis probe — reproduces the numbers behind docs/position-model.md.
 *
 *   npx tsx scripts/stratz/probe-positions.mjs            # distribution + §8 cases
 *   npx tsx scripts/stratz/probe-positions.mjs schema     # §1/§2 schema introspection
 *
 * `schema` exists because §2 forbids assuming the position-id mapping. It walks
 * the live GraphQL schema and prints the real field signatures, so the claim
 * "POSITION_N means lane N" is checkable rather than folklore.
 */
import { readFileSync } from 'node:fs';
import { StratzTransport, loadToken, BUCKET_SEC, BRACKETS } from '../update-data-stratz.mjs';
import { getCompleteWeeklyBuckets } from './buckets.mjs';

const schema = async () => {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const q = await t.query(`{ __schema { queryType { fields { name args { name type { name kind ofType { name } } } type { name kind ofType { name } } } } } }`);
    console.log('=== Query root: hero/position/stats fields ===');
    for (const f of q.data.__schema.queryType.fields) {
      if (!/hero|position|stat/i.test(f.name)) continue;
      const a = f.args.map((x) => `${x.name}:${x.type.name || x.type.ofType?.name}`).join(', ');
      console.log(`  ${f.name}(${a}) -> ${f.type.name || f.type.ofType?.name}`);
    }
    const e = await t.query(`{ __type(name: "MatchPlayerPositionType") { enumValues { name } } }`);
    console.log('\n=== MatchPlayerPositionType ===');
    console.log('  ' + e.data.__type.enumValues.map((v) => v.name).join(', '));
    const r = await t.query(`{
      __type(name: "HeroPositionTimeDetailType") { fields { name type { name kind ofType { name } } } }
    }`);
    console.log('\n=== HeroPositionTimeDetailType ===');
    for (const f of r.data.__type.fields) console.log(`  ${f.name} -> ${f.type.name || f.type.ofType?.name}`);
  } finally {
    await t.close();
  }
};

const distribution = async () => {
  const heroes = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
  const heroIds = heroes.map((h) => h.id).sort((a, b) => a - b);
  const name = new Map(heroes.map((h) => [h.id, h.name]));
  const wi = getCompleteWeeklyBuckets(new Date(), 4);
  const POS = [1, 2, 3, 4, 5].map((i) => `POSITION_${i}`);

  const t = new StratzTransport(loadToken());
  await t.init();
  const totals = new Map();
  try {
    for (const b of wi.buckets) {
      const res = await t.query(
        `{ heroStats { stats(heroIds: ${JSON.stringify(heroIds)}, week: ${b * BUCKET_SEC}, bracketBasicIds: [${BRACKETS.join(', ')}], groupByPosition: true) { heroId position matchCount } } }`,
      );
      for (const row of res.data.heroStats.stats) {
        if (!POS.includes(row.position)) continue;
        const id = Number(row.heroId);
        if (!totals.has(id)) totals.set(id, {});
        const m = totals.get(id);
        m[row.position] = (m[row.position] ?? 0) + Number(row.matchCount);
      }
    }
  } finally {
    await t.close();
  }

  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
  // `totals` is a Map — Object.entries() on one returns [], so iterate properly.
  const entries = [...totals.entries()];
  console.log('buckets:', wi.buckets.join(', '), '| excluded partial:', wi.currentBucket);
  console.log('\n=== per-position share distribution ===');
  console.log('pos   n     min      p50      p75      p90      p95      max    | medGames');
  for (const p of POS) {
    const rows = entries
      .map(([, v]) => {
        const tot = POS.reduce((s, k) => s + (v[k] ?? 0), 0);
        const games = v[p] ?? 0;
        return { tot, games, share: tot > 0 ? games / tot : 0 };
      })
      .filter((r) => r.tot > 0);
    const sh = rows.map((r) => r.share);
    console.log(
      `${p.slice(-1)}   ${String(rows.length).padStart(3)}   ` +
        [Math.min(...sh), pct(sh, 0.5), pct(sh, 0.75), pct(sh, 0.9), pct(sh, 0.95), Math.max(...sh)]
          .map((v) => (v * 100).toFixed(1).padStart(6) + '%').join(' ') +
        `  | ${Math.round(pct(rows.map((r) => r.games), 0.5))}`,
    );
  }

  console.log('\n=== §8 edge cases (share% of total) ===');
  for (const nm of ['Wraith King', 'Meepo', 'Puck', 'Bane', 'Tusk', 'Rubick', 'Kunkka', 'Pudge', 'Mirana', 'Clockwerk']) {
    const id = String(heroes.find((h) => h.name === nm).id);
    const v = totals.get(Number(id)) ?? {};
    const tot = POS.reduce((s, k) => s + (v[k] ?? 0), 0);
    console.log(`  ${nm.padEnd(12)} ${POS.map((p) => `${((v[p] ?? 0) / tot * 100).toFixed(1)}%`.padStart(7)).join('')}   total=${tot}`);
  }

  console.log('\n=== threshold grid: heroes clearing each share bar ===');
  for (const T of [0.05, 0.08, 0.1, 0.12, 0.15, 0.2]) {
    const counts = POS.map((p) => entries.filter(([, v]) => {
      const tot = POS.reduce((s, k) => s + (v[k] ?? 0), 0);
      return tot > 0 && (v[p] ?? 0) / tot >= T;
    }).length);
    console.log(`  share >= ${(T * 100).toFixed(0).padStart(2)}%  ->  [${counts.join(', ')}] per lane`);
  }
};

if (process.argv[2] === 'schema') await schema();
else await distribution();
