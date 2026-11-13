"use strict";

// Proxy de upload para o Catbox, rodando no Render.
//
// Motivo: o Catbox recusa IPs de datacenter (Cloudflare Workers, GitHub
// Actions, etc.) com `412 Invalid uploader`. O Render, por algum motivo que
// so eles sabem, nao e recusado. Este servico recebe o upload do Worker e
// repassa ao Catbox.
//
// Sem dependencias: apenas Node 20+ (fetch/FormData/Blob nativos).
//
// Rotas:
//   GET  /health            -> { ok: true } (use num keep-alive para evitar cold start)
//   POST /catbox/file       -> upload de arquivo (corpo cru, metadados nos headers)
//   POST /catbox/action     -> acoes de album em JSON
//   GET  /api/selftest      -> diagnostico de egress
//   GET  /api/egress        -> IP/operadora de saida
//   POST /api/upload?name=  -> upload manual de teste
//   GET  /                  -> pagina de teste

const http = require("http");

// Sobrescrevivel apenas para testes locais (ex.: Catbox falso).
const CATBOX_API = String(
  process.env.CATBOX_API || "https://catbox.moe/user/api.php"
).trim();

// O Catbox fecha a conexao quando o User-Agent esta ausente.
const CATBOX_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

const MAX_SIZE = 50 * 1024 * 1024;
const TIMEOUT = 120000;

// Token compartilhado com o Cloudflare Pages Function. Sem ele, o servico
// seria um relay publico de uploads.
const PROXY_TOKEN = String(process.env.PROXY_TOKEN || "").trim();

// Vazio = upload anonimo. O userhash antigo do projeto faz o Catbox responder
// 200 com corpo vazio (conta restrita/limite), entao nao use por padrao.
const USERHASH = String(process.env.CATBOX_USERHASH || "889ab73d742923a3a0738eb0e").trim();

const PORT = Number(process.env.PORT) || 10000;

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > limit) {
        reject(new Error("Corpo da requisicao excede o limite"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function tokenOk(req) {
  if (!PROXY_TOKEN) return false;

  const header = String(req.headers["x-proxy-token"] || "").trim();

  if (header.length !== PROXY_TOKEN.length) return false;

  // Comparacao em tempo constante.
  let diff = 0;

  for (let i = 0; i < header.length; i += 1) {
    diff |= header.charCodeAt(i) ^ PROXY_TOKEN.charCodeAt(i);
  }

  return diff === 0;
}

function cleanFilename(name) {
  const base = String(name || "").split("/").pop().split("\\").pop();
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return safe || "arquivo";
}

// ---------------------------------------------------------------------------
// Catbox
// ---------------------------------------------------------------------------

class CatboxError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "CatboxError";
    this.status = status;
  }
}

async function catboxPost(form) {
  try {
    const response = await fetch(CATBOX_API, {
      method: "POST",
      headers: {
        "User-Agent": CATBOX_USER_AGENT,
        "Accept": "*/*"
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT)
    });

    return {
      ok: response.ok,
      httpStatus: response.status,
      body: (await response.text()).trim().slice(0, 2000)
    };
  } catch (error) {
    const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");

    throw new CatboxError(
      timedOut
        ? "O Catbox nao respondeu a tempo. Tente novamente."
        : "Nao foi possivel alcancar o Catbox.",
      502
    );
  }
}

function catboxError(result) {
  const text = result.body || `Catbox HTTP ${result.httpStatus}`;

  console.error("Catbox error:", result.httpStatus, text.slice(0, 300));

  if (/not signed in/i.test(text)) {
    return new CatboxError(
      "CATBOX_USERHASH invalido ou nao configurado no proxy.",
      502
    );
  }

  if (/invalid uploader/i.test(text)) {
    return new CatboxError(
      "O Catbox recusou o IP do Render (Invalid uploader). O bloqueio mudou de faixa.",
      502
    );
  }

  if (/no album found/i.test(text) || /didn't belong/i.test(text)) {
    return new CatboxError(text, 400);
  }

  if (result.httpStatus >= 500) {
    return new CatboxError(`Catbox indisponivel (HTTP ${result.httpStatus}).`, 502);
  }

  return new CatboxError(text, 502);
}

function validCatboxUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "files.catbox.moe" &&
      parsed.pathname.split("/").length === 2
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Operacoes
// ---------------------------------------------------------------------------

function addUserhash(form) {
  if (USERHASH) form.append("userhash", USERHASH);
  return form;
}

async function uploadFile(buffer, filename, album) {
  const form = new FormData();

  form.append("reqtype", "fileupload");
  if (USERHASH) form.append("userhash", USERHASH);
  form.append("fileToUpload", new Blob([buffer]), filename);

  const result = await catboxPost(form);

  if (!result.ok) throw catboxError(result);

  // O Catbox responde 200 com corpo vazio em casos de recusa silenciosa:
  // rate limit, conta restrita (userhash) ou bloqueio de IP.
  if (!result.body) {
    throw new CatboxError(
      USERHASH
        ? "Catbox respondeu vazio. O CATBOX_USERHASH configurado parece restrito; remova-o para enviar anonimamente."
        : "Catbox respondeu vazio (rate limit). Aguarde alguns minutos e tente novamente.",
      502
    );
  }

  if (!validCatboxUrl(result.body)) {
    throw new CatboxError(`Resposta inesperada do Catbox: ${result.body.slice(0, 200)}`, 502);
  }

  const url = new URL(result.body).href;
  const uploaded = url.split("/").pop();

  if (!album) {
    return { url, filename: uploaded };
  }

  await addToAlbum(uploaded, album);

  return {
    url,
    filename: uploaded,
    short: album,
    album: `https://catbox.moe/c/${album}`
  };
}

async function albumAction(fields) {
  const form = new FormData();

  addUserhash(form);

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  const result = await catboxPost(form);

  if (!result.ok) throw catboxError(result);

  if (fields.reqtype === "createalbum") {
    const match = result.body.match(/https:\/\/catbox\.moe\/c\/([a-zA-Z0-9]+)/);

    if (!match) {
      throw new CatboxError(result.body || "O Catbox nao retornou um album.", 502);
    }

    return { short: match[1] };
  }

  return { result: result.body };
}

async function addToAlbum(filename, short) {
  return albumAction({ reqtype: "addtoalbum", short, files: filename });
}

function validShort(short) {
  return typeof short === "string" && /^[a-zA-Z0-9]+$/.test(short);
}

function validFiles(files) {
  if (typeof files !== "string" || !files.trim()) return null;

  const names = files.trim().split(/\s+/);

  if (names.length > 500 || names.some((name) => !/^[a-zA-Z0-9._-]+$/.test(name))) {
    return null;
  }

  return names.join(" ");
}

// ---------------------------------------------------------------------------
// Diagnostico
// ---------------------------------------------------------------------------

async function egress() {
  const sources = [
    {
      url: "https://ipinfo.io/json",
      pick: (d) => ({ ip: d.ip, org: d.org, city: d.city, region: d.region, country: d.country })
    },
    {
      url: "https://ifconfig.co/json",
      pick: (d) => ({ ip: d.ip, org: d.asn_org, city: d.city, region: d.region_name, country: d.country_iso })
    }
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: { "User-Agent": CATBOX_USER_AGENT, "Accept": "application/json" },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const picked = source.pick(data);

      if (picked.ip) return { ...picked, source: source.url };
    } catch {
      // Tenta a proxima fonte.
    }
  }

  return { ip: null, note: "Nao foi possivel consultar o IP de saida" };
}

function classify(result) {
  if (result.error) return "network-error";

  const body = result.body || "";

  if (result.ok && validCatboxUrl(body)) return "success";

  if (/invalid uploader/i.test(body)) return "ip-blocked";
  if (/not signed in/i.test(body)) return "auth-error";
  if (!body) return "empty-response";

  return "other";
}

async function probeUpload(userhash) {
  const form = new FormData();
  const stamp = new Date().toISOString();

  form.append("reqtype", "fileupload");
  if (userhash) form.append("userhash", userhash);
  form.append(
    "fileToUpload",
    new Blob([`Diagnostico de egress do Render.\n${stamp}\n`]),
    `diag-${Date.now()}.txt`
  );

  try {
    const response = await fetch(CATBOX_API, {
      method: "POST",
      headers: { "User-Agent": CATBOX_USER_AGENT, "Accept": "*/*" },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT)
    });

    return {
      ok: response.ok,
      httpStatus: response.status,
      body: (await response.text()).trim().slice(0, 500),
      durationMs: undefined
    };
  } catch (error) {
    return {
      ok: false,
      error: `${error.name}: ${error.message}`,
      cause: error.cause ? String(error.cause.code || error.cause.message) : null
    };
  }
}

async function selftest() {
  const outbound = await egress();
  const withHash = await probeUpload(USERHASH);
  const anonymous = await probeUpload("");

  const results = {
    configuredUserhash: { ...withHash, verdict: classify(withHash) },
    anonymous: { ...anonymous, verdict: classify(anonymous) }
  };

  const verdicts = [results.configuredUserhash.verdict, results.anonymous.verdict];

  let works = null;
  let conclusion;

  if (verdicts.includes("success")) {
    works = true;
    conclusion = USERHASH
      ? "O Render consegue subir no Catbox."
      : "O Render consegue subir no Catbox (anonimo).";
  } else if (verdicts.includes("ip-blocked")) {
    works = false;
    conclusion = "O Catbox recusou o IP do Render (Invalid uploader).";
  } else if (verdicts.every((v) => v === "network-error")) {
    conclusion = "O Render nao conseguiu falar com o Catbox (rede/timeout).";
  } else {
    conclusion = "Resultado inconclusivo; veja os corpos das respostas.";
  }

  return {
    testedAt: new Date().toISOString(),
    host: process.env.RENDER ? "render" : "local",
    renderService: process.env.RENDER_SERVICE_NAME || null,
    outbound,
    userhashConfigured: Boolean(USERHASH),
    proxyTokenConfigured: Boolean(PROXY_TOKEN),
    results,
    works,
    conclusion
  };
}

// ---------------------------------------------------------------------------
// Pagina de teste
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy Catbox</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px 20px; background: #0e1116; color: #d7dde5;
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #8b97a8; margin: 0 0 24px; }
  button { background: #2f6feb; color: #fff; border: 0; border-radius: 8px;
           padding: 11px 18px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  #verdict { margin: 18px 0; padding: 14px 16px; border-radius: 10px;
             background: #171c24; border-left: 3px solid #2f6feb; display: none; }
  #verdict.show { display: block; }
  pre { background: #12171f; border: 1px solid #232b36; border-radius: 10px;
        padding: 16px; overflow: auto; font-size: 12.5px; line-height: 1.5; }
</style>
</head>
<body>
<main>
  <h1>Proxy Catbox no Render</h1>
  <p class="sub">Diagnostico de egress e status da configuracao.</p>
  <button id="go">Rodar diagnostico</button>
  <div id="verdict"></div>
  <pre id="out">Clique em "Rodar diagnostico".</pre>
</main>
<script>
  var go = document.getElementById('go');
  var out = document.getElementById('out');
  var verdict = document.getElementById('verdict');

  go.addEventListener('click', async function () {
    go.disabled = true;
    verdict.className = '';
    out.textContent = 'Testando...';

    try {
      var response = await fetch('/api/selftest');
      var data = await response.json();
      out.textContent = JSON.stringify(data, null, 2);
      verdict.textContent = data.conclusion;
      verdict.className = 'show';
      verdict.style.borderLeftColor = data.works === true ? '#2ea043'
        : data.works === false ? '#d9534f' : '#d29922';
    } catch (error) {
      out.textContent = 'Falhou: ' + error;
    } finally {
      go.disabled = false;
    }
  });
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && path === "/health") {
      json(res, 200, {
        ok: true,
        uptimeSeconds: Math.round(process.uptime()),
        proxyTokenConfigured: Boolean(PROXY_TOKEN),
        userhashConfigured: Boolean(USERHASH)
      });
      return;
    }

    if (req.method === "GET" && path === "/api/selftest") {
      json(res, 200, await selftest());
      return;
    }

    if (req.method === "GET" && path === "/api/egress") {
      json(res, 200, await egress());
      return;
    }

    // ---- Relay usado pelo Cloudflare Pages Function --------------------

    if (path === "/catbox/file" || path === "/catbox/action") {
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }

      if (!PROXY_TOKEN) {
        json(res, 503, {
          error: "PROXY_TOKEN nao configurado no Render. Defina a variavel de ambiente e reinicie o servico."
        });
        return;
      }

      if (!tokenOk(req)) {
        json(res, 401, { error: "Token invalido" });
        return;
      }

      if (path === "/catbox/file") {
        const filename = cleanFilename(
          decodeURIComponent(String(req.headers["x-filename"] || "arquivo"))
        );
        const album = String(req.headers["x-album"] || "").trim();

        if (album && !validShort(album)) {
          json(res, 400, { error: "Album invalido" });
          return;
        }

        const contentLength = Number(req.headers["content-length"] || 0);

        if (contentLength && contentLength > MAX_SIZE) {
          json(res, 413, { error: "Arquivo excede o limite de 50 MB" });
          return;
        }

        const buffer = await readBody(req, MAX_SIZE);

        if (!buffer.length) {
          json(res, 400, { error: "Arquivo vazio" });
          return;
        }

        const uploaded = await uploadFile(buffer, filename, album || null);

        json(res, 200, { ...uploaded, bytes: buffer.length });
        return;
      }

      // /catbox/action
      const raw = await readBody(req, 256 * 1024);
      let payload;

      try {
        payload = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        json(res, 400, { error: "JSON invalido" });
        return;
      }

      const action = String(payload.action || "");

      if (action === "createalbum") {
        json(res, 200, await albumAction({
          reqtype: "createalbum",
          title: String(payload.title || ""),
          desc: String(payload.desc || "")
        }));
        return;
      }

      if (action === "deletealbum") {
        if (!validShort(payload.short)) {
          json(res, 400, { error: "Album invalido" });
          return;
        }

        json(res, 200, await albumAction({ reqtype: "deletealbum", short: payload.short }));
        return;
      }

      if (action === "addtoalbum" || action === "deletefiles") {
        const files = validFiles(payload.files);

        if (!files) {
          json(res, 400, { error: "Lista de arquivos invalida" });
          return;
        }

        if (action === "addtoalbum") {
          if (!validShort(payload.short)) {
            json(res, 400, { error: "Album invalido" });
            return;
          }

          json(res, 200, await albumAction({
            reqtype: "addtoalbum",
            short: payload.short,
            files
          }));
          return;
        }

        json(res, 200, await albumAction({ reqtype: "deletefiles", files }));
        return;
      }

      json(res, 400, { error: "Acao desconhecida", available: ["createalbum", "deletealbum", "addtoalbum", "deletefiles"] });
      return;
    }

    // ---- Upload manual de teste ----------------------------------------

    if (req.method === "POST" && path === "/api/upload") {
      const filename = cleanFilename(url.searchParams.get("name") || "teste.txt");
      const buffer = await readBody(req, MAX_SIZE);

      if (!buffer.length) {
        json(res, 400, { error: "Corpo vazio" });
        return;
      }

      try {
        const uploaded = await uploadFile(buffer, filename, null);
        json(res, 200, { ok: true, ...uploaded, bytes: buffer.length, verdict: "success" });
      } catch (error) {
        json(res, error.status || 502, {
          ok: false,
          error: error.message,
          verdict: classify({ error: error.message })
        });
      }

      return;
    }

    json(res, 404, {
      error: "Rota nao encontrada",
      routes: ["/", "/health", "/api/selftest", "/api/egress", "POST /catbox/file", "POST /catbox/action", "POST /api/upload?name="]
    });
  } catch (error) {
    if (error instanceof CatboxError) {
      json(res, error.status, { error: error.message });
      return;
    }

    console.error("Erro no proxy:", error);
    json(res, 500, { error: "Erro interno do proxy" });
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
  console.log(`Proxy token: ${PROXY_TOKEN ? "configurado" : "AUSENTE"}`);
  console.log(`Userhash: ${USERHASH ? "configurado" : "anonimo"}`);
});
