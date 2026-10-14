/* Servidores ICE (STUN/TURN) para o WebRTC.
 *
 * Sem configuração devolve só STUN — funciona na maioria das redes.
 * Pra amigos atrás de CGNAT/rede restritiva (tela preta, sem voz), configure o
 * TURN gratuito da Cloudflare com as variáveis:
 *   CLOUDFLARE_TURN_KEY_ID e CLOUDFLARE_TURN_API_TOKEN
 * As credenciais são geradas aqui no servidor (o token nunca vai pro navegador).
 */
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

module.exports = async function handler(req, res) {
  let iceServers = STUN;
  let turn = false;
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (keyId && apiToken) {
    try {
      const r = await fetch(
        'https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 6 * 60 * 60 })
        }
      );
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data.iceServers)) {
          // Navegadores bloqueiam a porta 53 — remover evita esperar timeout.
          iceServers = data.iceServers.map((s) => ({
            ...s,
            urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u))
          })).filter((s) => s.urls.length);
          turn = true;
        }
      } else {
        console.error('[api/ice] cloudflare', r.status);
      }
    } catch (err) {
      console.error('[api/ice]', err);
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ iceServers, turn }));
};
