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

app.use(express.json({ limit: '2mb' }));   // transcrições de reunião passam de 100kb

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

/* ---------- Sugestão de tarefas a partir da transcrição de reunião ----------
   Só aceita quem está logado no dash com conta @nibo.com.br (o token do
   Firebase é conferido no Google antes de gastar a cota do Gemini). */
const FB_API_KEY = 'AIzaSyDE6wv0kFOOJGWDjOX-mQ2s1kO0ktFdybs';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

async function emailDoToken(idToken) {
  if (!idToken) return null;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FB_API_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const u = j.users && j.users[0];
  return u && u.email ? String(u.email).toLowerCase() : null;
}

const SCHEMA_TAREFAS = {
  type: 'OBJECT',
  properties: {
    tarefas: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          titulo:      { type: 'STRING' },
          area:        { type: 'STRING', enum: ['Social','Design','Mídia Paga','Produto','RevOps','Eventos'] },
          prioridade:  { type: 'STRING', enum: ['Urgente','Alta','Média','Baixa'] },
          prazo:       { type: 'STRING', description: 'YYYY-MM-DD ou vazio se não foi combinado' },
          responsaveis:{ type: 'ARRAY', items: { type: 'STRING' }, description: 'Iniciais do time' },
          tipo:        { type: 'STRING', description: 'Tipo de material (post, banner, e-mail...) ou vazio' },
          contexto:    { type: 'STRING', description: 'Contexto e objetivo em 1 a 3 frases' },
          trecho:      { type: 'STRING', description: 'Frase curta da reunião que originou a tarefa' },
        },
        required: ['titulo','area','prioridade','contexto'],
      },
    },
  },
  required: ['tarefas'],
};

app.post('/api/sugerir-tarefas', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const email = await emailDoToken(req.body && req.body.idToken).catch(() => null);
    if (!email || !email.endsWith('@nibo.com.br')) return res.status(401).json({ error: 'Entre com sua conta @nibo.com.br para usar.' });

    const key = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!key) return res.status(503).json({ error: 'A IA não está configurada neste servidor (falta GEMINI_API_KEY).' });

    const transcricao = String((req.body && req.body.transcricao) || '').slice(0, 200000).trim();
    if (transcricao.length < 30) return res.status(400).json({ error: 'A transcrição está muito curta.' });
    const time = Array.isArray(req.body.time) ? req.body.time.slice(0, 30) : [];
    const hoje = String(req.body.hoje || new Date().toISOString().slice(0, 10)).slice(0, 10);

    const instrucoes = [
      'Você organiza demandas do time de marketing do Nibo (software financeiro e contábil para escritórios contábeis).',
      'Leia a transcrição de uma reunião e liste só as tarefas concretas que alguém do marketing precisa executar.',
      'Ignore conversa solta, opiniões e coisas que já foram feitas. Junte pedidos repetidos numa tarefa só.',
      'Título curto e direto (até 70 caracteres), começando pelo que será entregue. Sem ponto final.',
      'Áreas possíveis: Social, Design, Mídia Paga, Produto, RevOps, Eventos.',
      'Responsáveis: use só as iniciais do time abaixo, e só quando a pessoa foi citada ou a tarefa é claramente da área dela.',
      'Prazo: converta datas relativas ("sexta", "semana que vem") usando hoje = ' + hoje + '. Se não falaram prazo, deixe vazio.',
      'Prioridade Média por padrão; Alta ou Urgente só se a reunião deixou isso claro.',
      'Escreva em português do Brasil.',
      'Time: ' + time.map(m => m.initials + ' = ' + m.name + ' (' + m.area + ')').join('; '),
    ].join('\n');

    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instrucoes }] },
        contents: [{ role: 'user', parts: [{ text: 'Transcrição da reunião:\n\n' + transcricao }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA_TAREFAS },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'A IA não respondeu: ' + ((j.error && j.error.message) || r.status) });
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('') || '{}';
    let out; try { out = JSON.parse(txt); } catch (e) { out = { tarefas: [] }; }
    res.json({ tarefas: Array.isArray(out.tarefas) ? out.tarefas.slice(0, 40) : [] });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao sugerir tarefas: ' + e.message });
  }
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
