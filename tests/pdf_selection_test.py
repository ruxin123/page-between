import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf_selection import align_spans, character_map, utf16


class Selection(unittest.TestCase):
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
