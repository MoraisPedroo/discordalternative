# 🛰️ Sala

Alternativa simples ao Discord pra **falar, transmitir a tela e conversar** com os amigos.
Sem cadastro, sem download. Você escolhe um **nome + avatar engraçadinho** (👽🤖👻🦖…),
cria uma sala **pública** ou **privada** e manda o link.

## Recursos

- 🏠 **Lobby com salas abertas** — mostra cada sala com quem está dentro, quem está
  ao vivo e uma **prévia da tela** (atualizada a cada ~10 s).
- 🔒 **Salas privadas com senha** — aparecem com cadeado e **sem prévia**. Só entra
  quem souber a senha.
- 🎙️ **Voz em grupo** — o microfone liga ao entrar (mesh P2P), com botão de mudo.
- 🧹 **Supressão de ruído com IA** — GTCRN (2024) remove teclado, ventilador e barulho
  de fundo. Dá pra trocar por RNNoise, pela do navegador ou desligar.
- 🖥️ **Transmissão de tela** com áudio — **qualquer um** pode transmitir.
- 🟢 **Detecção de fala** — anel verde em quem está falando.
- 🪟 **Janela flutuante (PiP)** — avatares + quem está falando, visível fora da aba.
- ⚙️ **Configurações de áudio** — microfone, saída (fone/caixa), teste de som e
  "ouvir meu microfone" pra comparar os filtros.
- 🎨 **Tema claro e escuro**.

## Publicar no Vercel

1. Suba o repositório no GitHub e importe em [vercel.com](https://vercel.com)
   (**Add New → Project**, Framework Preset: **Other**, sem build). **Deploy**.
2. **Lista de salas** (necessário pra o lobby funcionar direito): no projeto do
   Vercel, abra **Storage → Create Database → Upstash for Redis** (plano grátis) e
   conecte ao projeto. Ele cria as variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN`
   sozinho. Depois faça **Redeploy**.
3. Abra a URL, crie uma sala e mande o link. 🎉

> Sem o passo 2, a lista usa memória da função — funciona às vezes, mas some e
> volta. Entrar por link de convite funciona de qualquer jeito.

### Opcional: TURN (pra amigos com tela preta ou sem voz)

Algumas redes (CGNAT de operadora, 4G, redes de empresa) bloqueiam conexão direta.
Pra esses casos, configure o TURN da Cloudflare (tem cota grátis):

1. No painel da Cloudflare: **Realtime → TURN Server → Create**.
2. No Vercel, adicione as variáveis `CLOUDFLARE_TURN_KEY_ID` e
   `CLOUDFLARE_TURN_API_TOKEN` e faça **Redeploy**.

As credenciais são geradas no servidor (`/api/ice`); o token nunca vai pro navegador.

## Rodar localmente

```bash
npx vercel dev
```

(roda o site e as funções de `/api`). Abra em duas abas pra simular duas pessoas.

## Como funciona

- **Site estático + 2 funções serverless**: `api/rooms.js` (lista de salas) e
  `api/ice.js` (servidores STUN/TURN).
- **Voz e vídeo P2P via WebRTC** ([PeerJS](https://peerjs.com)): vão direto entre
  vocês, sem passar por servidor.
- Quem cria a sala vira o **host**: coordena presença e chat, **confere a senha**
  e mantém a sala na lista. Se o host sair, outra pessoa assume.
- A **senha nunca vai pro servidor**: o navegador manda só um hash (SHA-256) pro
  host comparar, via conexão P2P criptografada. Quem não foi admitido não recebe a
  lista de pessoas e tem chamadas recusadas.
- **Ruído**: `noise.js` monta a cadeia mic → filtro passa-altas → rede neural
  (AudioWorklet/WASM, via [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor))
  → noise gate. Se a IA não carregar, cai sozinha pra supressão do navegador.

## Limitações / notas

- O GTCRN processa a voz a 16 kHz (som tipo "chamada HD", banda até ~8 kHz). Se
  preferir voz mais brilhante, use **IA nítida** (RNNoise) — remove bem menos ruído.
- Salas privadas mostram no lobby os **nomes** de quem está dentro (sem prévia da tela).
- Trocar a saída de áudio funciona no **Chrome/Edge** (`setSinkId`).
- Mesh P2P é ideal pra grupos pequenos (~6-8 pessoas transmitindo/falando).
- O broker público do PeerJS às vezes oscila; se incomodar, dá pra
  [rodar um PeerServer próprio](https://github.com/peers/peerjs-server).

## Estrutura

```
index.html     → interface (lobby, sala, senha, configurações)
styles.css     → temas claro/escuro
app.js         → lobby, salas, presença, chat, voz, tela, fala, PiP
noise.js       → supressão de ruído (GTCRN / RNNoise / navegador)
api/rooms.js   → lista de salas (Upstash Redis)
api/ice.js     → servidores STUN/TURN
```
