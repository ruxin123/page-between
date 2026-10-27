"""Check actual OCR against independently rendered pixels of original scan samples.

Run on macOS. An optional first argument selects a frozen App's OCR helper.
Text similarity is reported separately; a geometry pass does not promise perfect OCR.
"""

import io
import json
from pathlib import Path
import re
import subprocess
import sys
from difflib import SequenceMatcher
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
import pypdfium2 as pdfium
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import pdf_enhancement as ocr


def compact(value):
    return re.sub(r"\s+", "", value).casefold()


def run():
    destination = ROOT / "qa/ocr-geometry"
    destination.mkdir(parents=True, exist_ok=True)
    helper = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else destination / "ocr-current"
    if len(sys.argv) == 1 and (not helper.exists() or helper.stat().st_mtime < (ROOT / "native/OCR.swift").stat().st_mtime):
        subprocess.run(["swiftc", "-O", str(ROOT / "native/OCR.swift"), "-o", str(helper)], check=True)
    ocr.OCR = helper
    fonts = {
        "zh": ImageFont.truetype(str(ROOT / "assets/fonts/han-serif.otf"), 44),
        "en": ImageFont.truetype("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 44),
    }
    texts = {
        "zh": ["第一行：这是用于检查文字坐标的原创样本。", "第二行：集合与映射之间存在明确的关系。", "第三行：先理解定义，再阅读后面的证明。"],
        "en": ["First line: precise selection follows the visible text.", "Second line: every mapping has a domain and a range.", "Third line: read the definition before the proof."],
    }
    cases = []
    for language, lines in texts.items():
        placements = [(line, 240, 450 + i * 160) for i, line in enumerate(lines)]
        for cropped, rotation in [(False, 0), (True, 0), (True, 90), (True, 180), (True, 270)]:
            cases.append((f"{language}-crop{int(cropped)}-r{rotation}", language, placements, cropped, rotation, False))
    mixed = [(texts["zh"][0], 240, 450), (texts["en"][1], 240, 610), (texts["zh"][2], 240, 770)]
    cases.append(("mixed", "zh", mixed, False, 0, False))
    for language in ["zh", "en"]:
        left = ["左栏第一行：原创文字样本。", "左栏第二行：保持正确顺序。", "左栏第三行：然后读右栏。"] if language == "zh" else ["Left column one stays separate.", "Left column two follows it.", "Left column three ends here."]
        right = ["右栏第一行：接着阅读这里。", "右栏第二行：不会混入左栏。", "右栏第三行：结束本段阅读。"] if language == "zh" else ["Right column one begins here.", "Right column two is next.", "Right column three ends here."]
        placements = [(line, x, 450 + i * 160) for x, lines in [(120, left), (980, right)] for i, line in enumerate(lines)]
        cases.append((language + "-columns", language, placements, False, 0, False))
    cases.append(("empty", "en", [], False, 0, False))
    cases.append(("low-resolution", "en", [(line, 240, 450 + i * 160) for i, line in enumerate(texts["en"])], False, 0, True))
    results = []
    for name, language, placements, cropped, rotation, low_resolution in cases:
        image = Image.new("RGB", (1800, 2400), "white")
        draw = ImageDraw.Draw(image)
        oracles = []
        for text, x, y in placements:
            font = fonts["zh" if re.search(r"[\u4e00-\u9fff]", text) else "en"]
            draw.text((x, y), text, font=font, fill="black")
            oracles.append((text, draw.textbbox((x, y), text, font=font), [x + draw.textlength(text[:i], font=font) for i in range(len(text) + 1)]))
        if low_resolution:
            image = image.resize((360, 480)).resize(image.size)
        bitmap = image.rotate(rotation, expand=True)
        w, h = bitmap.size
        stream = io.BytesIO()
        pdf = canvas.Canvas(stream, pagesize=(w / 3, h / 3), invariant=1)
        pdf.drawImage(ImageReader(bitmap), 0, 0, w / 3, h / 3)
        pdf.save()
        page = PdfReader(stream).pages[0]
        if cropped:
            page.cropbox.lower_left, page.cropbox.upper_right = (60, 60), (w / 3 - 60, h / 3 - 60)
        if rotation:
            page.rotate(rotation)
        path = destination / (name + ".pdf")
        writer = PdfWriter()
        writer.add_page(page)
        writer.write(path)
        document = pdfium.PdfDocument(path)
        original = document[0]
        rendered = original.render(scale=3)
        reference = rendered.to_pil().convert("RGB")
        rendered.close()
        original.close()
        document.close()
        reference.save(destination / (name + ".png"))
        w, h = reference.size
        assert (w, h) == ((1440, 2040) if cropped else (1800, 2400))
        mask = reference.convert("L").point(lambda pixel: 255 if pixel < 180 else 0)
        expected = []
        shift = 180 if cropped else 0
        for text, bounds, positions in oracles:
            x0, y0, x1, y1 = bounds
            # This oracle uses the source font and PDFium's actual pixels, not OCR boxes.
            region = (max(0, x0 - shift - 6), max(0, y0 - shift - 6), min(w, x1 - shift + 6), min(h, y1 - shift + 6))
            ink = mask.crop(region).getbbox()
            assert ink, name
            box = [(region[0] + ink[0]) / w, (region[1] + ink[1]) / h, (region[0] + ink[2]) / w, (region[1] + ink[3]) / h]
            expected.append({"text": text, "bbox": box, "positions": [(position - shift) / w for position in positions]})
        with patch.object(ocr, "source_path", return_value=path):
            data = ocr.recognize_page({"id": "original-scan"}, 1, "full", language == "en")
        assert data["width"] * data["height"] <= 8_010_000 and max(data["width"], data["height"]) <= 8192
        (destination / (name + ".json")).write_text(json.dumps(data, ensure_ascii=False))
        (destination / (name + "-oracle.json")).write_text(json.dumps({"language": language, "lines": expected, "qualityOnly": low_resolution}, ensure_ascii=False))
        measurements = []
        for line in expected:
            candidate = max(data["lines"], key=lambda value: SequenceMatcher(None, compact(line["text"]), compact(value["text"])).ratio(), default=None)
            score, error = 0, 1
            if candidate:
                score = SequenceMatcher(None, compact(line["text"]), compact(candidate["text"])).ratio()
                box, target = candidate["bbox"], line["bbox"]
                error = max(abs((box[0] + box[2] - target[0] - target[2]) / 2), abs((box[1] + box[3] - target[1] - target[3]) / 2))
            measurements.append({"similarity": score, "centerError": error})
        correct_order = [compact(line["text"]) for line in data["lines"]]
        order = [max(range(len(expected)), key=lambda i: SequenceMatcher(None, value, compact(expected[i]["text"])).ratio()) for value in correct_order] if expected else []
        passed = all(value["similarity"] > .85 and value["centerError"] < .02 for value in measurements)
        if not expected:
            passed = not data["lines"]
        if name.endswith("columns"):
            passed = passed and order == list(range(6))
        result = {"fixture": name, "geometryPass": passed, "qualityOnly": low_resolution, "measurements": measurements, "order": order}
        results.append(result)
        print(json.dumps(result), flush=True)
    (destination / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    assert all(result["geometryPass"] for result in results if not result["qualityOnly"])


if __name__ == "__main__":
    run()
