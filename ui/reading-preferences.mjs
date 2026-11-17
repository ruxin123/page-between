export const typographyPresets = {
  immersive: { title: "沉浸", fontSize: 20, lineHeight: 1.8, paragraphSpace: .9, headingSpace: 1.6 },
  spacious: { title: "舒展", fontSize: 21, lineHeight: 1.95, paragraphSpace: 1.15, headingSpace: 2 },
  compact: { title: "紧凑", fontSize: 19, lineHeight: 1.7, paragraphSpace: .65, headingSpace: 1.2 },
};

export function selectedTypography(preferences) {
  return Object.entries(typographyPresets).find(([, preset]) =>
    ["fontSize", "lineHeight", "paragraphSpace", "headingSpace"].every(key => preferences[key] === preset[key]),
  )?.[0];
}

export function readingPreferences(global, perBook, book, reading) {
  if (!reading || !book) return global;
  const { palmKeys, pinnedTool1, pinnedTool2, ...overrides } = perBook[book.id] || {};
  return { ...global, ...overrides };
}
