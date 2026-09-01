/**
 * generate_icons.js
 * Creates icon.png and largeIcon.png for the webOS app.
 * Priority: use new-logo.png if present, otherwise fallback to generated placeholder.
 * Uses only Node.js built-in modules — no npm packages required.
 * Run:  node generate_icons.js
 */

"use strict";

var fs = require("fs");
var zlib = require("zlib");
var path = require("path");

/* ---- CRC-32 ---- */
var CRC_TABLE = (function () {
  var t = new Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var crc = 0xffffffff;
  for (var i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---- PNG chunk helper ---- */
function makeChunk(type, data) {
  var typeBytes = Buffer.from(type, "ascii");
  var lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  var crcInput = Buffer.concat([typeBytes, data]);
  var crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

/* ---- Draw a simple icon with background + "SD" text (8×8 font) ---- */
/* Mini bitmap font for uppercase letters S and D, 7×9 pixels            */
var FONT = {
  S: [
    [0, 1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [0, 1, 1, 1, 1, 0],
  ],
  D: [
    [1, 1, 1, 1, 0, 0],
    [1, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 0],
    [1, 1, 1, 1, 0, 0],
  ],
};

/**
 * Create a PNG buffer of size × size with a dark background and golden "SD".
 * @param {number} size  — canvas size in pixels
 */
function createIconPNG(size) {
  /* background colour  #14161A */
  var bgR = 0x14,
    bgG = 0x16,
    bgB = 0x1a;
  /* accent colour      #E8A33D */
  var acR = 0xe8,
    acG = 0xa3,
    acB = 0x3d;
  /* corner radius      10 % of size */
  var radius = Math.round(size * 0.1);

  /* allocate pixel buffer  (RGBA 4 bytes per pixel) */
  var pixels = new Uint8Array(size * size * 4);

  function sqDist(ax, ay, bx, by) {
    var dx = ax - bx,
      dy = ay - by;
    return dx * dx + dy * dy;
  }

  function isInsideRounded(x, y) {
    /* corners */
    var r = radius;
    if (x < r && y < r) return sqDist(x, y, r, r) <= r * r;
    if (x >= size - r && y < r) return sqDist(x, y, size - r - 1, r) <= r * r;
    if (x < r && y >= size - r) return sqDist(x, y, r, size - r - 1) <= r * r;
    if (x >= size - r && y >= size - r)
      return sqDist(x, y, size - r - 1, size - r - 1) <= r * r;
    return true;
  }

  /* fill background */
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var base = (y * size + x) * 4;
      if (isInsideRounded(x, y)) {
        pixels[base] = bgR;
        pixels[base + 1] = bgG;
        pixels[base + 2] = bgB;
        pixels[base + 3] = 255;
      } else {
        pixels[base + 3] = 0; /* transparent corner */
      }
    }
  }

  /* draw "SD" centred */
  var charW = 6;
  var charH = 8;
  var gap = 2;
  var textW = charW * 2 + gap;
  var scale = Math.max(1, Math.round(size / 32));
  var startX = Math.round((size - textW * scale) / 2);
  var startY = Math.round((size - charH * scale) / 2);

  function drawChar(ch, offX) {
    var rows = FONT[ch];
    for (var row = 0; row < rows.length; row++) {
      for (var col = 0; col < rows[row].length; col++) {
        if (!rows[row][col]) {
          continue;
        }
        for (var sy = 0; sy < scale; sy++) {
          for (var sx = 0; sx < scale; sx++) {
            var px = offX + col * scale + sx;
            var py = startY + row * scale + sy;
            if (px < 0 || px >= size || py < 0 || py >= size) {
              continue;
            }
            var b = (py * size + px) * 4;
            pixels[b] = acR;
            pixels[b + 1] = acG;
            pixels[b + 2] = acB;
            pixels[b + 3] = 255;
          }
        }
      }
    }
  }

  drawChar("S", startX);
  drawChar("D", startX + (charW + gap) * scale);

  /* build PNG raw rows:  filter-byte=0  then  RGBA data */
  var rowLen = size * 4 + 1;
  var raw = Buffer.alloc(size * rowLen);
  for (var ry = 0; ry < size; ry++) {
    raw[ry * rowLen] = 0; /* filter None */
    for (var rx = 0; rx < size; rx++) {
      var src = (ry * size + rx) * 4;
      var dst = ry * rowLen + 1 + rx * 4;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  var compressed = zlib.deflateSync(raw, { level: 9 });

  /* IHDR */
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; /* bit depth */
  ihdr[9] = 6; /* colour type: RGBA */
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  var PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    PNG_SIG,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---- Main ---- */
var outDir = process.argv[2] || __dirname;
var logoPath = path.join(outDir, "new-logo.png");
var iconPath = path.join(outDir, "icon.png");
var largeIconPath = path.join(outDir, "largeIcon.png");

if (fs.existsSync(logoPath)) {
  var logo = fs.readFileSync(logoPath);
  fs.writeFileSync(iconPath, logo);
  fs.writeFileSync(largeIconPath, logo);
  console.log("Copied new-logo.png to icon.png and largeIcon.png");
} else {
  var icon80 = createIconPNG(80);
  var icon130 = createIconPNG(130);
  fs.writeFileSync(iconPath, icon80);
  fs.writeFileSync(largeIconPath, icon130);
  console.log("Created fallback icon.png     (80 x 80)");
  console.log("Created fallback largeIcon.png (130 x 130)");
}
