"""Score the quality of an extracted melody without needing to hear it.

    tools/.venv/Scripts/python tools/check_song.py sora

Every number here is checkable by machine, so a bad extraction shows up as a bad
number rather than as something you have to catch by ear. Pass two song.json
paths to compare a change against a baseline.
"""

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MAJOR = [0, 2, 4, 5, 7, 9, 11]
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def load(arg: str) -> dict:
    p = Path(arg)
    if not p.exists():
        p = ROOT / "app" / "public" / "songs" / arg / "song.json"
    return json.loads(p.read_text(encoding="utf-8"))


def key_fit(notes: list[dict]) -> tuple[str, float]:
    """Best-fitting major scale, and the share of sung time that lands in it.

    A melody extracted correctly sits almost entirely inside one scale, so a low
    share means wrong pitches, not unusual music.
    """
    weight = Counter()
    for n in notes:
        weight[n["m"] % 12] += n["d"]
    total = sum(weight.values()) or 1.0
    best, best_share = 0, 0.0
    for tonic in range(12):
        scale = {(tonic + s) % 12 for s in MAJOR}
        share = sum(w for pc, w in weight.items() if pc in scale) / total
        if share > best_share:
            best, best_share = tonic, share
    return NAMES[best], best_share


ATTACK = 0.06  # the scoop into a note is not judged, here or in the app


def frames_of(song: dict, n: dict) -> np.ndarray:
    hop = song["pitch"]["hop"]
    curve = song["pitch"]["midi"]
    a, b = int(round((n["t"] + ATTACK) / hop)), int(round((n["t"] + n["d"]) / hop))
    if b - a < 2:
        a = int(round(n["t"] / hop))
    vals = [curve[i] for i in range(max(0, a), min(len(curve), b)) if curve[i] is not None]
    return np.array(vals, dtype=float)


def octave_suspects(notes: list[dict]) -> list[dict]:
    """Notes that leap about an octave away from their neighbours and straight back."""
    out = []
    for i in range(1, len(notes) - 1):
        prev, cur, nxt = notes[i - 1]["m"], notes[i]["m"], notes[i + 1]["m"]
        if abs(prev - nxt) <= 4 and 9 <= abs(cur - prev) <= 15 and 9 <= abs(cur - nxt) <= 15:
            out.append(notes[i])
    return out


def report(song: dict, label: str) -> dict:
    notes = song["notes"]
    hop = song["pitch"]["hop"]
    curve = song["pitch"]["midi"]
    durs = np.array([n["d"] for n in notes])

    # How tightly each note's own frames sit on the pitch it was given.
    devs, unstable = [], 0
    for n in notes:
        f = frames_of(song, n)
        if f.size == 0:
            continue
        d = np.abs(f - n["m"]) * 100
        devs.append(np.median(d))
        if np.percentile(d, 90) > 100:  # a semitone of spread inside one note
            unstable += 1
    devs = np.array(devs) if devs else np.array([0.0])

    voiced = sum(1 for v in curve if v is not None)
    covered = sum(
        1
        for n in notes
        for i in range(max(0, int(round(n["t"] / hop))), min(len(curve), int(round((n["t"] + n["d"]) / hop))))
        if curve[i] is not None
    )
    tonic, share = key_fit(notes)
    susp = octave_suspects(notes)

    m = {
        "notes": len(notes),
        "median_dur": float(np.median(durs)),
        "short": int((durs < 0.12).sum()),
        "short_pct": float((durs < 0.12).mean() * 100),
        "median_dev_cents": float(np.median(devs)),
        "p90_dev_cents": float(np.percentile(devs, 90)),
        "unstable": unstable,
        "unstable_pct": unstable / max(1, len(notes)) * 100,
        "voiced_captured_pct": covered / max(1, voiced) * 100,
        "key": f"{tonic} major",
        "in_key_pct": share * 100,
        "octave_suspects": len(susp),
    }

    print(f"--- {label} ---")
    print(f"ノート数           {m['notes']}   中央値 {m['median_dur']:.2f}s")
    print(f"短すぎるノート     {m['short']} 個 ({m['short_pct']:.1f}%)   ← 小さいほど良い")
    print(f"ノート内のズレ     中央値 {m['median_dev_cents']:.0f} セント / 上位10% {m['p90_dev_cents']:.0f} セント   ← 小さいほど良い")
    print(f"ゆれの大きいノート {m['unstable']} 個 ({m['unstable_pct']:.1f}%)   ← 小さいほど良い")
    print(f"有声フレームの回収 {m['voiced_captured_pct']:.1f}%   ← 大きいほど良い")
    print(f"推定キー           {m['key']}   音階内 {m['in_key_pct']:.1f}%   ← 大きいほど良い（95%超えたい）")
    print(f"オクターブ誤り疑い {m['octave_suspects']} 個   ← 0 にしたい")
    if susp:
        print("   " + ", ".join(f"{n['t']:.1f}s:{NAMES[n['m'] % 12]}{n['m'] // 12 - 1}" for n in susp[:12]))
    print()
    return m


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("song", help="song id, or a path to song.json")
    ap.add_argument("baseline", nargs="?", help="another song.json to compare against")
    args = ap.parse_args()

    new = report(load(args.song), "いま")
    if args.baseline:
        old = report(load(args.baseline), "before")
        print("--- 変化 (before → いま) ---")
        for k, better in [
            ("short_pct", "down"), ("median_dev_cents", "down"), ("p90_dev_cents", "down"),
            ("unstable_pct", "down"), ("voiced_captured_pct", "up"), ("in_key_pct", "up"),
            ("octave_suspects", "down"), ("notes", None),
        ]:
            a, b = old[k], new[k]
            mark = "" if better is None else (" ✓" if (b < a if better == "down" else b > a) else (" =" if a == b else " ✗"))
            print(f"{k:22} {a:8.1f} → {b:8.1f}{mark}")


if __name__ == "__main__":
    main()
