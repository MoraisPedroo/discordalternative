# 🛰️ Sala

Alternativa simples ao Discord pra **falar, transmitir a tela e conversar** com os amigos.
Sem cadastro, sem download, sem backend pago. Você joga o link, a galera entra
escolhendo um **nome + avatar engraçadinho** (👽🤖👻🦖…) e pronto.

## Recursos

- 🎙️ **Voz em grupo** — ao entrar, o microfone já liga (mesh P2P entre todos).
  Botão de **mudo** a qualquer momento.
- 🖥️ **Transmissão de tela** (com áudio da aba/sistema) — **qualquer um** pode
  transmitir, não só o host.
- 💬 **Chat lateral** em tempo real, com lista de quem está na sala.
- 🟢 **Detecção de fala** — quem fala ganha um **anel verde** no avatar (na lista
  e no vídeo).
- 🪟 **Janela flutuante (Picture-in-Picture)** — mostra os avatares + nomes de
  quem está na call e **quem está falando**, visível **mesmo fora da aba**.
- ⚙️ **Configurações de áudio** — escolha o **microfone** e a **saída** (fone /
  caixa), veja o nível do mic e **teste o som** com um bip.
- 🎨 **Tema claro e escuro** (lembra sua preferência).

## Como funciona

- **100% no navegador** — é um site estático (HTML + CSS + JS puro).
- **Voz e vídeo P2P via WebRTC** ([PeerJS](https://peerjs.com)): vão **direto**
  pros seus amigos, sem passar por servidor. Baixa latência e sem custo de banda.
- **Salas por código**: quem cria a sala vira o "host" (coordena a lista de
  presença e o chat). O link de convite fica tipo `seuapp.vercel.app/?sala=abc123`.

## Rodar localmente

Precisa ser servido por HTTP (voz e tela exigem `localhost` ou HTTPS):

```bash
npx serve .
```

Depois abra `http://localhost:3000` em duas abas pra simular duas pessoas.

## Publicar no Vercel

1. Suba este repositório no GitHub.
2. Em [vercel.com](https://vercel.com) → **Add New → Project** → importe o repo.
3. Framework Preset: **Other** (é site estático, sem build). É só clicar **Deploy**.
4. Pegue a URL (ex.: `https://sala.vercel.app`), abra, crie uma sala e mande o
   link pros amigos. 🎉

> HTTPS é obrigatório pra WebRTC (voz/tela) — o Vercel já entrega HTTPS por padrão.

## Limitações / notas

- **Microfone**: o navegador pede permissão ao entrar. Se negar, você ainda
  ouve, conversa no chat e vê as telas — só não transmite voz até liberar.
- **Trocar a saída de áudio** (fone/caixa) funciona no **Chrome/Edge** (usa
  `setSinkId`). No Firefox/Safari o navegador escolhe a saída.
- Usa o **broker público gratuito do PeerJS** só pra os peers se encontrarem.
  Pra um grupo de amigos funciona bem; se quiser mais robustez, dá pra
  [rodar seu próprio PeerServer](https://github.com/peers/peerjs-server).
- Já vêm servidores **STUN/TURN públicos** configurados em `app.js` (Google +
  Open Relay) pra atravessar a maioria das redes. Se algum amigo tiver rede muito
  restritiva, troque por um TURN próprio (ex.: [metered.ca](https://www.metered.ca/tools/openrelay/)).
- Topologia em **estrela** pro chat/presença (host repassa) e **mesh** pra voz e
  vídeo (cada um liga direto pro outro). Ideal pra grupos pequenos (~6-8 pessoas).
- Se o host fechar a aba, a sala tenta se reorganizar: alguém assume como novo host.

## Estrutura

```
index.html   → interface (lobby + sala + configurações)
styles.css   → temas claro/escuro, moderno e minimalista
app.js       → salas, presença, chat, voz, tela, detecção de fala e PiP
```
