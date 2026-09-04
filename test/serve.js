#!/usr/bin/env node
// Static file server for the repository root.
//
// The tool needs a real origin -- ImageDecoder wants a secure context and
// Workers will not load from file:// -- so both the test suite and local
// development go through this. Node's standard library only: a static site
// should not need a dependency to look at.
//
//   node test/serve.js [port]

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".gif": "image/gif",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (rel.endsWith("/")) rel += "index.html";

  // Resolve, then confirm the result is still inside ROOT. Checking the raw
  // path for ".." is not enough: encodings and symlinks both get around it.
  const file = path.resolve(ROOT, "." + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    }).end(body);
  });
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT} at http://localhost:${PORT}/`);
});
