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
 * DM automática no Slack quando uma demanda entra em etapa de aprovação
 * ---------------------------------------------------------------------
 * Dispara sempre que o campo stageId de uma demanda muda para uma etapa
 * marcada como isApproval:true (Aprovação/Validação/Homologação, conforme
 * a área). A mensagem é enviada por DM direta à Mariana Araújo.
 *
 * O que fazer antes de implantar:
 *   1. Criar um Slack App em https://api.slack.com/apps, adicionar os
 *      Bot Token Scopes "chat:write" e "users:read.email", instalar no
 *      workspace da Nibo, e copiar o Bot User OAuth Token (começa com
 *      xoxb-).
 *   2. Guardar o token como secret (NUNCA como variável comum), rodando:
 *
 *      firebase functions:secrets:set SLACK_BOT_TOKEN
 *      (cola o valor xoxb-... quando pedir)
 *
 *   3. firebase deploy --only functions
 *
 * O token nunca fica no código nem é exposto ao cliente — só o Admin
 * SDK do servidor o acessa, via process.env.SLACK_BOT_TOKEN.
 */
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');

const MARIANA_EMAIL = 'mariana.araujo@nibo.com.br';
let marianaSlackIdCache = null;

async function getMarianaSlackId(token) {
  if (marianaSlackIdCache) return marianaSlackIdCache;
  const resp = await fetch('https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(MARIANA_EMAIL), {
    headers: { Authorization: 'Bearer ' + token }
  });
  const dados = await resp.json();
  if (!dados.ok || !dados.user) {
    throw new Error('Não achei a Mariana no Slack pelo e-mail ' + MARIANA_EMAIL + ': ' + (dados.error || 'motivo desconhecido'));
  }
  marianaSlackIdCache = dados.user.id;
  return marianaSlackIdCache;
}

async function encontrarStage(area, stageId) {
  const doc = await db.collection('config').doc('pipes').get();
  const pipes = (doc.exists && doc.data().data) || {};
  const stages = pipes[area] || [];
  return stages.find(s => s.id === stageId) || null;
}

exports.notificarAprovacaoNoSlack = onDocumentUpdated('demandas/{id}', async (event) => {
  const antes  = event.data.before.data();
  const depois = event.data.after.data();

  if (!depois || !depois.stageId || antes.stageId === depois.stageId) return; // não mudou de etapa

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    logger.warn('SLACK_BOT_TOKEN não configurado — pulei a notificação de aprovação. Veja o topo deste arquivo pra configurar.');
    return;
  }

  const novaEtapa = await encontrarStage(depois.area, depois.stageId);
  if (!novaEtapa || !novaEtapa.isApproval) return; // não é etapa de aprovação, nada a fazer

  try {
    const userId = await getMarianaSlackId(token);
    const texto = ':rotating_light: *Nova demanda aguardando sua aprovação*\n'
      + '*' + (depois.title || 'Sem título') + '*  (' + (depois.code || event.params.id) + ')\n'
      + 'Área: ' + depois.area + '  •  Etapa: ' + novaEtapa.name + '\n'
      + 'Solicitante: ' + (depois.requester || '—');

    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: userId, text: texto })
    });
    const dados = await resp.json();
    if (!dados.ok) logger.error('Slack recusou o envio da DM: ' + dados.error);
    else logger.info('DM de aprovação enviada à Mariana — demanda ' + (depois.code || event.params.id));
  } catch (e) {
    logger.error('Falha ao notificar aprovação no Slack: ' + e.message);
  }
});

/**
 * Solicitar demanda direto pelo Slack (/nova-demanda)
 * ---------------------------------------------------------------------
 * Duas funções HTTP que, juntas, fazem o mesmo que o formulário
 * solicitar.html — só que dentro do Slack, via um Slash Command que
 * abre um formulário (modal nativo do Slack):
 *
 *  1) slackComandoNovaDemanda — recebe o Slash Command e abre o modal.
 *  2) slackInteracoesNovaDemanda — recebe o modal preenchido, valida,
 *     grava em Firestore (solicitacoes) exatamente como o formulário
 *     faz, e manda uma DM de confirmação pra quem pediu.
 *
 * O que fazer antes de implantar:
 *   1. No Slack App (o mesmo criado para a DM de aprovação), vá em
 *      "Basic Information" e copie o "Signing Secret". Guarde como
 *      secret (nunca como variável comum):
 *
 *        firebase functions:secrets:set SLACK_SIGNING_SECRET
 *
 *   2. Em "OAuth & Permissions" → "Bot Token Scopes", adicione também
 *      users:read (além de chat:write e users:read.email que já
 *      devem estar lá). Reinstale o app no workspace depois de mudar
 *      os scopes.
 *
 *   3. firebase deploy --only functions
 *      (isso vai imprimir as URLs de cada função no terminal — copie
 *      as duas, algo como:
 *      https://us-central1-dash-marketing-9302b.cloudfunctions.net/slackComandoNovaDemanda
 *      https://us-central1-dash-marketing-9302b.cloudfunctions.net/slackInteracoesNovaDemanda)
 *
 *   4. Em "Slash Commands", crie o comando /nova-demanda e cole a URL
 *      de slackComandoNovaDemanda no campo "Request URL".
 *
 *   5. Em "Interactivity & Shortcuts", ative e cole a URL de
 *      slackInteracoesNovaDemanda no campo "Request URL".
 *
 *   6. Reinstale o app no workspace uma última vez pra tudo entrar em
 *      vigor.
 */

const TIPOS_MATERIAL   = ['Arte / peça gráfica','Post para redes sociais','Landing page','E-mail / disparo','Vídeo','Apresentação','Outro'];
const SETORES_SOLICIT  = ['RH','Comercial','Produto','Financeiro','Customer Success','Suporte','Diretoria','Outro'];

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

exports.slackComandoNovaDemanda = onRequest(async (req, res) => {
  if (!verificarAssinaturaSlack(req)) { res.status(401).send('assinatura inválida'); return; }

  const view = {
    type: 'modal',
    callback_id: 'nova_demanda_form',
    title:  { type: 'plain_text', text: 'Nova solicitação' },
    submit: { type: 'plain_text', text: 'Enviar pedido' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      { type: 'input', block_id: 'titulo', label: { type: 'plain_text', text: 'O que você precisa' },
        element: { type: 'plain_text_input', action_id: 'valor',
          placeholder: { type: 'plain_text', text: 'Ex: banner para a campanha de vagas de agosto' } } },
      { type: 'input', block_id: 'setor', label: { type: 'plain_text', text: 'Seu setor' },
        element: { type: 'static_select', action_id: 'valor', options: opcoesSelect(SETORES_SOLICIT) } },
      { type: 'input', block_id: 'tipo', label: { type: 'plain_text', text: 'Tipo de material' },
        element: { type: 'static_select', action_id: 'valor', options: opcoesSelect(TIPOS_MATERIAL) } },
      { type: 'input', block_id: 'descricao', label: { type: 'plain_text', text: 'Contexto e objetivo' },
        element: { type: 'plain_text_input', action_id: 'valor', multiline: true,
          placeholder: { type: 'plain_text', text: 'Para que serve, onde vai ser usado, qual mensagem precisa passar...' } } },
      { type: 'input', block_id: 'prazo', label: { type: 'plain_text', text: 'Precisa para quando' },
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
  const setor      = valores.setor.valor.selected_option ? valores.setor.valor.selected_option.value : '';
  const tipo       = valores.tipo.valor.selected_option ? valores.tipo.valor.selected_option.value : '';
  const prazo      = valores.prazo.valor.selected_date || '';
  const referencia = (valores.referencia.valor.value || '').trim();

  const erros = {};
  if (!titulo) erros.titulo = 'Escreva em uma linha o que você precisa.';
  if (descricao.length < 15) erros.descricao = 'Conte um pouco mais no contexto — sem isso o time precisa voltar para perguntar.';
  if (Object.keys(erros).length) { res.status(200).json({ response_action: 'errors', errors: erros }); return; }

  const token = process.env.SLACK_BOT_TOKEN;
  let solicitanteNome = payload.user.username, solicitanteEmail = '';
  try {
    const infoResp = await fetch('https://slack.com/api/users.info?user=' + payload.user.id, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const info = await infoResp.json();
    if (info.ok) {
      solicitanteNome  = info.user.real_name || info.user.name;
      solicitanteEmail = (info.user.profile && info.user.profile.email) || '';
    }
  } catch (e) {
    logger.warn('Não consegui buscar o perfil de quem solicitou no Slack: ' + e.message);
  }

  const dados = {
    titulo, descricao, setor, tipo, prazo, referencia,
    solicitante: solicitanteNome, email: solicitanteEmail,
    status: 'novo', createdAt: new Date().toISOString(), ts: Date.now(),
    origem: 'slack'
  };

  try {
    const ref = await db.collection('solicitacoes').add(dados);
    await db.collection('feed').add({
      code: 'PED-' + ref.id.slice(0, 5).toUpperCase(),
      area: setor,
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      stagePath: 'Novo pedido externo (Slack)',
      action: '@Mariana Araújo, novo pedido de ' + setor + ': "' + titulo + '" (' + solicitanteNome + ')',
      type: 'new'
    });
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel: payload.user.id,
        text: ':white_check_mark: Seu pedido *"' + titulo + '"* foi enviado! A Mariana vai revisar e definir prioridade em breve.'
      })
    });
  } catch (e) {
    logger.error('Falha ao salvar solicitação vinda do Slack: ' + e.message);
    res.status(200).json({ response_action: 'errors', errors: { titulo: 'Deu erro ao salvar, tenta de novo em instantes.' } });
    return;
  }

  res.status(200).send('');
});
