import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(__dirname, 'app-icon-source.png')

const size = 1024
const pixels = Buffer.alloc(size * size * 4)

const BG = [246, 245, 241]
const GLYPH = [161, 8, 8]

const containerRadius = 224
const bookmarkTopY = 250
const bookmarkBottomY = 774
const bookmarkLeftX = 360
const bookmarkRightX = 664
const bookmarkCornerRadius = 34
const bookmarkNotchDepth = 96

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= size || y < 0 || y >= size) return
  const i = ((y * size) + x) * 4
  const alpha = a / 255
  pixels[i] = Math.round((r * alpha) + (pixels[i] * (1 - alpha)))
  pixels[i + 1] = Math.round((g * alpha) + (pixels[i + 1] * (1 - alpha)))
  pixels[i + 2] = Math.round((b * alpha) + (pixels[i + 2] * (1 - alpha)))
  pixels[i + 3] = 255
}

// AA coverage of a point (x + 0.5, y + 0.5) inside a filled shape defined by inside(px, py).
function coverage(inside, x, y) {
  let hits = 0
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      if (inside(x + ((sx + 0.5) / 4), y + ((sy + 0.5) / 4))) hits += 1
    }
  }
  return hits / 16
}

function fillShape(inside, r, g, b, boundsX0, boundsY0, boundsX1, boundsY1) {
  for (let y = boundsY0; y < boundsY1; y += 1) {
    for (let x = boundsX0; x < boundsX1; x += 1) {
      const c = coverage(inside, x, y)
      if (c > 0) setPixel(x, y, r, g, b, Math.round(c * 255))
    }
  }
}

// Solid fill (opaque background).
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const i = ((y * size) + x) * 4
    pixels[i] = 255
    pixels[i + 1] = 255
    pixels[i + 2] = 255
    pixels[i + 3] = 255
  }
}

// Rounded-square container: standard rounded rectangle. Real macOS icons use a
// superellipse ("squircle"); a rounded rect at r=~22% of side reads correctly at
// icon sizes and avoids the extra math.
const insideContainer = (px, py) => {
  if (px < 0 || px > size || py < 0 || py > size) return false
  const r = containerRadius
  if (px >= r && px <= (size - r)) return true
  if (py >= r && py <= (size - r)) return true
  const cx = (px < r) ? r : (size - r)
  const cy = (py < r) ? r : (size - r)
  const dx = px - cx
  const dy = py - cy
  return ((dx * dx) + (dy * dy)) <= (r * r)
}
fillShape(insideContainer, BG[0], BG[1], BG[2], 0, 0, size, size)

// Bookmark: rounded top, straight sides, V-notch at the bottom.
const bmW = bookmarkRightX - bookmarkLeftX
const bmH = bookmarkBottomY - bookmarkTopY
const notchApexY = bookmarkBottomY - bookmarkNotchDepth
const notchApexX = bookmarkLeftX + (bmW / 2)

const insideBookmark = (px, py) => {
  if (px < bookmarkLeftX || px > bookmarkRightX) return false
  if (py < bookmarkTopY || py > bookmarkBottomY) return false

  // Top-rounded corners.
  if (py < (bookmarkTopY + bookmarkCornerRadius)) {
    if (px < (bookmarkLeftX + bookmarkCornerRadius)) {
      const cx = bookmarkLeftX + bookmarkCornerRadius
      const cy = bookmarkTopY + bookmarkCornerRadius
      const dx = px - cx
      const dy = py - cy
      return ((dx * dx) + (dy * dy)) <= (bookmarkCornerRadius * bookmarkCornerRadius)
    }
    if (px > (bookmarkRightX - bookmarkCornerRadius)) {
      const cx = bookmarkRightX - bookmarkCornerRadius
      const cy = bookmarkTopY + bookmarkCornerRadius
      const dx = px - cx
      const dy = py - cy
      return ((dx * dx) + (dy * dy)) <= (bookmarkCornerRadius * bookmarkCornerRadius)
    }
  }

  // V-notch: two line segments from bottom-left corner and bottom-right corner
  // to the apex above. A point is INSIDE the bookmark if it's ABOVE both edges.
  if (py > notchApexY) {
    const tLeft = (py - notchApexY) / (bookmarkBottomY - notchApexY)
    const edgeLeftX = bookmarkLeftX + ((notchApexX - bookmarkLeftX) * tLeft)
    if (px < edgeLeftX) return false
    const tRight = (py - notchApexY) / (bookmarkBottomY - notchApexY)
    const edgeRightX = bookmarkRightX - ((bookmarkRightX - notchApexX) * tRight)
    if (px > edgeRightX) return false
  }

  return true
}
fillShape(insideBookmark, GLYPH[0], GLYPH[1], GLYPH[2],
  bookmarkLeftX - 2, bookmarkTopY - 2, bookmarkRightX + 2, bookmarkBottomY + 2)

function crc32(buffer) {
  let crc = ~0
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i]
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, checksum])
}

function png() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const raw = Buffer.alloc(((size * 4) + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * ((size * 4) + 1)
    raw[rowStart] = 0
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

writeFileSync(outputPath, png())
console.log(outputPath)
