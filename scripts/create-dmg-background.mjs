import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(__dirname, '../src-tauri/dmg-background.png')
const width = 760
const height = 430
const pixels = Buffer.alloc(width * height * 4)

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= width || y < 0 || y >= height) return
  const i = (y * width + x) * 4
  pixels[i] = r
  pixels[i + 1] = g
  pixels[i + 2] = b
  pixels[i + 3] = a
}

function blendPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= width || y < 0 || y >= height) return
  const i = (y * width + x) * 4
  const alpha = a / 255
  pixels[i] = Math.round((r * alpha) + (pixels[i] * (1 - alpha)))
  pixels[i + 1] = Math.round((g * alpha) + (pixels[i + 1] * (1 - alpha)))
  pixels[i + 2] = Math.round((b * alpha) + (pixels[i + 2] * (1 - alpha)))
  pixels[i + 3] = 255
}

function fill(r, g, b) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(x, y, r, g, b)
    }
  }
}

function drawCircle(cx, cy, radius, color, alpha = 255) {
  const [r, g, b] = color
  const minX = Math.floor(cx - radius)
  const maxX = Math.ceil(cx + radius)
  const minY = Math.floor(cy - radius)
  const maxY = Math.ceil(cy + radius)
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx
      const dy = y - cy
      if ((dx * dx) + (dy * dy) <= radius * radius) blendPixel(x, y, r, g, b, alpha)
    }
  }
}

function drawThickLine(x1, y1, x2, y2, thickness, color) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1))
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const x = x1 + ((x2 - x1) * t)
    const y = y1 + ((y2 - y1) * t)
    drawCircle(x, y, thickness / 2, color, 235)
  }
}

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
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

fill(246, 245, 241)

drawThickLine(340, 216, 430, 216, 8, [52, 51, 46])
drawThickLine(430, 216, 397, 183, 8, [52, 51, 46])
drawThickLine(430, 216, 397, 249, 8, [52, 51, 46])

writeFileSync(outputPath, png())
console.log(outputPath)
