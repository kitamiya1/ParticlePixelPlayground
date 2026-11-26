// フレームの受け取り：POST /save?f=<相対パス> 本文 = data URL（image/jpeg）→ OUT/<相対パス>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const u = new URL(req.url, 'http://x');
  const f = (u.searchParams.get('f') || '').replace(/[^\w\-./]/g, '_');
  if (req.method !== 'POST' || !f || f.includes('..')) { res.statusCode = 400; res.end('bad'); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const s = Buffer.concat(chunks).toString();
    const b = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');
    const p = path.join(OUT, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, b);
    res.end('ok');
  });
}).listen(5199, '127.0.0.1', () => console.log('listening', OUT));
