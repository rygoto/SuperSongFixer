"""Turn a song file into SongFixer practice material.

    tools/.venv/Scripts/python tools/prepare_song.py songs/sora.flac --id sora --title "空も飛べるはず" --artist "スピッツ"

Writes to app/public/songs/<id>/:
    backing.mp3   the song with vocals removed (karaoke track)
    vocals.mp3    the separated vocal, for an optional guide voice
    song.json     reference melody as notes plus the raw pitch curve
and adds the song to app/public/songs/index.json.
"""

import argparse
import json
import time
from pathlib import Path

import lameenc
import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF
import torchcrepe
from demucs.apply import apply_model
from demucs.pretrained import get_model

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "app" / "public" / "songs"

CREPE_SR = 16000
HOP = 160  # 10 ms at 16 kHz
FMIN, FMAX = 65.0, 1100.0

# Voicing
SILENCE_DB = -60.0  # A-weighted; below this there is no voice to track

# Note segmentation
MIN_NOTE = 0.12  # seconds; shorter segments are scoops into the next note, not notes
SPLIT_SEMITONES = 0.6  # leave the running center by more than this and a new note starts
CONFIRM = 0.04  # ...but only if the new pitch holds for this long, so slides do not split
BRIDGE_GAP = 0.05  # unvoiced gaps this short inside one note are ignored
ATTACK = 0.05  # ignore this much of a note's start when deciding its pitch
ABSORB_SEMITONES = 2  # a short run further than this from its neighbour is not a scoop into it
OCTAVE_WIN = 0.8  # window used to spot a frame that jumped an octave away from the melody


def load_audio(path: Path) -> tuple[torch.Tensor, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return torch.from_numpy(data.T.copy()), sr


def separate(wav: torch.Tensor, sr: int, device: str) -> tuple[torch.Tensor, torch.Tensor, int]:
    model = get_model("htdemucs")
    model.to(device).eval()
    if sr != model.samplerate:
        wav = AF.resample(wav, sr, model.samplerate)
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    with torch.no_grad():
        sources = apply_model(model, ((wav - mean) / std)[None], device=device, shifts=1, split=True, overlap=0.25, progress=True)[0]
    sources = sources * std + mean
    vocals = sources[model.sources.index("vocals")]
    backing = sources.sum(0) - vocals
    return vocals.cpu(), backing.cpu(), model.samplerate


def write_mp3(path: Path, wav: torch.Tensor, sr: int, kbps: int = 192) -> None:
    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(sr)
    enc.set_channels(wav.shape[0])
    enc.set_quality(2)
    pcm = (wav.clamp(-1, 1).T.numpy() * 32767).astype(np.int16)
    path.write_bytes(enc.encode(pcm.tobytes()) + enc.flush())


def repair_octaves(midi: np.ndarray) -> np.ndarray:
    """Pull frames that sit a whole octave off the surrounding melody back into line.

    CREPE occasionally locks onto a harmonic for a few frames. A median over most of
    a second sees the real melodic line straight through such a blip.
    """
    w = int(round(OCTAVE_WIN / (HOP / CREPE_SR))) | 1
    pad = np.pad(midi, w // 2, constant_values=np.nan)
    with np.errstate(all="ignore"):
        center = np.nanmedian(np.lib.stride_tricks.sliding_window_view(pad, w), axis=1)
    folded = midi + 12 * np.round((center - midi) / 12)
    fix = ~np.isnan(center) & (np.abs(midi - center) > 6) & (np.abs(folded - center) <= 3)
    out = midi.copy()
    out[fix] = folded[fix]
    return out


def pitch_curve(vocals: torch.Tensor, sr: int, device: str) -> np.ndarray:
    """Per 10 ms frame MIDI pitch of the vocal, NaN where there is no clear voice."""
    mono = AF.resample(vocals.mean(0, keepdim=True), sr, CREPE_SR)
    pitch, periodicity = torchcrepe.predict(
        mono, CREPE_SR, HOP, FMIN, FMAX, model="full",
        return_periodicity=True, batch_size=2048, device=device,
    )
    periodicity = torchcrepe.filter.median(periodicity.cpu(), 3)
    # Separation leaves faint bleed in quiet passages, so gate on loudness too.
    periodicity = torchcrepe.threshold.Silence(SILENCE_DB)(periodicity, mono.cpu(), CREPE_SR, HOP)
    # Hysteresis holds a note through a dip in confidence but will not start one on a breath.
    pitch = torchcrepe.threshold.Hysteresis()(pitch.cpu(), periodicity)
    pitch = torchcrepe.filter.mean(pitch, 3)  # nan-aware

    midi = (69 + 12 * torch.log2(pitch[0] / 440)).numpy()
    return repair_octaves(midi)


FRAME = HOP / CREPE_SR


def _steady(seg: list[float]) -> list[float]:
    """A note's pitch is decided from its body; the scoop at the start is not the note."""
    cut = min(len(seg) - 1, round(ATTACK / FRAME)) if len(seg) > 1 else 0
    return seg[cut:]


def segment_notes(midi: np.ndarray) -> list[dict]:
    bridge = round(BRIDGE_GAP / FRAME)
    confirm = max(1, round(CONFIRM / FRAME))

    def holds(i: int, center: float) -> bool:
        """True if the pitch really has moved, rather than passing through on a slide."""
        seen = 0
        for j in range(i, min(len(midi), i + confirm * 3)):
            if np.isnan(midi[j]):
                continue
            if abs(midi[j] - center) <= SPLIT_SEMITONES:
                return False
            seen += 1
            if seen >= confirm:
                return True
        return seen > 0

    raw: list[dict] = []
    seg: list[float] = []
    start = gap = 0

    def close(end: int) -> None:
        if seg:
            raw.append({"s": start, "e": end, "m": int(round(float(np.median(_steady(seg)))))})

    for i, m in enumerate(midi):
        if np.isnan(m):
            if seg:
                gap += 1
                if gap > bridge:
                    close(i - gap + 1)
                    seg, gap = [], 0
            continue
        if seg and abs(m - np.median(_steady(seg)[-30:])) > SPLIT_SEMITONES and holds(i, float(np.median(_steady(seg)[-30:]))):
            close(i - gap)
            seg = []
        if not seg:
            start = i
        seg.append(float(m))
        gap = 0
    if seg:
        close(len(midi) - gap)

    # A too-short run is a scoop or a passing tone: give its time to the neighbour it
    # slid from or into, rather than letting it stand as a note of its own.
    kept: list[dict] = []
    for i, n in enumerate(raw):
        if (n["e"] - n["s"]) * FRAME >= MIN_NOTE:
            kept.append(n)
            continue
        prev = kept[-1] if kept else None
        nxt = raw[i + 1] if i + 1 < len(raw) else None
        options = []
        if prev and (n["s"] - prev["e"]) * FRAME <= BRIDGE_GAP and abs(prev["m"] - n["m"]) <= ABSORB_SEMITONES:
            options.append((abs(prev["m"] - n["m"]), "prev"))
        if nxt and (nxt["s"] - n["e"]) * FRAME <= BRIDGE_GAP and abs(nxt["m"] - n["m"]) <= ABSORB_SEMITONES:
            options.append((abs(nxt["m"] - n["m"]), "next"))
        if not options:
            continue  # a stray blip far from anything: not part of a note
        if min(options)[1] == "prev":
            prev["e"] = n["e"]  # type: ignore[index]
        else:
            nxt["s"] = n["s"]  # type: ignore[index]

    # Rejoin repeats of one pitch split only by a tiny gap
    merged: list[dict] = []
    for n in kept:
        p = merged[-1] if merged else None
        if p and p["m"] == n["m"] and (n["s"] - p["e"]) * FRAME < 0.08:
            p["e"] = n["e"]
        else:
            merged.append(dict(n))
    return [{"t": round(n["s"] * FRAME, 3), "d": round((n["e"] - n["s"]) * FRAME, 3), "m": n["m"]} for n in merged]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path)
    ap.add_argument("--id", required=True, help="folder name, ASCII")
    ap.add_argument("--title", required=True)
    ap.add_argument("--artist", default="")
    ap.add_argument("--vocals", type=Path, help="clean vocal-only file; skips separation for the melody")
    ap.add_argument("--reuse", action="store_true", help="re-read the stems written last time instead of separating again")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    out = OUT_ROOT / args.id
    out.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    if args.reuse and (out / "vocals.mp3").exists():
        vocals, msr = load_audio(out / "vocals.mp3")
        print(f"reusing stems in {out}")
    else:
        wav, sr = load_audio(args.audio)
        print(f"loaded {wav.shape[1] / sr:.1f}s at {sr} Hz, separating on {device}")
        vocals, backing, msr = separate(wav, sr, device)
        print(f"separated in {time.time() - t0:.1f}s")
        write_mp3(out / "backing.mp3", backing, msr)
        write_mp3(out / "vocals.mp3", vocals, msr, kbps=128)

    if args.vocals:
        # A real vocal-only track has no separation artifacts, so the melody comes
        # out far cleaner. The karaoke track still comes from separation.
        vocals, vsr = load_audio(args.vocals)
        if vsr != msr:
            vocals = AF.resample(vocals, vsr, msr)
        print(f"melody from {args.vocals.name}")

    t1 = time.time()
    midi = pitch_curve(vocals, msr, device)
    notes = segment_notes(midi)
    print(f"pitch tracked in {time.time() - t1:.1f}s: {len(notes)} notes")

    curve = [None if np.isnan(m) else round(float(m), 2) for m in midi]
    song = {
        "id": args.id,
        "title": args.title,
        "artist": args.artist,
        "duration": round(vocals.shape[1] / msr, 3),
        "notes": notes,
        "pitch": {"hop": HOP / CREPE_SR, "midi": curve},
    }
    (out / "song.json").write_text(json.dumps(song, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    index_path = OUT_ROOT / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    index = [s for s in index if s["id"] != args.id]
    index.append({"id": args.id, "title": args.title, "artist": args.artist})
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"done in {time.time() - t0:.1f}s -> {out}")


if __name__ == "__main__":
    main()
