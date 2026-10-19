export function copyPng(source) {
  const blob = (async () => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("无法准备图片。")),
        "image/png",
      ),
    );
  })();
  // WebKit requires write() during the click; image decoding can finish afterwards.
  return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
