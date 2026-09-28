/**
 * Sincronização automática do Instagram — Central de Informações Nibo
 * ---------------------------------------------------------------------
 * Duas funções agendadas:
 *
 *  1) syncInstagramPosts — roda a cada 6 horas.
 *     Busca os posts recentes de @nibosoftware via Instagram Graph API
 *     (Business Discovery) e grava em Firestore: redesSociais/principal.
 *
 *  2) refreshInstagramToken — roda 1x por semana.
 *     Troca o token de longa duração por um novo antes que ele vença
 *     (tokens de longa duração do Meta expiram em 60 dias).
 *
 * O token NUNCA fica no código nem é exposto ao cliente: é lido e
 * gravado só aqui, via Admin SDK, em config/instagramToken — uma
 * coleção que as regras do Firestore não liberam pra leitura do
 * navegador (só o Admin SDK do servidor, que ignora as regras, acessa).
 *
 * O que fazer antes de implantar (README.md nesta pasta tem o passo a
 * passo completo):
 *   1. Ativar o plano Blaze no Firebase (Functions exige).
 *   2. Criar o app no Meta for Developers, ligar a Página do Facebook
 *      à conta @nibosoftware, gerar o token inicial de longa duração.
 *   3. Rodar o comando abaixo UMA VEZ pra guardar o token e o ID da
 *      conta comercial do Instagram (troque pelos valores reais):
 *
 *      firebase firestore:set config/instagramToken \
 *        '{"accessToken":"SEU_TOKEN_AQUI","igBusinessId":"SEU_ID_AQUI","expiresAt":"2026-11-01T00:00:00.000Z"}'
 *
 *   4. firebase deploy --only functions
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const GRAPH_VERSION = 'v20.0';
const MAX_POSTS = 6;

async function lerConfigToken() {
  const doc = await db.collection('config').doc('instagramToken').get();
  if (!doc.exists) throw new Error('config/instagramToken não existe — siga o README antes de implantar.');
  const d = doc.data();
  if (!d.accessToken || !d.igBusinessId) throw new Error('config/instagramToken está incompleto (faltando accessToken ou igBusinessId).');
  return d;
}

/* ---------- 1) Busca os posts recentes e grava em redesSociais/principal ---------- */
exports.syncInstagramPosts = onSchedule(
  { schedule: 'every 6 hours', timeZone: 'America/Sao_Paulo', region: 'southamerica-east1' },
  async () => {
    const { accessToken, igBusinessId } = await lerConfigToken();

    const socialDoc = await db.collection('redesSociais').doc('principal').get();
    const handle = (socialDoc.exists && socialDoc.data().instagramHandle) || 'nibosoftware';

    const campos = 'business_discovery.username(' + handle + '){media.limit(' + MAX_POSTS + '){id,caption,media_url,permalink,media_type,timestamp}}';
    const url = 'https://graph.facebook.com/' + GRAPH_VERSION + '/' + igBusinessId
      + '?fields=' + encodeURIComponent(campos) + '&access_token=' + accessToken;

    const resp = await fetch(url);
    const dados = await resp.json();

    if (dados.error) {
      logger.error('Erro na Graph API:', dados.error);
      await db.collection('redesSociais').doc('principal').set(
        { lastSyncError: dados.error.message, lastSyncErrorAt: new Date().toISOString() },
        { merge: true }
      );
      return;
    }

    const media = (dados.business_discovery && dados.business_discovery.media && dados.business_discovery.media.data) || [];
    const posts = media
      .filter(m => m.media_type !== 'VIDEO' || m.thumbnail_url) // evita quebrar sem imagem pra mostrar
      .slice(0, MAX_POSTS)
      .map(m => ({
        id: m.id,
        permalink: m.permalink,
        caption: (m.caption || '').slice(0, 200),
        mediaUrl: m.media_type === 'VIDEO' ? (m.thumbnail_url || '') : m.media_url,
        timestamp: m.timestamp || null,
      }));

    await db.collection('redesSociais').doc('principal').set(
      { posts, lastSyncedAt: new Date().toISOString(), lastSyncError: admin.firestore.FieldValue.delete() },
      { merge: true }
    );

    logger.info('Instagram sincronizado: ' + posts.length + ' posts de @' + handle);
  }
);

/* ---------- 2) Renova o token antes de vencer (a cada ~60 dias) ---------- */
exports.refreshInstagramToken = onSchedule(
  { schedule: 'every monday 03:00', timeZone: 'America/Sao_Paulo', region: 'southamerica-east1' },
  async () => {
    const { accessToken, igBusinessId, expiresAt } = await lerConfigToken();

    if (expiresAt) {
      const diasRestantes = (new Date(expiresAt) - new Date()) / 86400000;
      if (diasRestantes > 15) {
        logger.info('Token ainda válido por ' + Math.round(diasRestantes) + ' dias — não precisa renovar agora.');
        return;
      }
    }

    const url = 'https://graph.facebook.com/' + GRAPH_VERSION + '/oauth/access_token'
      + '?grant_type=fb_exchange_token&client_id=' + process.env.META_APP_ID
      + '&client_secret=' + process.env.META_APP_SECRET
      + '&fb_exchange_token=' + accessToken;

    const resp = await fetch(url);
    const dados = await resp.json();

    if (dados.error || !dados.access_token) {
      logger.error('Falha ao renovar o token do Instagram — alguém precisa gerar um novo manualmente.', dados.error);
      await db.collection('redesSociais').doc('principal').set(
        { lastSyncError: 'Token do Instagram perto de vencer e a renovação automática falhou. Gere um novo token.', lastSyncErrorAt: new Date().toISOString() },
        { merge: true }
      );
      return;
    }

    const novaExpiracao = new Date(Date.now() + (dados.expires_in || 5184000) * 1000).toISOString();
    await db.collection('config').doc('instagramToken').set(
      { accessToken: dados.access_token, igBusinessId, expiresAt: novaExpiracao },
      { merge: true }
    );
    logger.info('Token do Instagram renovado. Novo vencimento: ' + novaExpiracao);
  }
);

/**
 * Solicitar demanda direto pelo Slack (/nova-demanda)
 * ---------------------------------------------------------------------
 * Um Slash Command que abre um formulário nativo do Slack (modal). Ao
 * enviar, a demanda já nasce direto no quadro "Demandas Marketing"
 * (coleção demandas), como se tivesse sido criada manualmente no app —
 * sem passar por fila de triagem. A pessoa que pediu recebe, no máximo,
 * duas DMs de status depois: quando a demanda entra em andamento (sai
 * da primeira etapa) e quando é concluída.
 *
 * O que fazer antes de implantar:
 *   1. Criar um Slack App em https://api.slack.com/apps, com os Bot
 *      Token Scopes chat:write e users:read (pra buscar nome de quem
 *      pediu). Instalar no workspace da Nibo e copiar o Bot User OAuth
 *      Token (começa com xoxb-).
 *   2. Em "Basic Information", copiar o "Signing Secret".
 *   3. Guardar os dois como secrets (nunca como variável comum):
 *
 *        firebase functions:secrets:set SLACK_BOT_TOKEN
 *        firebase functions:secrets:set SLACK_SIGNING_SECRET
 *
 *   4. firebase deploy --only functions
 *      (imprime a URL de cada função no terminal)
 *
 *   5. Em "Slash Commands", criar /nova-demanda apontando pra URL de
 *      slackComandoNovaDemanda.
 *
 *   6. Em "Interactivity & Shortcuts", ativar e apontar pra URL de
 *      slackInteracoesNovaDemanda.
 *
 *   7. Reinstalar o app no workspace uma última vez.
 */
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');

const TIPOS_MATERIAL = ['Arte / peça gráfica','Post para redes sociais','Landing page','E-mail / disparo','Vídeo','Apresentação','Outro'];
const AREAS_MARKETING = ['Social','Design','Mídia Paga','Produto','RevOps','Eventos'];

function verificarAssinaturaSlack(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) { logger.warn('SLACK_SIGNING_SECRET não configurado.'); return false; }
  const timestamp = req.headers['x-slack-request-timestamp'];
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false; // evita replay de requisições antigas
  const sigBase = 'v0:' + timestamp + ':' + req.rawBody;
  const minhaAssinatura = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  const assinaturaRecebida = req.headers['x-slack-signature'] || '';
  try {
    return crypto.timingSafeEqual(Buffer.from(minhaAssinatura), Buffer.from(assinaturaRecebida));
  } catch { return false; }
}

function opcoesSelect(lista) {
  return lista.map(o => ({ text: { type: 'plain_text', text: o }, value: o }));
}

async function buscarStagesDaArea(area) {
  const doc = await db.collection('config').doc('pipes').get();
  const pipes = (doc.exists && doc.data().data) || {};
  return pipes[area] || [];
}

exports.slackComandoNovaDemanda = onRequest(async (req, res) => {
  if (!verificarAssinaturaSlack(req)) { res.status(401).send('assinatura inválida'); return; }

  const view = {
    type: 'modal',
    callback_id: 'nova_demanda_form',
    title:  { type: 'plain_text', text: 'Nova demanda' },
    submit: { type: 'plain_text', text: 'Criar demanda' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      { type: 'input', block_id: 'titulo', label: { type: 'plain_text', text: 'O que você precisa' },
        element: { type: 'plain_text_input', action_id: 'valor',
          placeholder: { type: 'plain_text', text: 'Ex: banner para a campanha de vagas de agosto' } } },
      { type: 'input', block_id: 'area', label: { type: 'plain_text', text: 'Área de marketing' },
        element: { type: 'static_select', action_id: 'valor', options: opcoesSelect(AREAS_MARKETING) } },
      { type: 'input', block_id: 'tipo', label: { type: 'plain_text', text: 'Tipo de material' },
        element: { type: 'static_select', action_id: 'valor', options: opcoesSelect(TIPOS_MATERIAL) } },
      { type: 'input', block_id: 'descricao', label: { type: 'plain_text', text: 'Contexto e objetivo' },
        element: { type: 'plain_text_input', action_id: 'valor', multiline: true,
          placeholder: { type: 'plain_text', text: 'Para que serve, onde vai ser usado, qual mensagem precisa passar...' } } },
      { type: 'input', block_id: 'prazo', optional: true, label: { type: 'plain_text', text: 'Precisa para quando (opcional)' },
        element: { type: 'datepicker', action_id: 'valor' } },
      { type: 'input', block_id: 'referencia', optional: true, label: { type: 'plain_text', text: 'Link de referência (opcional)' },
        element: { type: 'plain_text_input', action_id: 'valor', placeholder: { type: 'plain_text', text: 'Drive, Figma, exemplo...' } } },
    ]
  };

  try {
    const resp = await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ trigger_id: req.body.trigger_id, view })
    });
    const dados = await resp.json();
    if (!dados.ok) logger.error('Falha ao abrir o formulário no Slack: ' + dados.error);
  } catch (e) {
    logger.error('Erro ao abrir formulário de nova demanda: ' + e.message);
  }

  res.status(200).send('');
});

exports.slackInteracoesNovaDemanda = onRequest(async (req, res) => {
  if (!verificarAssinaturaSlack(req)) { res.status(401).send('assinatura inválida'); return; }

  const payload = JSON.parse(req.body.payload);
  if (payload.type !== 'view_submission' || payload.view.callback_id !== 'nova_demanda_form') {
    res.status(200).send('');
    return;
  }

  const valores = payload.view.state.values;
  const titulo     = (valores.titulo.valor.value || '').trim();
  const descricao  = (valores.descricao.valor.value || '').trim();
  const area       = valores.area.valor.selected_option ? valores.area.valor.selected_option.value : '';
  const tipo       = valores.tipo.valor.selected_option ? valores.tipo.valor.selected_option.value : '';
  const prazo      = valores.prazo.valor.selected_date || null;
  const referencia = (valores.referencia.valor.value || '').trim();

  const erros = {};
  if (!titulo) erros.titulo = 'Escreva em uma linha o que você precisa.';
  if (descricao.length < 15) erros.descricao = 'Conte um pouco mais no contexto — sem isso o time precisa voltar para perguntar.';
  if (!area) erros.area = 'Escolha a área.';
  if (Object.keys(erros).length) { res.status(200).json({ response_action: 'errors', errors: erros } ); return; }

  const token = process.env.SLACK_BOT_TOKEN;
  let solicitanteNome = payload.user.username;
  try {
    const infoResp = await fetch('https://slack.com/api/users.info?user=' + payload.user.id, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const info = await infoResp.json();
    if (info.ok) solicitanteNome = info.user.real_name || info.user.name;
  } catch (e) {
    logger.warn('Não consegui buscar o perfil de quem solicitou no Slack: ' + e.message);
  }

  try {
    const stages = await buscarStagesDaArea(area);
    if (!stages.length) throw new Error('Área "' + area + '" não tem etapas configuradas.');
    const primeiraEtapa = stages[0].id;

    const snapCodes = await db.collection('demandas').select('code').get();
    const nums = snapCodes.docs.map(d => parseInt(String(d.data().code || '').replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const code = 'DEM-' + ((nums.length ? Math.max(...nums) : 100) + 1);

    const descricaoFinal = (tipo ? '[' + tipo + '] ' : '') + descricao + (referencia ? '\n\nReferência: ' + referencia : '');

    const nd = {
      code, area, title: titulo, description: descricaoFinal, priority: 'Média',
      assignees: [], requester: solicitanteNome, stageId: primeiraEtapa,
      deadline: prazo, createdAt: new Date().toISOString(), comments: [], links: [],
      origem: 'slack', slackUserId: payload.user.id,
      notificadoAndamento: false, notificadoConcluido: false
    };
    Object.keys(nd).forEach(k => { if (nd[k] === undefined || nd[k] === null) delete nd[k]; });

    await db.collection('demandas').add(nd);
    await db.collection('feed').add({
      code, area,
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      stagePath: 'Nova demanda via Slack',
      action: 'Demanda criada por ' + solicitanteNome + ' via /nova-demanda',
      type: 'new', ts: Date.now()
    });
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel: payload.user.id,
        text: ':white_check_mark: Sua demanda *"' + titulo + '"* (' + code + ') foi criada em ' + area + '! Você recebe uma DM quando ela entrar em andamento e quando for concluída.'
      })
    });
  } catch (e) {
    logger.error('Falha ao criar demanda vinda do Slack: ' + e.message);
    res.status(200).json({ response_action: 'errors', errors: { titulo: 'Deu erro ao criar a demanda, tenta de novo em instantes.' } });
    return;
  }

  res.status(200).send('');
});

/**
 * DM de status pra quem pediu pelo Slack (em andamento / concluída)
 * ---------------------------------------------------------------------
 * Dispara no máximo duas vezes por demanda, só pra quem criou via
 * /nova-demanda (tem slackUserId gravado): uma quando a demanda sai da
 * primeira etapa (entrou em andamento), outra quando chega numa etapa
 * marcada como isDone:true (concluída).
 */
exports.notificarSolicitanteNoSlack = onDocumentUpdated('demandas/{id}', async (event) => {
  const antes  = event.data.before.data();
  const depois = event.data.after.data();

  if (!depois || depois.origem !== 'slack' || !depois.slackUserId) return;
  if (!depois.stageId || antes.stageId === depois.stageId) return; // não mudou de etapa

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { logger.warn('SLACK_BOT_TOKEN não configurado — pulei a notificação de status.'); return; }

  try {
    const stages = await buscarStagesDaArea(depois.area);
    if (!stages.length) return;
    const etapaAtual = stages.find(s => s.id === depois.stageId);
    if (!etapaAtual) return;

    let mensagem = null;
    const atualizacoes = {};

    if (!depois.notificadoConcluido && etapaAtual.isDone) {
      mensagem = ':tada: Sua demanda *"' + (depois.title || '') + '"* (' + (depois.code || '') + ') foi *concluída*!';
      atualizacoes.notificadoConcluido = true;
    } else if (!depois.notificadoAndamento && depois.stageId !== stages[0].id) {
      mensagem = ':hourglass_flowing_sand: Sua demanda *"' + (depois.title || '') + '"* (' + (depois.code || '') + ') entrou em andamento — etapa atual: ' + etapaAtual.name + '.';
      atualizacoes.notificadoAndamento = true;
    }

    if (!mensagem) return;

    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: depois.slackUserId, text: mensagem })
    });
    const resultado = await resp.json();
    if (!resultado.ok) { logger.error('Slack recusou a DM de status: ' + resultado.error); return; }

    await db.collection('demandas').doc(event.params.id).update(atualizacoes);
  } catch (e) {
    logger.error('Falha ao notificar status no Slack: ' + e.message);
  }
});
