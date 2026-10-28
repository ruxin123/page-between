export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  translate:
    "M3 5h12M9 3v2M5 8c1 4 4 7 8 9M13 5c0 6-4 10-9 12M14 21l4-11 4 11M15.5 17h5",
  swap: "M3 7h16l-4-4M21 17H5l4 4",
  check: "M5 12l4 4L19 6",
  warning: "M12 3L2 21h20zM12 9v5M12 18h.1",
  library: "M4 4h6v16H4zM14 4h6v16h-6zM4 8h6M14 8h6",
  shelf: "M4 4v16h16V4M4 13h16M8 5v8M12 7v6M16 5v8",
  import: "M12 3v12M7 10l5 5 5-5M4 16v5h16v-5",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  search: "M21 21l-5-5M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  toc: "M8 5h12M8 12h12M8 19h12M3 5h.1M3 12h.1M3 19h.1",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  palm: "M7 2h10v20H7zM10 18h4",
  focus: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  more: "M5 12h.1M12 12h.1M19 12h.1",
  close: "M6 6l12 12M18 6L6 18",
  copy: "M8 8h12v13H8zM16 8V3H3v13h5",
  image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 5M17 8h.1",
  ask: "M4 4h16v12H9l-5 4zM8 8h8M8 12h5",
  timer: "M9 2h6M12 8v5l3 2M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16",
  star: "M12 3l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.6l-5.7 3 1.1-6.4L2.8 9.7l6.4-.9z",
  pages: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3zM12 6v16",
  scroll: "M7 3h10v18H7zM10 7h4M10 11h4M10 15h4",
  pin: "M8 3h8l-1 7 4 4H5l4-4zM12 14v8",
};
export const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || paths.library}"></path></svg>`;
