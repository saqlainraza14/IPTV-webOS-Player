/**
 * create_ipk.js  —  Build a webOS .ipk without the SDK or Python.
 * Requires Node.js >= 10 (only built-in modules: fs, path, zlib, child_process).
 *
 * Usage:
 *   node create_ipk.js [app-dir] [out-dir]
 */
"use strict";

var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

var APP_DIR = process.argv[2] || __dirname;
var OUT_DIR = process.argv[3] || path.join(APP_DIR, "build");

// ── Read appinfo.json ─────────────────────────────────────────────────────────
var appinfoPath = path.join(APP_DIR, "appinfo.json");
if (!fs.existsSync(appinfoPath)) {
  process.exit("ERROR: appinfo.json not found in " + APP_DIR);
}
var appinfo = JSON.parse(fs.readFileSync(appinfoPath, "utf8"));
var APP_ID = appinfo.id || "com.streamdeck.app";
var APP_VERSION = appinfo.version || "1.0.0";
var INSTALL_DIR = "/usr/palm/applications/" + APP_ID;

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// ── Skip list ─────────────────────────────────────────────────────────────────
var SKIP_NAMES = [
  "build",
  "backup ipk",
  ".git",
  "__pycache__",
  "node_modules",
  "create_ipk.py",
  "create_ipk.js",
  "generate_icons.js",
  "build.bat",
  "build.sh",
  "README.md",
  "package.bat",
  "hls.min.js.bak.0.8.9"
];
var SKIP_EXTS = [".py", ".bat", ".sh", ".ipk", ".js.map"];

function collectFiles(base) {
  var result = [];
  function walk(dir) {
    fs.readdirSync(dir).forEach(function (name) {
      if (SKIP_NAMES.indexOf(name) !== -1) {
        return;
      }
      var full = path.join(dir, name);
      var stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        return;
      }
      var ext = path.extname(name).toLowerCase();
      if (SKIP_EXTS.indexOf(ext) !== -1) {
        return;
      }
      var rel = path.relative(base, full).replace(/\\/g, "/");
      result.push({ rel: rel, abs: full, size: stat.size });
    });
  }
  walk(base);
  return result;
}

var files = collectFiles(APP_DIR);
if (!files.length) {
  process.exit("ERROR: No app files found in " + APP_DIR);
}

// Auto-strip trailing commas before ) from JS files — the formatter re-introduces
// them and Chromium 38 (webOS 3.x) throws SyntaxError on every build if not removed.
var JS_FILES_TO_FIX = ["app.js", "login.js", "polyfills.js"];
JS_FILES_TO_FIX.forEach(function (name) {
  var filePath = path.join(APP_DIR, name);
  if (!fs.existsSync(filePath)) return;
  var lines = fs.readFileSync(filePath, "utf8").split("\n");
  var count = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/,\s*$/.test(lines[i])) {
      var j = i + 1;
      while (j < lines.length && /^\s*$/.test(lines[j])) j++;
      var nx = (lines[j] || "").trim();
      if (nx.charAt(0) === ")") {
        lines[i] = lines[i].replace(/,(\s*)$/, "$1");
        count++;
      }
    }
  }
  if (count > 0) {
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
    console.log("  ES5 fix: removed " + count + " trailing commas from " + name);
  }
});

console.log("Packaging " + files.length + " file(s)…");

// ── CRC-32 ────────────────────────────────────────────────────────────────────
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

// ── Minimal tar builder ───────────────────────────────────────────────────────
function padRight(s, len, ch) {
  ch = ch || " ";
  while (s.length < len) {
    s += ch;
  }
  return s.slice(0, len);
}
function padLeft(s, len, ch) {
  ch = ch || " ";
  while (s.length < len) {
    s = ch + s;
  }
  return s.slice(0, len);
}

function tarHeader(name, size, isDir) {
  var h = Buffer.alloc(512, 0);
  var nameBuf = Buffer.from(name, "utf8");
  // If name > 100 bytes, use GNU LongLink (simplified: truncate to 99)
  nameBuf.copy(h, 0, 0, Math.min(nameBuf.length, 99));
  // mode
  Buffer.from(padLeft(isDir ? "755" : "644", 7, "0") + " ").copy(h, 100);
  // uid, gid
  Buffer.from("0000000 ").copy(h, 108);
  Buffer.from("0000000 ").copy(h, 116);
  // size  (octal, 11 digits + space)
  Buffer.from(padLeft(size.toString(8), 11, "0") + " ").copy(h, 124);
  // mtime
  Buffer.from(padLeft(Math.floor(Date.now() / 1000).toString(8), 11, "0") + " ").copy(h, 136);
  // type
  h[156] = isDir ? 0x35 : 0x30; // '5' dir, '0' file
  // ustar magic
  Buffer.from("ustar  \0").copy(h, 257);

  // checksum placeholder
  Buffer.from("        ").copy(h, 148);
  var sum = 0;
  for (var i = 0; i < 512; i++) {
    sum += h[i];
  }
  Buffer.from(padLeft(sum.toString(8), 6, "0") + "\0 ").copy(h, 148);
  return h;
}

function makeTar(entries) {
  var chunks = [];
  entries.forEach(function (e) {
    if (e.dir) {
      chunks.push(tarHeader(e.name, 0, true));
      return;
    }
    var data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    var header = tarHeader(e.name, data.length, false);
    chunks.push(header);
    chunks.push(data);
    // pad to 512-byte boundary
    var remainder = data.length % 512;
    if (remainder) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  });
  // two zero 512-byte blocks at end
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function makeTarGz(entries) {
  return zlib.gzipSync(makeTar(entries), { level: 9 });
}

// ── 1. debian-binary ─────────────────────────────────────────────────────────
var debianBinary = Buffer.from("2.0\n");

// ── 2. control.tar.gz ────────────────────────────────────────────────────────
var installedKb = files.reduce(function (s, f) {
  return s + f.size;
}, 0);

var controlText =
  "Package: " +
  APP_ID +
  "\n" +
  "Version: " +
  APP_VERSION +
  "\n" +
  "Section: misc\n" +
  "Priority: optional\n" +
  "Architecture: all\n" +
  "Installed-Size: " +
  installedKb +
  "\n" +
  "Maintainer: " +
  (appinfo.vendor || "Unknown") +
  "\n" +
  "Description: " +
  (appinfo.appDescription || appinfo.title || APP_ID) +
  "\n" +
  "webOS-Package-Format-Version: 2\n" +
  "webOS-Packager-Version: 3.2.5\n" +
  "App-Id: " +
  APP_ID +
  "\n" +
  "App-Version: " +
  APP_VERSION +
  "\n";

var controlGz = makeTarGz([{ name: "./control", data: controlText }]);

// ── 3. data.tar.gz ────────────────────────────────────────────────────────────
// webOS registers the package from usr/palm/packages/<id>/packageinfo.json;
// without it appinstalld reports a generic "-1 failed to install" error.
var packageInfo = {
  id: APP_ID,
  version: APP_VERSION,
  app: APP_ID
};

// Path layout mirrors ares-package: no "./" prefix, trailing "/" on directories.
var APP_ROOT = "usr/palm/applications/" + APP_ID;
var dataEntries = [
  { name: "usr/", dir: true },
  { name: "usr/palm/", dir: true },
  { name: "usr/palm/applications/", dir: true },
  { name: "usr/palm/packages/", dir: true },
  { name: APP_ROOT + "/", dir: true },
  { name: "usr/palm/packages/" + APP_ID + "/", dir: true }
];

files.forEach(function (f) {
  var parts = f.rel.split("/");
  var acc = APP_ROOT;
  for (var i = 0; i < parts.length - 1; i++) {
    acc += "/" + parts[i];
    var dirName = acc + "/";
    var already = dataEntries.some(function (e) {
      return e.dir && e.name === dirName;
    });
    if (!already) {
      dataEntries.push({ name: dirName, dir: true });
    }
  }
  dataEntries.push({
    name: APP_ROOT + "/" + f.rel,
    data: fs.readFileSync(f.abs)
  });
});

dataEntries.push({
  name: "usr/palm/packages/" + APP_ID + "/packageinfo.json",
  data: JSON.stringify(packageInfo, null, 2)
});

var dataGz = makeTarGz(dataEntries);

// ── 4. AR archive ─────────────────────────────────────────────────────────────
function arHeader(name, size) {
  var h = Buffer.alloc(60, 0x20);
  Buffer.from(name).copy(h, 0);
  Buffer.from(String(Math.floor(Date.now() / 1000))).copy(h, 16);
  Buffer.from("0").copy(h, 28); // uid
  Buffer.from("0").copy(h, 34); // gid
  Buffer.from("100644").copy(h, 40); // mode
  Buffer.from(String(size)).copy(h, 48);
  h[58] = 0x60;
  h[59] = 0x0a; // "`\n"
  return h;
}

function arEntry(name, data) {
  var header = arHeader(name, data.length);
  var pad = data.length % 2 ? Buffer.from([0x0a]) : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

var ipkBuf = Buffer.concat([
  Buffer.from("!<arch>\n"),
  arEntry("debian-binary", debianBinary),
  arEntry("control.tar.gz", controlGz),
  arEntry("data.tar.gz", dataGz)
]);

var ipkName = APP_ID + "_" + APP_VERSION + "_all.ipk";
var ipkPath = path.join(OUT_DIR, ipkName);
fs.writeFileSync(ipkPath, ipkBuf);

console.log("");
console.log("IPK created : " + ipkPath);
console.log("Size        : " + Math.ceil(ipkBuf.length / 1024) + " KB");
console.log("");
console.log("Install on TV (Developer Mode active):");
console.log("  ares-install --device tv " + ipkPath);
