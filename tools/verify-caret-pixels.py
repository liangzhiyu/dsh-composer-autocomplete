"""Check native caret pixels in screenshots from caret-smoke.mjs; requires Pillow."""
import json
import math
from pathlib import Path
import re
import sys

from PIL import Image

source = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/caret-results.json")
report = json.loads(source.read_text())
results = []
for shot in report["screenshots"]:
    expected = tuple(map(int, re.findall(r"\d+", shot["caretColor"])[:3]))
    assert len(expected) == 3, "Expected an opaque native caret color"
    scale = shot["scale"]
    with Image.open(source.parent / shot["file"]) as image:
        image = image.convert("RGB")
        left = max(0, math.floor((shot["x"] - 1.5) * scale))
        right = min(image.width, math.ceil((shot["x"] + 1.5) * scale))
        top = max(0, math.floor(shot["y"] * scale))
        bottom = min(image.height, math.ceil((shot["y"] + shot["height"]) * scale))
        pixels = sum(
            max(abs(a - b) for a, b in zip(image.getpixel((x, y)), expected)) <= 12
            for y in range(top, bottom) for x in range(left, right)
        )
    assert pixels >= max(3, shot["height"] * scale / 2), f"Caret is obscured: {shot['file']} ({pixels} pixels)"
    results.append({"file": shot["file"], "nativeCaretPixels": pixels})
    print(f"PASS {shot['file']}: {pixels} native caret pixels")
source.with_name(source.stem + "-pixels.json").write_text(json.dumps(results, indent=2) + "\n")
