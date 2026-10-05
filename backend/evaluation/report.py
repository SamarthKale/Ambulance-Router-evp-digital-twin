"""Experiment outputs (CLAUDE.md section 14): per-arm CSVs and run manifests, paired comparisons
with bootstrap 95 % CIs and Wilcoxon p-values, charts, and summary.json for the app.

Layout under experiments/:
  <arm>/runs.csv                     one row per run (scenario, scale, seed)
  <arm>/manifests/<run>.json         run manifest per run
  summary/paired.csv                 arm vs baseline, per scenario, scale and metric
  summary/summary.json               what the app's comparison chart shows
  summary/*.png                      charts (labelled as autopilot batch results)
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")  # files only, no window

import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

from evaluation.arms import ALL_ARMS, BASELINE, SIGNALS, Arm  # noqa: E402
from evaluation.stats import bootstrap_mean_ci, paired  # noqa: E402

KEY = ["scenario", "scale", "seed", "arm"]
# Lower is better for all of them; differences are arm minus baseline.
METRICS: dict[str, str] = {
    "travel_s": "ambulance travel time (s)",
    "wait_s": "ambulance waiting time (s)",
    "red_stops": "ambulance red-light stops",
    "approach_clear_s": "time to clear the ambulance's approach (s)",
    "queue_mean": "mean queue per signalised approach (veh)",
    "bg_time_loss_s": "background time loss (veh-s, tripinfo)",
    "bg_max_wait_s": "longest background wait (s)",
    "bg_halted_s": "background halted vehicle-seconds",
    "route_changes": "route changes",
    "preemptions": "preemptions",
}
SAFETY = ["violations", "collisions", "emergency_brakings", "teleports"]
ARM_ORDER = [arm.id for arm in ALL_ARMS]
ARM_LABEL = {
    "off_strict": "OFF strict",
    "off_realistic": "OFF realistic",
    "basic": "BASIC",
    "coord": "COORD",
}
COLOR = {
    "off_strict": "#6b7280",
    "off_realistic": "#a16207",
    "basic": "#2563eb",
    "coord": "#059669",
}
CHART_NOTE = "Autopilot batch runs (the live demo is driven manually). Rule-based, simulated."


def label(arm_id: str) -> str:
    signals, routing = arm_id.rsplit("_", 1)
    return f"{ARM_LABEL[signals]} · {routing}"


# ---- storage -------------------------------------------------------------------------------
def save_runs(out: Path, rows: Iterable[dict[str, Any]]) -> None:
    """Merge rows into experiments/<arm>/runs.csv (a re-run replaces the old row)."""
    new = pd.DataFrame(list(rows))
    if new.empty:
        return
    for arm_id, group in new.groupby("arm"):
        path = out / str(arm_id) / "runs.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        merged = pd.concat([pd.read_csv(path), group]) if path.exists() else group
        merged = merged.drop_duplicates(KEY, keep="last").sort_values(["scenario", "scale", "seed"])
        merged.to_csv(path, index=False)


def save_manifest(out: Path, manifest: dict[str, Any]) -> None:
    path = out / manifest["arm"] / "manifests" / f"{manifest['run']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def load_runs(out: Path) -> pd.DataFrame:
    frames = [pd.read_csv(p) for p in sorted(out.glob("*/runs.csv"))]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=KEY)


def done_keys(out: Path) -> set[tuple[str, float, int, str]]:
    runs = load_runs(out)
    return {
        (str(r.scenario), float(r.scale), int(r.seed), str(r.arm))
        for r in runs.itertuples(index=False)
    }


# ---- paired comparisons ------------------------------------------------------------------
def comparisons(arms: Sequence[str]) -> list[tuple[str, str]]:
    """(arm, reference): every arm against the baseline, and dynamic vs static routing."""
    pairs = [(a, BASELINE.id) for a in arms if a != BASELINE.id]
    for signals in SIGNALS:
        dyn, sta = Arm(signals, "dynamic").id, Arm(signals, "static").id
        if dyn in arms and sta in arms and (dyn, sta) not in pairs:
            pairs.append((dyn, sta))
    return [p for p in pairs if p[1] in arms]


def paired_table(runs: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (scenario, scale), group in runs.groupby(["scenario", "scale"]):
        arms = [a for a in ARM_ORDER if a in set(group["arm"])]
        consistent = _check_pairing(group)
        for arm, ref in comparisons(arms):
            a = group[group["arm"] == arm].set_index("seed")
            b = group[group["arm"] == ref].set_index("seed")
            seeds = sorted(set(a.index) & set(b.index))
            valid = [s for s in seeds if bool(a.at[s, "valid"]) and bool(b.at[s, "valid"])]
            for metric in METRICS:
                pa = [
                    float(a.at[s, metric])
                    for s in valid
                    if _finite(a.at[s, metric], b.at[s, metric])
                ]
                pb = [
                    float(b.at[s, metric])
                    for s in valid
                    if _finite(a.at[s, metric], b.at[s, metric])
                ]
                result = paired(pa, pb)
                rows.append(
                    {
                        "scenario": scenario,
                        "scale": scale,
                        "metric": metric,
                        "arm": arm,
                        "reference": ref,
                        "n": result.n,
                        "excluded": len(seeds) - result.n,
                        "arm_mean": _mean(pa),
                        "reference_mean": _mean(pb),
                        "mean_diff": result.mean_diff,
                        "ci_low": result.ci_low,
                        "ci_high": result.ci_high,
                        "median_diff": result.median_diff,
                        "p_wilcoxon": result.p_value,
                        "pairing_ok": consistent,
                    }
                )
    return pd.DataFrame(rows)


def _check_pairing(group: pd.DataFrame) -> bool:
    """Every arm of a seed started from the same traffic (same dispatch fingerprint)."""
    return bool((group.groupby("seed")["dispatch_hash"].nunique() <= 1).all())


def _finite(*values: Any) -> bool:
    return all(v is not None and not (isinstance(v, float) and math.isnan(v)) for v in values)


def _mean(values: Sequence[float]) -> float:
    return float(sum(values) / len(values)) if values else math.nan


# ---- summary for the app -----------------------------------------------------------------
def summary(runs: pd.DataFrame, table: pd.DataFrame) -> dict[str, Any]:
    out: dict[str, Any] = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "note": CHART_NOTE,
        "baseline": BASELINE.id,
        "experiments": [],
    }
    for (scenario, scale), group in runs.groupby(["scenario", "scale"]):
        arms = []
        for arm in [a for a in ARM_ORDER if a in set(group["arm"])]:
            rows = group[group["arm"] == arm]
            valid = rows[rows["valid"].astype(bool)]
            travel = [float(t) for t in valid["travel_s"]]
            low, high = bootstrap_mean_ci(travel)
            vs = table[
                (table["scenario"] == scenario)
                & (table["scale"] == scale)
                & (table["arm"] == arm)
                & (table["reference"] == BASELINE.id)
            ]
            signals, routing = arm.rsplit("_", 1)
            entry: dict[str, Any] = {
                "arm": arm,
                "label": label(arm),
                "signals": signals,
                "routing": routing,
                "runs": int(len(rows)),
                "valid": int(len(valid)),
                "travel_mean": _num(_mean(travel)),
                "travel_ci": [_num(low), _num(high)],
                "wait_mean": _num(_mean([float(w) for w in valid["wait_s"]])),
                "safety": {k: int(rows[k].sum()) for k in SAFETY},
            }
            for metric, key in (
                ("travel_s", "travel_vs_baseline"),
                ("bg_time_loss_s", "bg_delay_vs_baseline"),
            ):
                hit = vs[vs["metric"] == metric]
                entry[key] = None
                if not hit.empty:
                    r = hit.iloc[0]
                    entry[key] = {
                        "n": int(r["n"]),
                        "mean_diff": _num(r["mean_diff"]),
                        "ci": [_num(r["ci_low"]), _num(r["ci_high"])],
                        "p": _sig(r["p_wilcoxon"]),
                    }
            arms.append(entry)
        out["experiments"].append(
            {
                "scenario": scenario,
                "scale": float(scale),
                "seeds": sorted(int(s) for s in set(group["seed"])),
                "pairing_ok": _check_pairing(group),
                "signal_program": str(group["signal_program"].iloc[0]),
                "cycle_s": _num(group["cycle_s"].mean(), 1),
                "arms": arms,
            }
        )
    return out


def _sig(value: Any) -> float | None:
    """p-values keep 3 significant digits (0.000123 must not round to 0)."""
    number = _num(value, 12)
    return None if number is None else float(f"{number:.3g}")


def _num(value: Any, digits: int = 2) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), digits)


# ---- charts -------------------------------------------------------------------------------
def _signals_of(arm_id: str) -> str:
    return arm_id.rsplit("_", 1)[0]


def chart_travel(runs: pd.DataFrame, scenario: str, scale: float, path: Path) -> None:
    group = runs[(runs["scenario"] == scenario) & (runs["scale"] == scale)]
    arms = [a for a in ARM_ORDER if a in set(group["arm"])]
    fig, ax = plt.subplots(figsize=(10, 5.2))
    for i, arm in enumerate(arms):
        values = group[(group["arm"] == arm) & group["valid"].astype(bool)]["travel_s"]
        color = COLOR[_signals_of(arm)]
        ax.boxplot([values], positions=[i], widths=0.55, showfliers=False,
                   patch_artist=True, boxprops={"facecolor": color + "33", "edgecolor": color},
                   medianprops={"color": color})  # fmt: skip
        jitter = [i + ((k % 7) - 3) * 0.04 for k in range(len(values))]
        ax.scatter(jitter, values, s=12, color=color, alpha=0.8, zorder=3)
    ax.set_xticks(range(len(arms)), [label(a) for a in arms], rotation=20, ha="right")
    ax.set_ylabel("ambulance travel time (s)")
    seeds = group["seed"].nunique()
    ax.set_title(f"Ambulance travel time · {scenario} · demand x{scale:g} · {seeds} paired seeds")
    ax.grid(axis="y", alpha=0.3)
    fig.text(0.01, 0.01, CHART_NOTE, fontsize=8, color="#555")
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(path, dpi=130)
    plt.close(fig)


def chart_paired(table: pd.DataFrame, scenario: str, scale: float, metric: str, path: Path) -> None:
    rows = table[
        (table["scenario"] == scenario)
        & (table["scale"] == scale)
        & (table["metric"] == metric)
        & (table["reference"] == BASELINE.id)
    ]
    rows = rows.set_index("arm").reindex([a for a in ARM_ORDER if a in set(rows["arm"])])
    fig, ax = plt.subplots(figsize=(9, 0.55 * len(rows) + 1.8))
    y = list(range(len(rows)))
    colors = [COLOR[_signals_of(a)] for a in rows.index]
    ax.barh(y, rows["mean_diff"], color=[c + "99" for c in colors], edgecolor=colors)
    err = [rows["mean_diff"] - rows["ci_low"], rows["ci_high"] - rows["mean_diff"]]
    ax.errorbar(rows["mean_diff"], y, xerr=err, fmt="none", ecolor="#111", capsize=4)
    for yi, (_, r) in zip(y, rows.iterrows(), strict=True):
        ax.text(r["ci_high"], yi, f"  n={int(r['n'])}, p={r['p_wilcoxon']:.3g}", va="center",
                fontsize=8)  # fmt: skip
    ax.axvline(0, color="#111", linewidth=0.8)
    ax.set_yticks(y, [label(a) for a in rows.index])
    ax.invert_yaxis()
    ax.set_xlabel(f"{METRICS[metric]}: arm minus {label(BASELINE.id)} (mean, 95 % bootstrap CI)")
    ax.set_title(f"Paired difference vs baseline · {scenario} · demand x{scale:g}")
    ax.grid(axis="x", alpha=0.3)
    fig.text(0.01, 0.01, CHART_NOTE, fontsize=8, color="#555")
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(path, dpi=130)
    plt.close(fig)


def chart_sweep(runs: pd.DataFrame, scenario: str, path: Path) -> None:
    group = runs[(runs["scenario"] == scenario) & runs["valid"].astype(bool)]
    scales = sorted(set(group["scale"]))
    if len(scales) < 2:
        return
    fig, ax = plt.subplots(figsize=(8, 5))
    for arm in [a for a in ARM_ORDER if a in set(group["arm"])]:
        means, lows, highs, xs = [], [], [], []
        for scale in scales:
            values = group[(group["arm"] == arm) & (group["scale"] == scale)]["travel_s"].tolist()
            if values:
                low, high = bootstrap_mean_ci(values)
                xs.append(scale)
                means.append(_mean(values))
                lows.append(low)
                highs.append(high)
        color = COLOR[_signals_of(arm)]
        style = "-" if arm.endswith("dynamic") else "--"
        ax.plot(xs, means, style, marker="o", color=color, label=label(arm))
        ax.fill_between(xs, lows, highs, color=color, alpha=0.12)
    ax.set_xlabel("demand (x base: 400 veh/h per entry)")
    ax.set_ylabel("mean ambulance travel time (s), 95 % CI")
    ax.set_title(f"Demand sweep · {scenario}")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8, ncol=2)
    fig.text(0.01, 0.01, CHART_NOTE, fontsize=8, color="#555")
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(path, dpi=130)
    plt.close(fig)


def write_report(out: Path) -> dict[str, Any]:
    runs = load_runs(out)
    if runs.empty:
        raise ValueError(f"no runs under {out}")
    folder = out / "summary"
    folder.mkdir(parents=True, exist_ok=True)
    table = paired_table(runs)
    table.to_csv(folder / "paired.csv", index=False, float_format="%.4g")
    data = summary(runs, table)
    (folder / "summary.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    for (scenario, scale), _ in runs.groupby(["scenario", "scale"]):
        tag = f"{scenario}_x{scale:g}"
        chart_travel(runs, scenario, scale, folder / f"travel_time_{tag}.png")
        for metric in ("travel_s", "bg_time_loss_s", "wait_s"):
            chart_paired(table, scenario, scale, metric, folder / f"paired_{metric}_{tag}.png")
    for scenario in sorted(set(runs["scenario"])):
        chart_sweep(runs, scenario, folder / f"demand_sweep_{scenario}.png")
    return data
