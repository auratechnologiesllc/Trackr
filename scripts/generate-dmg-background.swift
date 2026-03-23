import AppKit

let fileManager = FileManager.default
let workspaceURL = URL(fileURLWithPath: fileManager.currentDirectoryPath)
let outputURL = workspaceURL.appendingPathComponent("src-tauri/icons/dmg-background.png")

// Must match windowSize in tauri.conf.json exactly (Finder uses pixel dimensions)
let width: CGFloat = 660
let height: CGFloat = 400

// Icon center positions from tauri.conf.json (Finder y = from top)
// applicationFolderPosition: (180, 170)
// appPosition:               (480, 170)
let folderX: CGFloat = 180
let appX: CGFloat = 480
let iconY: CGFloat = 170  // from top

// CG coords: y from bottom
let iconYCG: CGFloat = height - iconY

guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(width),
  pixelsHigh: Int(height),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("Could not allocate bitmap.\n", stderr)
  exit(1)
}

guard let graphicsContext = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fputs("Could not create graphics context.\n", stderr)
  exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphicsContext
let ctx = graphicsContext.cgContext
let cs = CGColorSpaceCreateDeviceRGB()

// --- Background: light gradient ---
let bg = CGGradient(
  colorsSpace: cs,
  colors: [
    CGColor(colorSpace: cs, components: [0.95, 0.97, 0.95, 1.0])!,
    CGColor(colorSpace: cs, components: [0.97, 0.97, 0.98, 1.0])!,
  ] as CFArray,
  locations: [0.0, 1.0]
)!
ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: height), end: CGPoint(x: 0, y: 0), options: [])

// --- Subtle green glow top-left ---
let glow = CGGradient(
  colorsSpace: cs,
  colors: [
    CGColor(colorSpace: cs, components: [0.78, 0.93, 0.86, 0.22])!,
    CGColor(colorSpace: cs, components: [0.78, 0.93, 0.86, 0.0])!,
  ] as CFArray,
  locations: [0.0, 1.0]
)!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 0, y: height), startRadius: 0, endCenter: CGPoint(x: 0, y: height), endRadius: 300, options: [])

// --- Dashed arrow between icons ---
// Icons are ~128px wide, leave clearance
let arrowLeft = folderX + 70
let arrowRight = appX - 70

let arrowColor = CGColor(colorSpace: cs, components: [0.50, 0.50, 0.52, 0.45])!
ctx.setStrokeColor(arrowColor)
ctx.setLineWidth(1.5)
ctx.setLineDash(phase: 0, lengths: [6, 5])
ctx.move(to: CGPoint(x: arrowLeft + 10, y: iconYCG))
ctx.addLine(to: CGPoint(x: arrowRight, y: iconYCG))
ctx.strokePath()

// Arrowhead pointing right (toward the app)
ctx.setLineDash(phase: 0, lengths: [])
ctx.setFillColor(arrowColor)
let hs: CGFloat = 7
ctx.move(to: CGPoint(x: arrowRight, y: iconYCG))
ctx.addLine(to: CGPoint(x: arrowRight - hs, y: iconYCG + hs * 0.6))
ctx.addLine(to: CGPoint(x: arrowRight - hs, y: iconYCG - hs * 0.6))
ctx.closePath()
ctx.fillPath()

// Also arrowhead pointing left (toward Applications)
ctx.move(to: CGPoint(x: arrowLeft, y: iconYCG))
ctx.addLine(to: CGPoint(x: arrowLeft + hs, y: iconYCG + hs * 0.6))
ctx.addLine(to: CGPoint(x: arrowLeft + hs, y: iconYCG - hs * 0.6))
ctx.closePath()
ctx.fillPath()

// --- Label below the icons ---
let paragraphStyle = NSMutableParagraphStyle()
paragraphStyle.alignment = .center

let labelFont = NSFont.systemFont(ofSize: 12, weight: .regular)
let labelColor = NSColor(red: 0.42, green: 0.42, blue: 0.44, alpha: 0.65)
let labelAttrs: [NSAttributedString.Key: Any] = [
  .font: labelFont,
  .foregroundColor: labelColor,
  .paragraphStyle: paragraphStyle,
]
let label: NSString = "Drag Trackr to Applications"
let labelSize = label.size(withAttributes: labelAttrs)

// Position below icons: iconY(from top)=170, icon half-height≈64, label offset≈20
let labelFromTop: CGFloat = iconY + 80
let labelYCG = height - labelFromTop - labelSize.height

let labelRect = NSRect(
  x: (width - labelSize.width) / 2,
  y: labelYCG,
  width: labelSize.width,
  height: labelSize.height
)
label.draw(in: labelRect, withAttributes: labelAttrs)

NSGraphicsContext.restoreGraphicsState()

guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Could not encode PNG.\n", stderr)
  exit(1)
}

try pngData.write(to: outputURL)
print("Wrote \(outputURL.path) (\(Int(width))x\(Int(height)))")
