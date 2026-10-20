export async function prepareQuestionImage(source, book) {
  const url = new URL(source, window.location.href);
  const local =
    url.origin === window.location.origin &&
    ["/data/books/", "/demo-data/books/"].some((prefix) =>
      url.pathname.startsWith(prefix + book + "/"),
    );
  if (
    !local &&
    !/^data:image\/(?:(?:png|jpeg|gif|webp);base64,|svg\+xml;charset=utf-8,)/.test(
      source,
    )
  )
    throw new Error("请从当前书籍中重新选择原图。");
  const image = new Image();
  image.src = url.href;
  await image.decode();
  const scale = Math.min(
    1,
    2048 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = (type, quality) =>
    new Promise((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("暂时无法准备原图。")),
        type,
        quality,
      ),
    );
  let result = await blob("image/png");
  if (result.size > 4 * 1024 ** 2) {
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    result = await blob("image/jpeg", 0.92);
  }
  if (result.size > 4 * 1024 ** 2)
    throw new Error("原图超过 4 MB，请缩小选取范围。");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("暂时无法读取原图。"));
    reader.readAsDataURL(result);
  });
}
