import sys
import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf_selection import align_spans, character_map, standalone_math, utf16


class Selection(unittest.TestCase):
    def test_damaged_formula_crop_uses_saved_character_geometry_and_never_recognizes_again(self):
        from reportlab.pdfgen import canvas
        from PIL import Image
        import pdf_enhancement as enhancement

        with tempfile.TemporaryDirectory() as temporary:
            pdf = Path(temporary) / "original.pdf"
            output = canvas.Canvas(str(pdf), pagesize=(240, 320), invariant=1)
            output.setFont("Courier", 12)
            output.drawString(24, 245, "Before x+y after")
            output.line(88.8, 256, 96, 256)
            output.save()
            raw = "Before x+y after"
            line = {"text": raw, "bbox": [.1, .195, .58, .245], "segments": [
                {"text": char, "bbox": [.1 + i * .03, .2, .1 + (i+1) * .03, .24]} for i, char in enumerate(raw)]}
            block = {"type": "text", "text": r"Before $x+\overline{y$ after", "bbox": [.1, .18, .9, .26]}
            with patch.object(enhancement, "source_path", return_value=pdf), patch.object(enhancement, "page_enrichment", return_value=[block]), patch.object(enhancement, "saved_selection", return_value={"lines": [line]}), patch.object(enhancement, "recognize_page", side_effect=AssertionError("Must not start OCR")):
                cropped = enhancement.formula_image({"id": "original"}, 1, r"x+\overline{y")
            self.assertTrue(cropped["src"].startswith("data:image/png;base64,"))
            with Image.open(io.BytesIO(base64.b64decode(cropped["src"].split(",")[1]))) as image:
                self.assertGreater(image.width, 20)
                self.assertGreater(image.height, 10)
                self.assertLess(min(image.convert("L").getdata()), 100)
            self.assertEqual([path.name for path in Path(temporary).iterdir()], ["original.pdf"])

    def test_unclosed_escape_run_is_not_a_complete_formula(self):
        self.assertIsNone(standalone_math("$" + "\\" * 4000))

    def test_math_only_text_blocks_are_whole_objects(self):
        text = r"$D_1 = \{x \in D \mid x \text{ has a predecessor}\}$;"
        groups = align_spans(
            [{"text": "D,={xeD | xhasa predecessor};", "bbox": [0.2, 0.2, 0.8, 0.24]}],
            [{"id": "line", "type": "text", "text": text, "bbox": [0.1, 0.18, 0.9, 0.25]}],
        )
        self.assertTrue(groups[0]["whole"])
        self.assertEqual(groups[0]["text"], text)
        self.assertEqual(groups[0]["spans"], [{"index": 0}])
        self.assertEqual(standalone_math(r"\[x^2\];"), "x^2;")
        self.assertEqual(standalone_math("$$x^2$$"), "x^2")
        self.assertIsNone(standalone_math("For $x$ and $y$, consider this."))
        self.assertIsNone(standalone_math("$x$ and $y$"))
        self.assertIsNone(standalone_math("$$x$$\n\nordinary text\n\n$$y$$"))
        self.assertIsNone(standalone_math(r"\[x\] prose \[y\]"))
        self.assertEqual(standalone_math(r"$\text{cost \$10}$"), r"\text{cost \$10}")

    def test_formula_and_table_are_whole_objects_even_when_ocr_text_does_not_match(
        self,
    ):
        groups = align_spans(
            [
                {"text": "x", "bbox": [0.2, 0.15, 0.3, 0.2]},
                {"text": "poor OCR", "bbox": [0.5, 0.15, 0.7, 0.2]},
                {"text": "first cell", "bbox": [0.2, 0.4, 0.4, 0.45]},
                {"text": "last cell", "bbox": [0.5, 0.5, 0.7, 0.55]},
                {"text": "Following functlon.", "bbox": [0.1, 0.7, 0.9, 0.75]},
            ],
            [
                {
                    "id": "math",
                    "type": "equation",
                    "text": r"x^2+y^2=r^2",
                    "bbox": [0.1, 0.1, 0.9, 0.25],
                },
                {
                    "id": "table",
                    "type": "table",
                    "text": "x\tf(x)\n1\t1\n2\t4",
                    "bbox": [0.1, 0.35, 0.9, 0.6],
                },
                {
                    "id": "after",
                    "type": "text",
                    "text": "Following function.",
                    "bbox": [0.1, 0.65, 0.9, 0.8],
                },
            ],
        )
        self.assertEqual([group["whole"] for group in groups[:2]], [True, True])
        self.assertEqual([span["index"] for span in groups[0]["spans"]], [0, 1])
        self.assertEqual([span["index"] for span in groups[1]["spans"]], [2, 3])
        self.assertEqual(groups[0]["text"], r"x^2+y^2=r^2")
        self.assertEqual(groups[1]["text"], "x\tf(x)\n1\t1\n2\t4")
        self.assertFalse(groups[2].get("whole"))
        self.assertTrue(groups[2]["spans"][0]["map"])
        missing = align_spans(
            [],
            [
                {
                    "id": "table",
                    "type": "table",
                    "text": "x\tf(x)",
                    "bbox": [0.1, 0.3, 0.8, 0.6],
                }
            ],
        )
        self.assertTrue(missing[0]["whole"])
        self.assertEqual(missing[0]["spans"], [])
        self.assertEqual(missing[0]["bbox"], [0.1, 0.3, 0.8, 0.6])

    def test_corrections_keep_geometry_offsets_and_chinese_boundaries(self):
        raw = "A functlon has a unique output."
        target = "A function has a unique output."
        mapping = character_map(raw, target)
        start = raw.index("functlon")
        interval = mapping[start : start + 8]
        self.assertEqual(
            target[min(x[0] for x in interval) : max(x[1] for x in interval)],
            "function",
        )
        raw = "定义：每个输入只有一亇输出。"
        target = "定义：每个输入只有一个输出。"
        mapping = character_map(raw, target)
        self.assertEqual(target[mapping[10][0] : mapping[10][1]], "个")
        self.assertIsNone(
            character_map("unrelated page header", "Every function has one output.")
        )

    def test_ligatures_and_emoji_use_browser_utf16_offsets(self):
        mapping = character_map("A deﬁnition 😀", "A definition 😀")
        self.assertEqual(len(mapping), utf16("A deﬁnition 😀"))
        self.assertEqual(mapping[4], [4, 6])
        self.assertEqual(mapping[-1], mapping[-2])

    def test_currency_and_all_formula_delimiters_keep_source_boundaries(self):
        value = "Cost $10, unchanged."
        mapping = character_map(value, value)
        dollar = value.index("$")
        self.assertEqual(mapping[dollar], [dollar, dollar + 1])
        for formula in [r"$\text{cost \$10}$", r"\(x^2\)", r"\[x^2\]", "$$x^2$$"]:
            target = "Observe " + formula + " in the original statement."
            mapping = character_map("Observe x in the original statement.", target)
            self.assertIsNotNone(mapping)
            start, end = mapping[8]
            self.assertEqual(target[start:end], formula)

    def test_tex_command_length_does_not_reject_correct_prose_alignment(self):
        raw = "Observe that @ ~ @ since @ C @ X @ is a relation on an empty set."
        target = (
            r"Observe that $\varnothing \sim \varnothing$ since "
            r"$\varnothing \subset \varnothing \times \varnothing$ "
            "is a relation on an empty set."
        )
        mapping = character_map(raw, target)
        self.assertIsNotNone(mapping)
        start = raw.index("@")
        interval = mapping[start : raw.index(" since")]
        bounds = [item for item in interval if item]
        self.assertEqual(
            target[min(x[0] for x in bounds) : max(x[1] for x in bounds)],
            r"$\varnothing \sim \varnothing$",
        )
        self.assertIsNone(character_map("Unrelated running page header", target))

    def test_blocks_do_not_mix_neighboring_columns_and_validate_spans(self):
        spans = [
            {"text": "A functlon", "bbox": [0.1, 0.1, 0.4, 0.2]},
            {"text": "Different text", "bbox": [0.6, 0.1, 0.9, 0.2]},
        ]
        blocks = [
            {
                "id": "left",
                "text": "A function",
                "type": "text",
                "bbox": [0.05, 0.05, 0.45, 0.4],
            },
            {
                "id": "right",
                "text": "Different text",
                "type": "text",
                "bbox": [0.55, 0.05, 0.95, 0.4],
            },
        ]
        groups = align_spans(spans, blocks)
        self.assertEqual(
            [group["text"] for group in groups], ["A function", "Different text"]
        )
        self.assertEqual([group["spans"][0]["index"] for group in groups], [0, 1])
        with self.assertRaises(ValueError):
            align_spans([{"text": "bad", "bbox": [0, float("nan"), 1, 1]}], blocks)


if __name__ == "__main__":
    unittest.main()
