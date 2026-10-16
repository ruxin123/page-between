import AppKit

let size = 1024
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: size * 4,
  bitsPerPixel: 32)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let context = NSGraphicsContext.current!.cgContext
context.translateBy(x: 0, y: CGFloat(size))
context.scaleBy(x: CGFloat(size) / 40, y: -CGFloat(size) / 40)
let rectangle = NSBezierPath(
  roundedRect: NSRect(x: 3, y: 3, width: 34, height: 34), xRadius: 6, yRadius: 6)
NSColor(srgbRed: 237 / 255, green: 242 / 255, blue: 235 / 255, alpha: 1).setFill()
rectangle.fill()
NSColor(srgbRed: 53 / 255, green: 105 / 255, blue: 75 / 255, alpha: 1).setStroke()
rectangle.lineWidth = 1.5
rectangle.stroke()
let lines = NSBezierPath()
for (start, end) in [
  (NSPoint(x: 13, y: 10), NSPoint(x: 13, y: 30)), (NSPoint(x: 27, y: 10), NSPoint(x: 27, y: 30)),
  (NSPoint(x: 18, y: 11), NSPoint(x: 22, y: 11)),
] {
  lines.move(to: start)
  lines.line(to: end)
}
lines.appendRect(NSRect(x: 18, y: 17, width: 5, height: 9))
lines.lineWidth = 1.4
lines.lineCapStyle = .round
lines.lineJoinStyle = .round
lines.stroke()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(
  to: URL(fileURLWithPath: CommandLine.arguments[1]))
