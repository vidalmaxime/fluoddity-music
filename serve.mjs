// Zero-dependency static server:  node serve.mjs [port]
// (ES modules and AudioWorklets need http://, not file://)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = +(process.argv[2] || process.env.PORT || 5173);
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

createServer(async (req, res) => {
    try {
        let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
        if (path.endsWith('/')) path += 'index.html';
        const file = join(root, path);
        if (!file.startsWith(root) || file.includes(`${root}/reference`)) throw new Error('forbidden');
        await stat(file);
        res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(await readFile(file));
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
}).listen(port, () => console.log(`Fluoddity DJ → http://localhost:${port}`));
