"""Find the photos for a test scenario. Owner: Vince (B).

samples/ holds one subfolder per scenario (samples/vince/, samples/kenny/, ...),
each with 01.jpg, 02.jpg, ... in walking order. Pass a scenario folder directly,
or pass samples/ to use the first scenario folder that has photos.
"""
from pathlib import Path

EXTS = {".jpg", ".jpeg", ".png"}


def _images(folder: Path) -> list[Path]:
    return sorted(f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in EXTS)


def find_images(folder: str) -> list[Path]:
    root = Path(folder)
    if not root.is_dir():
        raise SystemExit(f"{folder}/ does not exist.")
    images = _images(root)
    if images:
        return images
    for sub in sorted(p for p in root.iterdir() if p.is_dir()):
        images = _images(sub)
        if images:
            print(f"Using scenario {sub}/ ({len(images)} photos). Pass a folder to pick another.")
            return images
    raise SystemExit(f"No photos in {folder}/ or its scenario subfolders.")
