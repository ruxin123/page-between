// Small, session-only page previews cover redraws without retaining full-size canvases.
export class PdfPreviewCache {
  constructor({ limit = 12, pixels = 250000 } = {}) {
    this.limit = limit;
    this.pixels = pixels;
    this.pages = new Map();
  }
  use(document) {
    if (this.document === document) return;
    this.clear();
    this.document = document;
  }
  clear() {
    for (const canvas of this.pages.values()) canvas.width = canvas.height = 0;
    this.pages.clear();
    this.document = null;
  }
  remember(index, source) {
    if (this.pages.has(index) || !source.width || !source.height) return;
    const scale = Math.min(
      1,
      Math.sqrt(this.pixels / (source.width * source.height)),
    );
    const canvas = source.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(source.width * scale));
    canvas.height = Math.min(
      Math.max(1, Math.floor(source.height * scale)),
      Math.floor(this.pixels / canvas.width),
    );
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    try {
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
    } catch {
      canvas.width = canvas.height = 0;
      return;
    }
    this.pages.set(index, canvas);
    while (this.pages.size > this.limit) {
      const first = this.pages.keys().next().value,
        retired = this.pages.get(first);
      this.pages.delete(first);
      retired.width = retired.height = 0;
    }
  }
  show(index, root) {
    if (root.querySelector("canvas")) return false;
    const source = this.pages.get(index);
    if (!source?.width) return false;
    this.pages.delete(index);
    this.pages.set(index, source);
    const canvas = root.ownerDocument.createElement("canvas");
    canvas.className = "pdf-preview";
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return false;
    try {
      context.drawImage(source, 0, 0);
    } catch {
      canvas.width = canvas.height = 0;
      return false;
    }
    root.prepend(canvas);
    return true;
  }
}
