# TZ No.37 — Item x Enemy uplift research (pooled, Hero+Position-controlled)

Feasibility + identifiability: does the enemy layer carry an item-uplift
signal once the Hero x Position composition is controlled — and is the
marginal Item x Enemy grain statistically usable at all?

> **Verdict: `ENEMY_UPLIFT_ABSENT` — при 5709 PRIMARY-ячейках ни одна из
> 18511 гипотез не выживает под BH FDR q=0.05. Никакого item-uplift
> слоя в scoring не добавляем. Grain статистически работоспособен
> (5940 PRIMARY-ячеек, 749 честно ушли в fail-closed), но сигнала
> Item × Enemy в этом corpus нет.**

Reproduce (offline, no network):

```bash
node scripts/item-enemy-uplift-research.mjs all
node scripts/item-enemy-uplift-research.mjs sparsity
node scripts/item-enemy-uplift-research.mjs determinism   # run twice + cmp
npx vitest run scripts/item-enemy-uplift-lib.test.ts      # 24/24
```

## Sec.0 Core audit fixes (7 issues, closed BEFORE the final run)

Перед финальным прогоном ядро было проверено по аудиторским спискам:

| # | issue | fix | verification |
|---|---|---|---|
| 1 | pooled permutation: labels мешались между Hero×Position strata | `upliftPermutationTest(strata, nPerms, rng)` — перестановка **только внутри** каждой strata, exposed-count фиксирован; статистика = composition-weighted gap = `raw.delta` | 2 REGRESSION-теста (ниже) |
| 2 | частично покрытый baseline: observed по 100 slots, expected по 70 | `covered !== nExposed` → `UNCOVERED_BASELINE`, ячейка не входит в inference | в отчёте: **749** ячеек fail-closed |
| 3 | глобальный background `slice` (old `pool.slice(0, 4*pool.length)` был no-op — брал ВЕСЬ пул) | cap **per stratum**: `4 × exposedCountInStratum`, детерминированный порядок | код `inferCell` |
| 4 | seed `20261007` ≠ утверждённый ТЗ | `RESEARCH_SEED = 20261006` | тест `constants` |
| 5 | несуществующий экспорт `PRIMARY_ITEM_IDS` (runtime import error) | на диске отсутствует (`grep` = 0); `sparsity` mode exit 0 доказывает runtime-import | grep + прогон |
| 6 | fallback писал несуществующее `raw.absDelta` | нет фона → `p = NaN`, статистика **не выдумывается** | код `inferCell` |
| 7 | **position production gate не применялся**: `eligibleHpSet()` был написан, но нигде не вызывался — в inference шли ВСЕ Hero×Position | gate в `buildSlots`: `POSITION_NOT_ELIGIBLE` дропается ДО exposure/baseline/strata; `eligibleHpSet` + `positionGateDropReason` перенесены в lib; missing gate set → `POSITION_GATE_MISSING` (fail-closed) | drop count **302** в §1; 3 gate-теста |

Регрессионные тесты против возврата pooled-ошибки:

- `every permutation preserves each stratum exposed count` — trace всех 200
  перестановок обязан вернуть `[3, 4]` для двух strata; pooled-реализация
  не может это гарантировать;
- `pooled null differs from stratified on composition confound` —
  Simpson-вход (exposed сконцентрирован в high-rate stratum, background — в
  low-rate; внутри каждой strata exposed == background, эффекта нет):
  **stratified p=1, pooled p<0.05** — старая реализация давала ложный
  "significance" именно на составе.

Gate-тесты (issue №7): пороги гейта верифицируются verbatim
(share ≥ 8% **AND** games ≥ 500); ineligible Hero×Position возвращает
`POSITION_NOT_ELIGIBLE` ДО того, как slot может попасть в output
`buildSlots` — а exposure, hpRate, baseline и permutation strata строятся
ТОЛЬКО из этого output; отсутствующий gate-set → `POSITION_GATE_MISSING`.

Также исправлено: Clopper–Pearson назван корректно — *95% CI для OBSERVED
ownership rate, а не для uplift*.

## Sec.1 Corpus & grain

- corpus: `/tmp/opendota-level2-pilot/bridge.json` — 400 rank-filtered
  public matches (ТЗ №28), из них **239** прошли матч-гейты;
- **production position gate**: Hero×Position должен иметь в
  `public/data/positions.json` share ≥ 8% и games ≥ 500 — иначе слот
  дропается до какого-либо inference;
- usable slots после всех гейтов: **2088**;
- drop reasons (fail-closed, never imputed):
  `POSITION_NOT_ELIGIBLE: 302`, `MATCH_NOT_OK: 90`, `POSITION_NOT_FULL: 71`;
- primary items: **180** (catalogue gate: purchasable, non-stackable, cost>0);
- distinct enemies faced: **127**; split-half slots A=1100 B=988;
- grain (verbatim, fixed BEFORE numbers): Match × PlayerSlot × Item ×
  EnemyHero, ownership-at-end 0/1 (item0–5 + backpack0–2, neutral0 excluded,
  consumables excluded, финальные itemId без компонентов, mirror-матчи —
  легальное exposed observation, один slot = максимум одно наблюдение на
  (item × enemy)).

## Sec.2 Sparsity audit

| | |
|---|---|
| (item × enemy) cells total | **22860** (180 × 127) |
| reaching inference (N≥30) | **19260 (84.3%)** |
| PRIMARY (N≥100) | **5940** |
| EXPLORATORY (N=30..99) | **13320** |
| EXCLUDED (N<30) | **3600** |
| N_exposed over tested cells | min=31 p50=72 p90=191 max=316 |

Grain по поддержке жизнеспособен: PRIMARY-ячейки существуют (5940),
вердикт SPARSE здесь **не** применим — дальше решает Sec.4.

## Sec.3 Method

- **position production gate** (см. Sec.0 #7): слот проходит гейт
  `share ≥ 8% AND games ≥ 500` до exposure/baseline/strata — ineligible
  слоты не влияют ни на один этап;
- baseline: composition-weighted `E[Item | MyHero, Position]` по exposed-составу
  ячейки (тот же grain, тот же corpus, те же фильтры) — **fail-closed**:
  `covered !== nExposed` → `UNCOVERED_BASELINE`, без inference;
- shrinkage: EB Beta-Binomial posterior mean к weighted baseline; prior
  strength `m0 ∈ [8, 200]` method of moments по дисперсии Hero×Position
  rate'ов предмета (см. Sec.7 про `/50`);
- interval: **95% Clopper–Pearson CI для OBSERVED ownership rate** — не CI
  для uplift (без нормального приближения, binomial-tail inversion);
- test: **Hero × Position-stratified permutation** — labels мешаются только
  внутри каждой strata с фиксированным exposed-count; статистика =
  composition-weighted gap; N=2000, seed=**20261006**, без Math.random();
  константные strata → p=1 без расхода RNG;
- correction: Benjamini-Hochberg FDR q=0.05, **один пул** на все
  прошедшие gate ячейки;
- stability: детерминированный split-half (even/odd matchId) по знаку
  shrunk-delta.

## Sec.4 Uplift (tested cells only)

| | |
|---|---|
| hypotheses in BH pool | **18511** |
| fail-closed UNCOVERED_BASELINE | **749** (excluded before BH, never imputed) |
| raw-p<0.05 | **408 (2.2%)** |
| **q<0.05 (FDR-significant)** | **0** |
| best | `item_magic_wand` vs Riki: N=75 K=12 pObs=16.0% pExp=30.7% raw=−14.7pp shrunk=−13.0pp CI=[8.6%, 26.3%] p=<0.001 **q=1.000** |

Top-10 по q (все q=1.000): magic_wand/Riki, nullifier/Necrophos,
**MKB/PA** (N=172, +8.2pp, p<0.001), quelling_blade/Nature's Prophet,
sphere/Spirit Breaker, **BKB/Pangolier** (N=39, +19.5pp),
blade_mail/Venomancer, ultimate_scepter/Hoodwink, BKB/Anti-Mage (−11.2pp),
lesser_crit/Pudge.

Чтение: сырых попаданий 408 против ~926 ожидаемых под нулём на 18511
тестов — **меньше, чем шум**. Поправке BH нечего корректировать: ни одна
ячейка не подходит к границе. Лучший p<0.001 при пуле 18511 даёт q≈1 —
честный масштаб, а не артефакт.

## Sec.5 Canonical probes (as-is)

| probe | N | pObs vs pExp | raw | p | reading |
|---|---|---|---|---|---|
| BKB vs Phantom Assassin | 172 | 23.3% vs 25.3% | −2.0pp | 0.484 | null |
| MKB vs Phantom Assassin | 172 | 16.3% vs 8.0% | +8.2pp | <0.001 | raw-only, q=1.000 |
| Silver Edge vs Bristleback | 85 | 7.1% vs 4.6% | +2.5pp | 0.352 | null |
| Nullifier vs Windranger | 195 | 2.1% vs 2.1% | −0.1pp | 1.000 | null |
| Blink vs Sniper | 246 | 37.0% vs 38.4% | −1.4pp | 0.517 | null |

Канонические контр-пары в основном дают null: «правильные» контр-предметы
не концентрируются против своих героев сверх Hero×Position baseline
(в этом corpus).


## Sec.6 Stability (split-half sign agreement)

- tested cells 18511; halves agree **10822 (58.5%)**, disagree 7689,
  degenerate 0; primary cells in pool: 5709;
- чтение: полусогласие само по себе диагностика; claims — только вместе с
  FDR-significant primary cells (Sec.8). 58.5% ≈ чуть выше шумового уровня,
  но при пуле без выживших оно ничего не доказывает.

## Sec.7 Limitations

- corpus bias: 400 rank-filtered public matches (Herald-Archon heavy),
  Turbo over-represented; single patch snapshot;
- enemy position не условится: foe lane игнорируется по дизайну
  (marginal single-enemy analysis);
- mirror rule: **mirror match — легальное exposed observation**: зеркальный
  герой как enemy считается (GRAIN_DECISION, no exclusion);
- ownership-at-end смешивает плановые и пост-hoc покупки; post-hoc confound
  (№23: ~32% late entries) действует в полной мере;
- baseline corpus-internal: uplift относится к ЭТОМУ corpus, не к
  shipping-агрегатам ItemPrior (другой grain);
- position gate применяется к slots этого corpus; пороговые значения
  (8%/500) — production-гейт из positions.json, без подгонки под №37;
- **EB prior `/50`**: `hpPriorStrength` вычитает `mean(1−mean)/50` —
  зашитое предположение о sampling noise вместо оценки по реальным
  denominators strata. Не блокер (влияет только на shrunkDelta/stability
  diagnostic, **не** на permutation p-values и BH q-values), но до
  production-применения EB следует пересчитать с n_s.

## Sec.8 Verdict

```text
ENEMY_UPLIFT_ABSENT
primary / primary-significant / tested: 5709 / 0 / 18511
```

`decideUpliftVerdict({ primaryCells: 5709, stableHits: 0, exploratoryHits: 0 })`
→ ABSENT: покрытие достаточное (5709 PRIMARY-ячеек), ни одна гипотеза не
выжила под BH. Grain работоспособен — сигнала Item × Enemy в этом corpus
нет. Ветка item-uplift в scoring не интегрируется.

Валидация: `node --check` оба файла; vitest **891 passed / 1 skipped**
(lib-тесты **24/24**); `npm run typecheck` чисто; `npm run build` ок;
determinism mode — **byte-identical** двойной прогон (seed 20261006);
position gate: `POSITION_NOT_ELIGIBLE: 302` слотов отсеяно до inference.

