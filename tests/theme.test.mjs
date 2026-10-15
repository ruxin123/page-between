import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../layout.css", import.meta.url), "utf8");
const declarations = (block) =>
  Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  );
const base = declarations(css.match(/:root\s*\{([^}]+)\}/)[1]);
const luminance = (hex) => {
  const value = hex.slice(1);
  const full =
    value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  assert.match(full, /^[0-9a-f]{6}$/i);
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
    const channel = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return (
      sum +
      weight *
        (channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
for (const theme of ["paper", "sage", "blue", "night"]) {
  const override = css.match(
    new RegExp(`body\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`),
  );
  const tokens = { ...base, ...(override ? declarations(override[1]) : {}) };
  assert.ok(
    contrast(tokens["--ink"], tokens["--paper"]) >= 7,
    `${theme}: reading text meets AAA contrast.`,
  );
  for (const surface of ["--bg", "--surface", "--paper", "--rail"])
    assert.ok(
      contrast(tokens["--secondary"], tokens[surface]) >= 4.5,
      `${theme}: secondary text on ${surface} meets AA contrast.`,
    );
}
console.log("四种主题的正文 AAA、次要文字 AA 对比度：通过。");
