/**
 * Position eligibility thresholds (ТЗ №9 §7).
 *
 * One rule for all heroes — no per-hero exceptions (§9). A hero may be ranked on
 * a position only if BOTH hold:
 *   - share  >= minShare   of its games are played there, AND
 *   - games  >= minGames   at that position across the window.
 *
 * Why 8% / 500 — derived from the measured distribution over the production
 * window (4 complete weeks, 4 rank brackets, 127 heroes), not chosen by eye:
 *
 *  1. The share distribution is strongly bimodal. A dense off-pick cluster sits
 *     at 0–2% (73/24/41/33/49 heroes for pos1..pos5) and is unambiguously
 *     off-role; above it the curve is a long sparse tail of real positions.
 *  2. The feasible interval is bounded from below by off-role picks that must
 *     be rejected — the largest is Kunkka at 4.9% on pos4 — and from above by
 *     genuine flex picks that must be kept — the tightest is Tusk at 10.5% on
 *     pos3. Every threshold in (4.9%, 10.5%] satisfies both.
 *  3. 8% is the midpoint-ish of that interval: 3.1pp of headroom below the
 *     tightest must-keep case (so Tusk keeps pos3 across week-to-week drift)
 *     and 3.1pp above the loosest must-drop case (so Kunkka stays off pos4).
 *     Picking the interval's extremes would leave no margin on either side.
 *  4. Coverage stays comfortable: at 8% the eligible pool is 42/67/57/67/59
 *     heroes for pos1..pos5, all far above topN=15, so the gate removes off-role
 *     noise without emptying any lane.
 *
 * The 500-game floor is a guard, not the active constraint: with 4 weeks of
 * rank-bracket data the least-picked hero still has 18 837 games, so 8% of it
 * is ~1 500 games. The floor only bites if a future snapshot is much thinner,
 * where a single stray position should not be trusted (§13).
 */
export const POSITION_ELIGIBILITY = {
  /** Minimum share of the hero's games played at that position. */
  minShare: 0.08,
  /** Minimum absolute games at that position across the whole window. */
  minGames: 500,
};
