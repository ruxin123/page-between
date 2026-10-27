await import(
  new URLSearchParams(location.search).get("mode") === "tutor"
    ? "/ui/tutor-window.mjs?v=2.41"
    : "/app-v2.mjs?v=2.41"
);
