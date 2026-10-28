const mode = new URLSearchParams(location.search).get("mode");
await import(
  mode === "tutor"
    ? "/ui/tutor-window.mjs?v=2.45"
    : mode === "translation"
      ? "/ui/translation-window.mjs?v=2.45"
      : "/app-v2.mjs?v=2.45"
);
