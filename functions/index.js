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
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

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
