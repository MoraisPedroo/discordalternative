/* Diretório de salas — função serverless do Vercel.
 *
 * GET  /api/rooms                  → lista de salas abertas
 * GET  /api/rooms?id=abc123        → uma sala
 * GET  /api/rooms?preview=1&id=…   → prévia (JPEG) da tela de uma sala pública
 * POST /api/rooms                  → host registra/atualiza a sala (heartbeat)
 * POST /api/rooms?action=leave     → host remove a sala
 *
 * Armazena no Upstash Redis (integração do Vercel). Sem as variáveis de
 * ambiente, cai num armazenamento em memória — bom pra testar localmente,
 * mas não confiável em produção.
 *
 * Senhas de salas privadas NUNCA passam por aqui: quem valida é o host, via P2P.
 */
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 30;              // segundos sem heartbeat até a sala sumir
const KEY = 'sala:';
const MAX_ROOMS = 50;
const MAX_PREVIEW = 250000;  // ~180 KB de JPEG em base64

const ID_RE = /^[a-z0-9]{4,16}$/;
const TOKEN_RE = /^[a-z0-9]{16,64}$/;

// ---------------------------------------------------------------------------
// Armazenamento
// ---------------------------------------------------------------------------
async function redis(cmds) {
  const r = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const out = await r.json();
  return out.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

const redisStore = {
  kind: 'redis',
  async get(id) {
    const [v] = await redis([['GET', KEY + 'room:' + id]]);
    return v ? JSON.parse(v) : null;
  },
  async put(room, preview, dropPreview) {
    const cmds = [
      ['SET', KEY + 'room:' + room.id, JSON.stringify(room), 'EX', TTL],
      ['ZADD', KEY + 'rooms', Date.now(), room.id]
    ];
    if (preview) cmds.push(['SET', KEY + 'preview:' + room.id, preview, 'EX', TTL]);
    else if (dropPreview) cmds.push(['DEL', KEY + 'preview:' + room.id]);
    await redis(cmds);
  },
  async list() {
    const [, ids] = await redis([
      ['ZREMRANGEBYSCORE', KEY + 'rooms', 0, Date.now() - TTL * 1000],
      ['ZRANGE', KEY + 'rooms', 0, MAX_ROOMS - 1]
    ]);
    if (!ids || !ids.length) return [];
    const [vals] = await redis([['MGET'].concat(ids.map((id) => KEY + 'room:' + id))]);
    return (vals || []).filter(Boolean).map((v) => JSON.parse(v));
  },
  async del(id) {
    await redis([['DEL', KEY + 'room:' + id, KEY + 'preview:' + id], ['ZREM', KEY + 'rooms', id]]);
  },
  async preview(id) {
    const [v] = await redis([['GET', KEY + 'preview:' + id]]);
    return v;
  }
};

const mem = globalThis.__salaMem || (globalThis.__salaMem = { rooms: new Map(), previews: new Map() });
const alive = (entry) => entry && entry.exp > Date.now();
const memoryStore = {
  kind: 'memory',
  async get(id) { const e = mem.rooms.get(id); return alive(e) ? e.value : null; },
  async put(room, preview, dropPreview) {
    const exp = Date.now() + TTL * 1000;
    mem.rooms.set(room.id, { value: room, exp });
    if (preview) mem.previews.set(room.id, { value: preview, exp });
    else if (dropPreview) mem.previews.delete(room.id);
  },
  async list() {
    const out = [];
    for (const [id, e] of mem.rooms) {
      if (alive(e)) out.push(e.value);
      else { mem.rooms.delete(id); mem.previews.delete(id); }
    }
    return out.slice(0, MAX_ROOMS);
  },
  async del(id) { mem.rooms.delete(id); mem.previews.delete(id); },
  async preview(id) { const e = mem.previews.get(id); return alive(e) ? e.value : null; }
};

const store = REDIS_URL && REDIS_TOKEN ? redisStore : memoryStore;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Limita por caracteres visíveis (não corta emoji no meio) e remove controles.
function cleanStr(s, max) {
  const str = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(str).slice(0, max).join('');
}

function cleanPeople(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 30).map((p) => ({
    name: cleanStr(p && p.name, 24) || 'Anônimo',
    avatar: cleanStr(p && p.avatar, 4) || '❓',
    live: !!(p && p.live),
    muted: !!(p && p.muted)
  }));
}

function publicRoom(r) {
  const out = {
    id: r.id, name: r.name, private: !!r.private, people: r.people || [],
    liveBy: r.liveBy || null, updatedAt: r.updatedAt
  };
  if (!r.private && r.previewAt) out.previewAt = r.previewAt;
  return out;
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_PREVIEW + 20000) throw Object.assign(new Error('too_large'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  try {
    if (req.method === 'GET') {
      if (q.get('preview')) {
        const id = String(q.get('id') || '');
        if (!ID_RE.test(id)) return send(res, 400, { error: 'bad_id' });
        const data = await store.preview(id);
        const m = data && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(data);
        if (!m) return send(res, 404, { error: 'no_preview' });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=120'); // URL já é versionada (&v=)
        return res.end(Buffer.from(m[1], 'base64'));
      }

      if (q.get('id')) {
        const id = String(q.get('id'));
        if (!ID_RE.test(id)) return send(res, 400, { error: 'bad_id' });
        const room = await store.get(id);
        return room ? send(res, 200, { room: publicRoom(room) }) : send(res, 404, { error: 'not_found' });
      }

      const rooms = (await store.list()).map(publicRoom).sort((a, b) =>
        (b.liveBy ? 1 : 0) - (a.liveBy ? 1 : 0) ||
        b.people.length - a.people.length ||
        b.updatedAt - a.updatedAt);
      return send(res, 200, { rooms, store: store.kind });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || '');
      const token = String(body.token || '');
      if (!ID_RE.test(id) || !TOKEN_RE.test(token)) return send(res, 400, { error: 'bad_request' });

      const existing = await store.get(id);
      const tokenHash = sha256(token);
      if (existing && existing.tokenHash !== tokenHash) return send(res, 409, { error: 'taken' });

      if (q.get('action') === 'leave') {
        if (existing) await store.del(id);
        return send(res, 200, { ok: true });
      }

      const isPrivate = !!body.private;
      const people = cleanPeople(body.people);
      const liveBy = cleanStr(body.liveBy, 24) || null;
      let preview = null;
      if (!isPrivate && liveBy && typeof body.preview === 'string' &&
          body.preview.length <= MAX_PREVIEW && body.preview.startsWith('data:image/jpeg;base64,')) {
        preview = body.preview;
      }
      const now = Date.now();
      const room = {
        id,
        name: cleanStr(body.name, 40) || 'Sala',
        private: isPrivate,
        people,
        liveBy,
        updatedAt: now,
        previewAt: preview ? now : (!isPrivate && liveBy && existing ? existing.previewAt : undefined),
        tokenHash
      };
      // Sem ninguém ao vivo (ou sala privada) a prévia antiga é apagada.
      await store.put(room, preview, isPrivate || !liveBy);
      return send(res, 200, { ok: true, store: store.kind });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    if (err && err.status === 413) return send(res, 413, { error: 'too_large' });
    if (err instanceof SyntaxError) return send(res, 400, { error: 'bad_json' });
    console.error('[api/rooms]', err);
    return send(res, 500, { error: 'server_error' });
  }
};
