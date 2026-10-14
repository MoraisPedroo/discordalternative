/* =========================================================================
   Supressão de ruído do microfone.

   Modos:
   - 'gtcrn'   IA avançada — GTCRN (ICASSP 2024). Remove ruído com mais força
               (teclado, ventilador, rua). Processa a 16 kHz, então a voz sai
               com banda de ~8 kHz.
   - 'rnnoise' IA nítida — RNNoise (Xiph, 2018). Banda cheia a 48 kHz, voz mais
               "brilhante", mas nos testes removeu ruído de forma bem menos
               consistente que o GTCRN.
   - 'browser' Supressão nativa do navegador (WebRTC) + voiceIsolation quando
               o navegador suporta.
   - 'off'     Som cru do microfone.

   Nos modos de IA a cadeia é:
     mic → passa-altas 85 Hz → rede neural (AudioWorklet/WASM) → noise gate → saída
   Se a IA não carregar, cai pro modo do navegador automaticamente.
   ========================================================================= */
(function () {
  'use strict';

  var PKG = 'https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.4.1/dist/';

  var libPromise = null;
  var binaries = {};
  var modules = new WeakMap(); // AudioContext -> { path: Promise }

  function lib() {
    if (!libPromise) {
      libPromise = import(PKG + 'index.js').catch(function (e) { libPromise = null; throw e; });
    }
    return libPromise;
  }

  function addModule(ctx, path) {
    var m = modules.get(ctx);
    if (!m) { m = {}; modules.set(ctx, m); }
    if (!m[path]) {
      m[path] = ctx.audioWorklet.addModule(PKG + path).catch(function (e) { delete m[path]; throw e; });
    }
    return m[path];
  }

  function binary(key, load) {
    if (!binaries[key]) binaries[key] = load().catch(function (e) { delete binaries[key]; throw e; });
    return binaries[key];
  }

  function aiSupported() {
    return !!(window.isSecureContext && window.AudioWorkletNode && window.WebAssembly);
  }

  function isAi(mode) { return mode === 'gtcrn' || mode === 'rnnoise'; }

  // -------------------------------------------------------------------------
  // Microfone
  // -------------------------------------------------------------------------
  function micConstraints(nativeNs, deviceId) {
    var sup = (navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints()) || {};
    var c = {
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: nativeNs,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 }
    };
    if (sup.voiceIsolation) c.voiceIsolation = nativeNs;
    if (deviceId) c.deviceId = { exact: deviceId };
    return c;
  }

  function getMic(nativeNs, deviceId) {
    return navigator.mediaDevices.getUserMedia({ audio: micConstraints(nativeNs, deviceId), video: false })
      .catch(function (err) {
        // Microfone salvo foi desconectado → usa o padrão
        if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
          return navigator.mediaDevices.getUserMedia({ audio: micConstraints(nativeNs, null), video: false });
        }
        throw err;
      });
  }

  function stopStream(s) {
    if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
  }

  // -------------------------------------------------------------------------
  // Rede neural
  // -------------------------------------------------------------------------
  function buildDenoiser(ctx, L, engine) {
    if (engine === 'gtcrn') {
      return Promise.all([
        binary('gtcrn', function () { return L.loadGtcrn({ url: PKG + 'gtcrn.wasm' }); }),
        addModule(ctx, 'gtcrn/workletProcessor.js')
      ]).then(function (r) { return new L.GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: r[0] }); });
    }
    return Promise.all([
      binary('rnnoise', function () { return L.loadRnnoise({ url: PKG + 'rnnoise.wasm', simdUrl: PKG + 'rnnoise_simd.wasm' }); }),
      addModule(ctx, 'rnnoise/workletProcessor.js')
    ]).then(function (r) { return new L.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: r[0] }); });
  }

  // Carrega tudo ANTES de pedir o microfone: se a IA falhar, já pedimos o mic
  // com a supressão nativa ligada, sem precisar reabrir.
  function prepareAi(ctx, mode) {
    return lib().then(function (L) {
      var engine = mode;
      var denoise = buildDenoiser(ctx, L, mode).catch(function (err) {
        if (mode !== 'gtcrn') throw err;
        console.warn('[noise] GTCRN falhou, usando RNNoise', err);
        engine = 'rnnoise';
        return buildDenoiser(ctx, L, 'rnnoise');
      });
      var gate = addModule(ctx, 'noiseGate/workletProcessor.js').then(function () {
        // Fecha só abaixo de -58 dB e segura 220 ms: corta o chiado residual
        // nas pausas sem engolir o fim das palavras.
        return new L.NoiseGateWorkletNode(ctx, { openThreshold: -50, closeThreshold: -58, holdMs: 220, maxChannels: 1 });
      }).catch(function () { return null; });
      return Promise.all([denoise, gate]).then(function (r) {
        return { node: r[0], gate: r[1], engine: engine };
      });
    });
  }

  function destroyNode(n) {
    if (!n) return;
    try { n.disconnect(); } catch (e) {}
    try { if (n.destroy) n.destroy(); } catch (e) {}
  }

  function wire(ctx, raw, ai, onFail) {
    // Erro dentro do worklet (WASM) não chega como exceção: avisa o app
    ai.node.onprocessorerror = function (e) {
      console.warn('[noise] a rede neural parou', e);
      if (onFail) onFail();
    };

    var src = ctx.createMediaStreamSource(raw);

    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 85;
    hp.Q.value = 0.707;
    // Força mono antes da rede neural (alguns mics entregam estéreo)
    hp.channelCount = 1;
    hp.channelCountMode = 'explicit';
    hp.channelInterpretation = 'speakers';

    var dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;

    src.connect(hp);
    hp.connect(ai.node);
    if (ai.gate) { ai.node.connect(ai.gate); ai.gate.connect(dest); }
    else ai.node.connect(dest);

    var track = dest.stream.getAudioTracks()[0];
    return {
      stream: dest.stream,
      track: track,
      engine: ai.engine,
      fallback: false,
      dispose: function () {
        try { src.disconnect(); } catch (e) {}
        try { hp.disconnect(); } catch (e) {}
        destroyNode(ai.node);
        destroyNode(ai.gate);
        try { track.stop(); } catch (e) {}
        stopStream(raw);
      }
    };
  }

  function passthrough(raw, engine, fallback) {
    return {
      stream: raw,
      track: raw.getAudioTracks()[0],
      engine: engine,
      fallback: !!fallback,
      dispose: function () { stopStream(raw); }
    };
  }

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------
  /**
   * Cria a cadeia do microfone.
   * @param {AudioContext} ctx  contexto a 48 kHz
   * @param {{mode:string, deviceId?:string, onFail?:Function}} opts
   *        onFail é chamado se a rede neural quebrar depois de ligada.
   * @returns {Promise<{stream, track, engine, fallback, dispose}>}
   */
  function create(ctx, opts) {
    var mode = (opts && opts.mode) || 'gtcrn';
    var deviceId = opts && opts.deviceId;
    var onFail = opts && opts.onFail;

    if (!isAi(mode)) {
      return getMic(mode === 'browser', deviceId).then(function (raw) { return passthrough(raw, mode, false); });
    }

    // GTCRN e RNNoise só rodam a 48 kHz (ou 16 kHz); fora disso ficariam mudos
    var prep = aiSupported() && ctx.sampleRate === 48000
      ? prepareAi(ctx, mode).catch(function (err) { console.warn('[noise] IA indisponível', err); return null; })
      : Promise.resolve(null);

    return prep.then(function (ai) {
      if (!ai) {
        return getMic(true, deviceId).then(function (raw) { return passthrough(raw, 'browser', true); });
      }
      return getMic(false, deviceId).then(function (raw) {
        try {
          return wire(ctx, raw, ai, onFail);
        } catch (err) {
          // Ex.: Firefox recusa mic com taxa diferente da do AudioContext
          console.warn('[noise] não deu pra ligar a IA ao microfone', err);
          destroyNode(ai.node); destroyNode(ai.gate); stopStream(raw);
          return getMic(true, deviceId).then(function (r2) { return passthrough(r2, 'browser', true); });
        }
      }, function (err) { destroyNode(ai.node); destroyNode(ai.gate); throw err; });
    });
  }

  /** Processa um stream já existente (usado em testes, sem microfone). */
  function processStream(ctx, stream, mode) {
    return prepareAi(ctx, mode || 'gtcrn').then(function (ai) { return wire(ctx, stream, ai); });
  }

  window.SalaNoise = { create: create, processStream: processStream, aiSupported: aiSupported };
})();
