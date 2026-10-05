"""Sprint 9: paired statistics (pure)."""

from __future__ import annotations

import itertools

import numpy as np
import pytest

from evaluation.stats import _ranks, bootstrap_mean_ci, paired, wilcoxon_signed_rank


def brute_force_p(diffs: list[float]) -> float:
    """Two-sided exact p by enumerating every sign assignment of the ranked differences."""
    d = [x for x in diffs if x != 0]
    ranks = _ranks(np.abs(np.asarray(d, dtype=float)))
    observed = sum(r for r, x in zip(ranks, d, strict=True) if x > 0)
    sums = [
        sum(r for r, s in zip(ranks, signs, strict=True) if s)
        for signs in itertools.product((False, True), repeat=len(d))
    ]
    lower = sum(1 for v in sums if v <= observed + 1e-9) / len(sums)
    upper = sum(1 for v in sums if v >= observed - 1e-9) / len(sums)
    return min(1.0, 2 * min(lower, upper))


def test_wilcoxon_matches_textbook_values() -> None:
    assert wilcoxon_signed_rank([1, 2, 3, 4, 5]) == (15.0, pytest.approx(0.0625))
    assert wilcoxon_signed_rank([1, -2, 3, 4, 5]) == (13.0, pytest.approx(0.1875))
    assert wilcoxon_signed_rank([0, 0]) == (0.0, 1.0)  # zeros are dropped


@pytest.mark.parametrize(
    "diffs",
    [
        [3.1, -1.2, 4.0, 4.0, -4.0, 2.5, 0.0, 7.7, -0.3],  # ties and a zero
        [-12.0, -8.5, -30.1, -2.0, 1.5, -9.9, -9.9, -14.2, -5.0, -0.7, -22.0],
        [1.0] * 6 + [-1.0] * 4,  # all tied
    ],
)
def test_wilcoxon_exact_p_equals_full_enumeration(diffs: list[float]) -> None:
    _, p = wilcoxon_signed_rank(diffs)
    assert p == pytest.approx(brute_force_p(diffs), abs=1e-12)


def test_bootstrap_interval_is_seeded_and_sensible() -> None:
    assert bootstrap_mean_ci([5.0] * 8) == (5.0, 5.0)
    data = [-31.0, -12.5, -40.2, -18.0, -25.3, -9.1, -22.2, -35.0, -15.5, -27.7]
    low, high = bootstrap_mean_ci(data)
    assert (low, high) == bootstrap_mean_ci(data)  # same data, same interval
    assert low < sum(data) / len(data) < high < 0


def test_paired_needs_the_same_seeds() -> None:
    result = paired([100.0, 120.0, 90.0], [150.0, 160.0, 130.0])  # -50, -40, -40
    assert result.n == 3 and result.mean_diff == pytest.approx(-130.0 / 3)
    assert result.median_diff == -40.0 and result.p_value == pytest.approx(0.25)
    assert result.ci_low <= result.mean_diff <= result.ci_high
    with pytest.raises(ValueError):
        paired([1.0], [1.0, 2.0])
