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
/* Modelo atual; se o Google aposentar e sugerir outro no erro, o servidor
   passa a usar o sugerido sozinho (até reiniciar). */
let modeloAtual = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
let semThinking = false;   // vira true se o modelo não aceitar thinkingConfig

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

/* Chaves de IA: primeiro as variáveis do servidor; se não tiver, as que o
   time salvou pelo dash em config/ia (lidas com o login da própria pessoa,
   então as regras do Firestore continuam valendo). */
let chaveCache = { valor: null, em: 0 };
async function chavesIA(idToken) {
  const envGemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY || null;
  const envGroq = process.env.GROQ_API_KEY || null;
  let doc = { gemini: null, groq: null };
  if (!(envGemini && envGroq)) {
    if (chaveCache.valor && Date.now() - chaveCache.em < 5 * 60 * 1000) doc = chaveCache.valor;
    else {
      const r = await fetch('https://firestore.googleapis.com/v1/projects/dash-marketing-9302b/databases/(default)/documents/config/ia', {
        headers: { Authorization: 'Bearer ' + idToken },
      }).catch(() => null);
      if (r && r.ok) {
        const j = await r.json().catch(() => ({}));
        const f = j.fields || {};
        const lido = k => (f[k] && f[k].stringValue ? f[k].stringValue.trim() : null);
        doc = { gemini: lido('geminiKey'), groq: lido('groqKey') };
        chaveCache = { valor: doc, em: Date.now() };
      }
    }
  }
  return { gemini: envGemini || doc.gemini, groq: envGroq || doc.groq };
}

/* ---------- Groq (gratuito e rápido; usado primeiro quando tem chave) ----------
   Pergunta ao Groq quais modelos existem e usa o melhor da lista de
   preferência, pra não quebrar quando um modelo for aposentado. */
const GROQ_PREFERIDOS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
let groqModelos = { lista: null, em: 0 };
async function modelosGroq(key) {
  if (groqModelos.lista && Date.now() - groqModelos.em < 60 * 60 * 1000) return groqModelos.lista;
  let ids = [];
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000) });
    if (r.ok) ids = ((await r.json()).data || []).filter(m => m.active !== false).map(m => m.id);
  } catch (e) {}
  const texto = ids.filter(id => !/whisper|guard|tts|playai|orpheus|compound|prompt/i.test(id));
  const lista = ids.length
    ? GROQ_PREFERIDOS.filter(id => texto.includes(id)).concat(texto.filter(id => !GROQ_PREFERIDOS.includes(id)))
    : GROQ_PREFERIDOS.slice();
  groqModelos = { lista, em: Date.now() };
  return lista;
}
const FORMATO_JSON = 'Responda só com JSON neste formato: {"tarefas":[{"titulo":"","area":"Social|Design|Mídia Paga|Produto|RevOps|Eventos","prioridade":"Urgente|Alta|Média|Baixa","prazo":"YYYY-MM-DD ou vazio","responsaveis":["INICIAIS"],"motivoResponsavel":"","tipo":"","contexto":"","trecho":""}]}. Se não houver tarefas, {"tarefas":[]}.';
async function sugerirComGroq(key, instrucoes, transcricao, msRestantes) {
  const modelos = (await modelosGroq(key)).slice(0, 4);
  let ultimo = { status: 0, msg: '' };
  for (const modelo of modelos) {
    const ms = msRestantes();
    if (ms < 6000) return { erro: 'demorou' };
    let r, j;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: modelo, temperature: 0.3, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: instrucoes + '\n' + FORMATO_JSON }, { role: 'user', content: 'Transcrição da reunião:\n\n' + transcricao }],
        }),
        signal: AbortSignal.timeout(ms),
      });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { erro: 'demorou' };
      ultimo = { status: 0, msg: e.message }; continue;
    }
    if (r.ok) {
      const txt = (((j.choices || [])[0] || {}).message || {}).content || '{}';
      let out; try { out = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); try { out = m ? JSON.parse(m[0]) : {}; } catch (e2) { out = {}; } }
      return { tarefas: Array.isArray(out.tarefas) ? out.tarefas : [], modelo };
    }
    const msg = (j.error && j.error.message) || String(r.status);
    ultimo = { status: r.status, msg };
    if (r.status === 401) return { erro: 'chave_invalida' };
    // modelo saiu do ar, pedido grande demais pro modelo ou limite daquele modelo: tenta o próximo
    if (r.status === 404 || r.status === 413 || r.status === 429 || r.status >= 500 || /decommissioned|not found|too large|rate limit|tokens per/i.test(msg)) continue;
    break;
  }
  if (ultimo.status === 413 || /too large|tokens per/i.test(ultimo.msg)) return { erro: 'grande' };
  if (ultimo.status === 429) return { erro: 'limite' };
  return { erro: 'outro', msg: ultimo.msg };
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
          responsaveis:{ type: 'ARRAY', items: { type: 'STRING' }, description: 'Iniciais do time (pelo menos uma)' },
          motivoResponsavel: { type: 'STRING', description: 'Por que essa pessoa, em até 12 palavras' },
          tipo:        { type: 'STRING', description: 'Tipo de material (post, banner, e-mail...) ou vazio' },
          contexto:    { type: 'STRING', description: 'Contexto e objetivo em 1 a 3 frases' },
          trecho:      { type: 'STRING', description: 'Frase curta da reunião que originou a tarefa' },
        },
        required: ['titulo','area','prioridade','contexto','responsaveis'],
      },
    },
  },
  required: ['tarefas'],
};

app.post('/api/sugerir-tarefas', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const email = await emailDoToken(req.body && req.body.idToken).catch(() => null);
    if (!email || !email.endsWith('@nibo.com.br')) return res.status(401).json({ error: 'Entre com sua conta @nibo.com.br para usar.' });

    const chaves = await chavesIA(req.body.idToken);
    if (!chaves.gemini && !chaves.groq) return res.status(503).json({ code: 'sem_chave', error: 'Falta a chave da IA. Cole a chave abaixo pra ativar.' });

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
      'Responsáveis: sempre sugira pelo menos uma pessoa, usando só as iniciais do time abaixo. Primeiro quem foi citado como dono da tarefa; se ninguém foi citado, quem é da área da tarefa (área principal ou extra). Não coloque a gestora (aprovadora) como responsável a não ser que ela tenha assumido a tarefa. Explique a escolha em motivoResponsavel (ex.: "citada na reunião", "cuida de Design").',
      'Área: escolha o setor do marketing que executa (post/roteiro/copy = Social; arte/peça/banner = Design; anúncio/tráfego = Mídia Paga; lançamento/funcionalidade = Produto; CRM/HubSpot/automação/lista = RevOps; webinar/evento/stand = Eventos).',
      'Prazo: converta datas relativas ("sexta", "semana que vem") usando hoje = ' + hoje + '. Se não falaram prazo, deixe vazio.',
      'Prioridade Média por padrão; Alta ou Urgente só se a reunião deixou isso claro.',
      'Escreva em português do Brasil.',
      'Time: ' + time.map(m => m.initials + ' = ' + m.name + ' (área ' + m.area + (m.extras && m.extras.length ? '; também ' + m.extras.join(', ') : '') + (m.aprovador ? '; gestora/aprovadora' : '') + ')').join('; '),
    ].join('\n');

    /* Limite total de 85s por pedido: o dash nunca fica "lendo" pra sempre.
       Cada chamada respeita o tempo que sobra; o modelo pensa pouco (mais rápido)
       e, se não aceitar essa opção, segue sem ela. */
    const inicio = Date.now(), LIMITE = 85000;
    const restante = () => LIMITE - (Date.now() - inicio);

    if (chaves.groq) {
      const g = await sugerirComGroq(chaves.groq, instrucoes, transcricao, restante);
      if (g.tarefas) return res.json({ tarefas: g.tarefas.slice(0, 40), ia: 'groq:' + g.modelo });
      if (!chaves.gemini) {
        if (g.erro === 'chave_invalida') { chaveCache = { valor: null, em: 0 }; return res.status(502).json({ code: 'chave_invalida', error: 'O Groq recusou a chave. Confira se copiou a chave inteira ou cole uma nova abaixo.' }); }
        if (g.erro === 'grande') return res.status(413).json({ code: 'grande', error: 'A transcrição é grande demais pro plano gratuito do Groq. Cole só a parte da reunião com os combinados e próximos passos.' });
        if (g.erro === 'limite') return res.status(429).json({ code: 'limite', error: 'Chegamos no limite gratuito do Groq por agora. Tente de novo em um minuto.' });
        if (g.erro === 'demorou') return res.status(504).json({ code: 'demorou', error: 'A IA demorou demais pra responder. Tente de novo em instantes.' });
        return res.status(502).json({ error: 'A IA não respondeu: ' + (g.msg || 'erro desconhecido') });
      }
      console.log('Groq falhou (' + g.erro + '), tentando Gemini');
    }
    const key = chaves.gemini;
    const chamar = async modelo => {
      const gen = { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA_TAREFAS };
      if (!semThinking) gen.thinkingConfig = { thinkingLevel: 'low' };
      const corpo = {
        systemInstruction: { parts: [{ text: instrucoes }] },
        contents: [{ role: 'user', parts: [{ text: 'Transcrição da reunião:\n\n' + transcricao }] }],
        generationConfig: gen,
      };
      const ms = Math.max(5000, restante());
      try {
        let rr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(corpo), signal: AbortSignal.timeout(ms),
        });
        let jj = await rr.json().catch(() => ({}));
        if (!rr.ok && rr.status === 400 && /thinking/i.test(JSON.stringify(jj)) && !semThinking) {
          semThinking = true; delete gen.thinkingConfig;
          rr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(corpo), signal: AbortSignal.timeout(Math.max(5000, restante())),
          });
          jj = await rr.json().catch(() => ({}));
        }
        return { r: rr, j: jj };
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { r: { ok: false, status: 504 }, j: { error: { message: 'timeout' } }, demorou: true };
        throw e;
      }
    };
    /* Modelo sobrecarregado (503 / "high demand"): tenta de novo esperando 2s, 5s e 9s,
       só se ainda sobrar tempo dentro do limite. */
    const ocupado = (rr, jj) => rr.status === 503 || /high demand|overloaded|UNAVAILABLE|try again later/i.test(((jj.error && jj.error.message) || '') + ' ' + ((jj.error && jj.error.status) || ''));
    const esperar = ms => new Promise(ok => setTimeout(ok, ms));
    let { r, j, demorou } = await chamar(modeloAtual);
    for (const ms of [2000, 5000, 9000]) {
      if (r.ok || demorou || !ocupado(r, j) || restante() < ms + 20000) break;
      await esperar(ms);
      ({ r, j, demorou } = await chamar(modeloAtual));
    }
    if (demorou) return res.status(504).json({ code: 'demorou', error: 'A IA demorou demais pra responder. Tente de novo em instantes. Se a reunião for muito longa, cole só a parte com os combinados e próximos passos.' });
    /* "This model ... is no longer available ... use models/xxx" → tenta o sugerido */
    if (!r.ok) {
      const m0 = (j.error && j.error.message) || '';
      const sug = /no longer available|not found|deprecated|is not supported/i.test(m0) && m0.match(/models\/(gemini-[a-z0-9.\-]+)/gi);
      const novo = sug && sug.map(x => x.replace(/^models\//i, '')).find(x => x !== modeloAtual);
      if (novo) {
        const { r: r2, j: j2 } = await chamar(novo);
        if (r2.ok) { console.log('Gemini: trocando modelo ' + modeloAtual + ' -> ' + novo); modeloAtual = novo; }
        r = r2; j = j2;
      }
    }
    if (!r.ok) {
      const msg = (j.error && j.error.message) || String(r.status);
      const invalida = r.status === 400 && /api key|API_KEY_INVALID/i.test(msg + JSON.stringify(j)) || r.status === 403 && /api key|permission/i.test(msg);
      if (invalida) { chaveCache = { valor: null, em: 0 }; return res.status(502).json({ code: 'chave_invalida', error: 'O Google recusou a chave do Gemini. Confira se copiou a chave inteira ou cole uma nova abaixo.' }); }
      if (/prepayment credits|billing|credits are depleted/i.test(msg)) { chaveCache = { valor: null, em: 0 }; return res.status(402).json({ code: 'sem_credito', error: 'Os créditos do projeto dessa chave acabaram. Cole abaixo uma chave gratuita (criada num projeto sem faturamento, como o dash-marketing).' }); }
      if (ocupado(r, j)) return res.status(503).json({ code: 'ocupado', error: 'O Gemini está sobrecarregado agora (é do lado do Google). Já tentei de novo algumas vezes. Espere um ou dois minutos e clique em Sugerir tarefas outra vez.' });
      if (r.status === 429) return res.status(429).json({ code: 'limite', error: 'Chegamos no limite gratuito do Gemini por agora. Tente de novo em alguns minutos (ou amanhã, se for o limite do dia).' });
      return res.status(502).json({ error: 'A IA não respondeu: ' + msg });
    }
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '{}';
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
