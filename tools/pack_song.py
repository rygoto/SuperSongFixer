"""Bundle a prepared song into one zip to copy onto the phone.

    python tools/pack_song.py sora

Reads app/public/songs/<id>/ and writes songs/packs/<id>.zip. In the app, "曲を追加"
stores the zip on the phone itself, so the deployed site never carries any music.
Needs only the standard library; prepare_song.py also runs this at the end.
"""

import argparse
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "app" / "public" / "songs"
PACKS = ROOT / "songs" / "packs"
FILES = ("song.json", "backing.mp3", "vocals.mp3")


def pack(song_id: str) -> Path:
    src = SONGS / song_id
    if not (src / "song.json").exists() or not (src / "backing.mp3").exists():
        raise SystemExit(f"{src} に song.json と backing.mp3 がありません")
    PACKS.mkdir(parents=True, exist_ok=True)
    out = PACKS / f"{song_id}.zip"
    with zipfile.ZipFile(out, "w") as z:
        for name in FILES:
            f = src / name
            if f.exists():
                # MP3 is already compressed; only the JSON gains from deflate.
                z.write(f, name, zipfile.ZIP_DEFLATED if name.endswith(".json") else zipfile.ZIP_STORED)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", help="song ids; all prepared songs if omitted")
    args = ap.parse_args()
    ids = args.ids or sorted(p.name for p in SONGS.iterdir() if (p / "song.json").exists())
    for song_id in ids:
        out = pack(song_id)
        print(f"{out}  ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
