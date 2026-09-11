// `npm run icons`: resources/icon.svg becomes the icons electron-builder packages — icon.icns
// for macOS, icon.ico for Windows, icon.png for Linux. Run by Electron, whose Chromium draws
// the SVG at each size, so small sizes are rendered, not shrunk.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const resources = join(__dirname, '..', 'resources')

/** The rounded square drawn in icon.svg, in its 1024 canvas. */
const TILE = { size: 745, x: 512.7, y: 513.3 }
/**
 * The square's size on each system, out of 1024. macOS follows Apple's grid (824, the Dock adds
 * its shadow around it); Windows fills the canvas, or the icon is a speck at 16 px in the taskbar;
 * Linux themes sit in between.
 */
const TILE_SIZE = { mac: 824, windows: 976, linux: 920 }

/** icon.svg with its square scaled to `size`, centred. */
function variant(svg, size) {
  const k = size / TILE.size
  return svg
    .replace(/(<svg[^>]*>)/, `$1<g transform="translate(512 512) scale(${k}) translate(${-TILE.x} ${-TILE.y})">`)
    .replace('</svg>', '</g></svg>')
}
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** PNG entries of an .icns file: type, then pixel size. */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512]
]

async function render(window, svg, size) {
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
  const source = `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`
  const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = ${size}
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size})
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('the SVG could not be drawn'))
    image.src = ${JSON.stringify(source)}
  })`)
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

/** Windows icon with PNG entries, which every Windows since Vista reads. */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

function icns(pngs) {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + pngs.get(size).length, 4)
    return Buffer.concat([head, pngs.get(size)])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  try {
    const svg = readFileSync(join(resources, 'icon.svg'), 'utf-8')
    const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await window.loadURL('about:blank')
    const renderAll = async (system, sizes) => {
      const pngs = new Map()
      for (const size of sizes) pngs.set(size, await render(window, variant(svg, TILE_SIZE[system]), size))
      return pngs
    }

    const mac = await renderAll('mac', [...new Set(ICNS_TYPES.map(([, size]) => size))])
    const windows = await renderAll('windows', ICO_SIZES)
    const linux = await renderAll('linux', [1024])
    writeFileSync(join(resources, 'icon.icns'), icns(mac))
    writeFileSync(join(resources, 'icon.ico'), ico(ICO_SIZES.map((size) => ({ size, png: windows.get(size) }))))
    writeFileSync(join(resources, 'icon.png'), linux.get(1024))
    console.log(`icons written to ${resources}`)
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
