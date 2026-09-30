import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import { syncAuthorizedDomains } from './sync-firebase-auth-domain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Compile app.jsx to app.js if app.jsx exists
function buildAppJs() {
  const appJsPath = path.join(__dirname, 'app.js');
  const appJsxPath = path.join(__dirname, 'app.jsx');
  if (fs.existsSync(appJsxPath)) {
    try {
      esbuild.buildSync({
        entryPoints: [appJsxPath],
        outfile: appJsPath,
        jsxFactory: 'React.createElement',
        jsxFragment: 'React.Fragment',
      });
      console.log('Compiled app.jsx -> app.js');
    } catch (err) {
      console.error('Error compiling app.jsx:', err);
    }
  }
}

buildAppJs();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Run initial domain authorization check asynchronously
syncAuthorizedDomains().catch(console.error);

// Endpoint to force sync a domain from client
app.post('/api/sync-domain', async (req, res) => {
  const domain = req.body?.domain || (req.headers.host ? req.headers.host.split(':')[0] : null);
  if (domain) {
    try {
      await syncAuthorizedDomains(domain);
      return res.json({ ok: true, domain });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
  res.json({ ok: true });
});

// Auto-sync domain if accessed from a custom/new host
app.use((req, res, next) => {
  const host = req.headers.host ? req.headers.host.split(':')[0] : null;
  if (host && host.endsWith('.run.app')) {
    syncAuthorizedDomains(host).catch(() => {});
  }
  next();
});

// Set no-cache for all HTML and JS files to avoid stale browser state
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Serve static files from root directory
app.use(express.static(__dirname, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Route /solicitar to solicitar.html
app.get('/solicitar', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'solicitar.html'));
});

// Fallback to index.html for all other routes
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
