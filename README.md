# 🛰️ Sala

Alternativa simples ao Discord pra **transmitir sua tela e conversar** com os amigos.
Sem cadastro, sem download, sem backend pago. Você joga o link, a galera entra
escolhendo um **nome + avatar engraçadinho** (👽🤖👻🦖…) e pronto.

## Como funciona

- **100% no navegador** — é um site estático (HTML + CSS + JS puro).
- **Vídeo P2P via WebRTC** ([PeerJS](https://peerjs.com)): sua tela vai **direto**
  pros seus amigos, sem passar por servidor. Baixa latência e sem custo de banda.
- **Salas por código**: quem cria a sala vira o "host" (coordena a lista de
  presença e o chat). O link de convite fica tipo `seuapp.vercel.app/?sala=abc123`.
- **Qualquer um pode transmitir a tela** (com áudio da aba/sistema), não só o host.
- **Chat lateral** em tempo real + lista de quem está na sala e quem está "ao vivo".

## Rodar localmente

Precisa ser servido por HTTP (o compartilhamento de tela exige `localhost` ou HTTPS):

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

> HTTPS é obrigatório pra WebRTC/compartilhar tela — o Vercel já entrega HTTPS por padrão.

## Limitações / notas

- Usa o **broker público gratuito do PeerJS** só pra os peers se encontrarem.
  Pra um grupo de amigos funciona bem; se quiser mais robustez, dá pra
  [rodar seu próprio PeerServer](https://github.com/peers/peerjs-server).
- Já vêm servidores **STUN/TURN públicos** configurados em `app.js` (Google +
  Open Relay) pra atravessar a maioria das redes. Se algum amigo tiver rede muito
  restritiva, troque por um TURN próprio (ex.: [metered.ca](https://www.metered.ca/tools/openrelay/)).
- Topologia em estrela pro chat (host repassa) e **mesh** pro vídeo (cada
  transmissor liga direto pra cada espectador). Ideal pra grupos pequenos.
- Se o host fechar a aba, a sala tenta se reorganizar: alguém assume como novo host.

## Estrutura

```
index.html   → interface (lobby + sala)
styles.css   → tema escuro, moderno e minimalista
app.js       → salas, presença, chat e transmissão P2P
```
