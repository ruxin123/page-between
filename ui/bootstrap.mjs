const mode = new URLSearchParams(location.search).get("mode");
await import(
  mode === "tutor"
    ? "/ui/tutor-window.mjs?v=2.53"
    : mode === "translation"
      ? "/ui/translation-window.mjs?v=2.53"
      : "/app-v2.mjs?v=2.53"
);
