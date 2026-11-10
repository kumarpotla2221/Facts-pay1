// DEV ONLY. Stands in for the school's own website. It runs on its own port (= its own origin, like a real
// separate domain), so the "only the school's site may iframe the pay page" rule is really exercised.
// PAY_URL = where the pay page lives: the Heroku api by default, http://localhost:4000 for a local api.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const PAY_URL = process.env.PAY_URL || 'https://facts-pay-8f54f64208f2.herokuapp.com';

const files = {                   // the whole "website": one page + the school logo (the same file the pay page uses)
  '/': ['./index.html', 'text/html; charset=utf-8'],
  '/logo.png': ['../public/schools/ranchi/logo.png', 'image/png'],
};
http.createServer(async (req, res) => {
  const [file, type] = files[req.url.split('?')[0]] ?? [];
  if (!file) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': type });
  const body = await readFile(new URL(file, import.meta.url));
  res.end(type.startsWith('text/html') ? body.toString().replace('__PAY_URL__', PAY_URL) : body);
}).listen(5003, () => console.log(`demo school site: http://localhost:5003  (pay page from ${PAY_URL})`));
