export function saveMargin(post, context, related) {
  return post("/api/margins", { ...context, operation: "save", id: crypto.randomUUID().replaceAll("-", ""), related });
}
