const mode = new URLSearchParams(location.search).get("mode");
await import(
  mode === "tutor"
    ? "/ui/tutor-window.mjs?v=2.49"
    : mode === "translation"
      ? "/ui/translation-window.mjs?v=2.49"
      : "/app-v2.mjs?v=2.49"
);
