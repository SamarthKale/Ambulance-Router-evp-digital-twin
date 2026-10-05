"""Paired statistics for arm comparisons (CLAUDE.md section 14): bootstrap 95 % confidence
interval of the mean paired difference, and the Wilcoxon signed-rank test (exact)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

BOOTSTRAP_SAMPLES = 10_000
BOOTSTRAP_SEED = 0  # resampling is seeded too: the same data gives the same interval


def bootstrap_mean_ci(
    values: Sequence[float], level: float = 0.95, samples: int = BOOTSTRAP_SAMPLES
) -> tuple[float, float]:
    """Percentile bootstrap interval of the mean."""
    data = np.asarray(values, dtype=float)
    if data.size == 0:
        return math.nan, math.nan
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    means = data[rng.integers(0, data.size, size=(samples, data.size))].mean(axis=1)
    tail = (1.0 - level) / 2.0
    low, high = np.quantile(means, [tail, 1.0 - tail])
    return float(low), float(high)


def _ranks(values: np.ndarray) -> np.ndarray:
    """Ranks starting at 1, ties sharing their average rank."""
    order = np.argsort(values, kind="stable")
    ranks = np.empty(values.size, dtype=float)
    sorted_values = values[order]
    i = 0
    while i < values.size:
        j = i
        while j + 1 < values.size and sorted_values[j + 1] == sorted_values[i]:
            j += 1
        ranks[order[i : j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return ranks


def wilcoxon_signed_rank(differences: Sequence[float]) -> tuple[float, float]:
    """(W+, two-sided p). Zero differences are dropped (Wilcoxon's method). The p-value is
    exact: the distribution of W+ over all 2^n sign assignments, computed on doubled ranks so
    tied (half) ranks stay integers."""
    d = np.asarray([x for x in differences if x != 0], dtype=float)
    n = d.size
    if n == 0:
        return 0.0, 1.0
    ranks = _ranks(np.abs(d))
    w_plus = float(ranks[d > 0].sum())
    doubled = np.rint(ranks * 2).astype(int)
    total = int(doubled.sum())
    dist = np.zeros(total + 1)
    dist[0] = 1.0
    for r in doubled:  # each rank is positive or negative with probability 1/2
        shifted = np.zeros_like(dist)
        shifted[r:] = dist[: total + 1 - r]
        dist = 0.5 * dist + 0.5 * shifted
    w2 = int(round(w_plus * 2))
    lower, upper = dist[: w2 + 1].sum(), dist[w2:].sum()
    return w_plus, float(min(1.0, 2.0 * min(lower, upper)))


@dataclass(frozen=True)
class Paired:
    n: int
    mean_diff: float  # arm minus baseline
    ci_low: float
    ci_high: float
    median_diff: float
    p_value: float  # Wilcoxon signed-rank, two-sided

    @property
    def ci_half_width(self) -> float:
        return (self.ci_high - self.ci_low) / 2.0


def paired(arm: Sequence[float], baseline: Sequence[float]) -> Paired:
    """Compare two arms over the same seeds (index i = seed i in both)."""
    if len(arm) != len(baseline):
        raise ValueError("paired samples need the same seeds")
    diffs = [a - b for a, b in zip(arm, baseline, strict=True)]
    if not diffs:
        return Paired(0, math.nan, math.nan, math.nan, math.nan, math.nan)
    low, high = bootstrap_mean_ci(diffs)
    _, p = wilcoxon_signed_rank(diffs)
    return Paired(
        n=len(diffs),
        mean_diff=float(np.mean(diffs)),
        ci_low=low,
        ci_high=high,
        median_diff=float(np.median(diffs)),
        p_value=p,
    )
