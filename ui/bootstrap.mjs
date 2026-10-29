const mode = new URLSearchParams(location.search).get("mode");
await import(
  mode === "tutor"
    ? "/ui/tutor-window.mjs?v=2.48"
    : mode === "translation"
      ? "/ui/translation-window.mjs?v=2.48"
      : "/app-v2.mjs?v=2.48"
);
