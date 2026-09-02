# Instagram automático na Central de Informações — o que fazer

Duas coisas exigem sua ação direta. Eu não tenho acesso pra fazer nenhuma delas
por você — precisa ser alguém com acesso ao Firebase Console e ao Business
Manager do Nibo no Meta.

---

## 1) Ativar Cloud Functions no Firebase (plano Blaze)

1. https://console.firebase.google.com/ → projeto **dash-marketing** → ⚙️ ao
   lado de "Visão geral do projeto" → **Uso e faturamento**
2. Clique em **Modificar plano** → escolha **Blaze (pagamento por utilização)**
3. Cadastre um cartão. **Você não vai ser cobrada** no volume que essa função
   usa (6 execuções por hora, bem abaixo da cota gratuita) — o cartão é só uma
   trava de segurança contra excesso, exigida pelo Google pra qualquer projeto
   no Blaze.

## 2) Criar o app no Meta e conseguir o token

1. https://developers.facebook.com/ → **Meus Apps** → **Criar App** → tipo
   "Empresa"
2. No painel do app, adicione o produto **Instagram Graph API** (ou "Instagram
   Basic Display", dependendo do que aparecer — procure por "Instagram")
3. A conta **@nibosoftware** precisa ser Business ou Creator (não pessoal) e
   estar conectada a uma **Página do Facebook** que o Nibo administra. Confira
   em Configurações do Instagram → Conta → tipo de conta.
4. No **Explorador da API Graph**
   (https://developers.facebook.com/tools/explorer/), selecione o seu app,
   escolha a Página conectada, e gere um **token de usuário** com a permissão
   `instagram_basic` (marque essa permissão na lista antes de gerar)
5. Esse token dura só 1 hora. Troque por um de longa duração (60 dias) nesta
   URL, substituindo os valores entre `< >`:

   ```
   https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<TOKEN_DE_1_HORA>
   ```

   O `APP_ID` e `APP_SECRET` ficam em Configurações do App → Básico.

6. Pra achar o **ID da conta comercial do Instagram** (`igBusinessId`), use o
   Explorador da API Graph com: `GET /me/accounts` (acha o ID da Página) e
   depois `GET /<ID_DA_PAGINA>?fields=instagram_business_account` (acha o ID
   do Instagram vinculado).

## 3) Guardar o token no Firestore (uma vez só)

Com a Firebase CLI instalada e logada (`npm install -g firebase-tools`,
depois `firebase login`), rode na pasta do projeto:

```bash
firebase firestore:set config/instagramToken \
  '{"accessToken":"<TOKEN_DE_60_DIAS>","igBusinessId":"<ID_DA_CONTA>","expiresAt":"<DATA_ISO_DAQUI_60_DIAS>"}' \
  --project dash-marketing-9302b
```

## 4) Guardar o App ID e o App Secret pra renovação automática

```bash
firebase functions:secrets:set META_APP_ID --project dash-marketing-9302b
firebase functions:secrets:set META_APP_SECRET --project dash-marketing-9302b
```

(vai pedir pra colar o valor de cada um — são os mesmos de Configurações do
App → Básico, do passo 2)

## 5) Implantar

Copie a pasta `functions/` pra dentro do repositório `dash-de-mkt` (na raiz,
do lado do `index.html`), depois:

```bash
firebase deploy --only functions --project dash-marketing-9302b
```

---

Depois disso, a sincronização roda sozinha a cada 6 horas, e o token se renova
sozinho toda segunda de manhã, sempre que faltar menos de 15 dias pra vencer.
Se algo falhar (token revogado, permissão retirada), aparece um aviso no
próprio Firestore (`redesSociais/principal.lastSyncError`) — posso fazer esse
erro aparecer na tela da Central também, se você quiser.

**Se travar em algum passo**, me manda a mensagem de erro exata que eu ajudo a
resolver — só não consigo executar os passos 1, 2, 3 e 4 no seu lugar, porque
exigem login nas suas contas do Firebase e do Meta.
