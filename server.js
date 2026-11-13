"use strict";

// Teste de egress: o Render consegue subir arquivos no Catbox?
// Sem dependencias: apenas Node 20+ (fetch/FormData/Blob nativos).

const http = require("http");

const CATBOX_API = "https://catbox.moe/user/api.php";

// O Catbox fecha a conexao quando o User-Agent esta ausente.
const CATBOX_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

const DEFAULT_USERHASH = "dc0977de4ca1033e5e750d07f";

const MAX_SIZE = 50 * 1024 * 1024;
const TIMEOUT = 120000;

const USERHASH = String(process.env.CATBOX_USERHASH || DEFAULT_USERHASH).trim();
const PORT = Number(process.env.PORT) || 10000;

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

// ---------------------------------------------------------------------------
// Upload para o Catbox
// ---------------------------------------------------------------------------

async function catboxUpload(buffer, filename, userhash) {
  const form = new FormData();

  form.append("reqtype", "fileupload");

  if (userhash) {
    form.append("userhash", userhash);
  }

  form.append("fileToUpload", new Blob([buffer]), filename);

  const started = Date.now();

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

    const text = (await response.text()).trim().slice(0, 500);

    return {
      ok: response.ok,
      httpStatus: response.status,
      body: text,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      error: error.name + ": " + error.message,
      cause: error.cause ? String(error.cause.code || error.cause.message || error.cause) : null,
      durationMs: Date.now() - started
    };
  }
}

function classify(result) {
  if (result.error) return "network-error";

  const body = result.body || "";

  if (result.ok && /^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/.test(body)) {
    return "success";
  }

  if (/invalid uploader/i.test(body)) return "ip-blocked";
  if (/not signed in/i.test(body)) return "auth-error";
  if (!body) return "empty-response";

  return "other";
}

// ---------------------------------------------------------------------------
// Diagnostico do IP de saida
// ---------------------------------------------------------------------------

async function egress() {
  const sources = [
    {
      url: "https://ipinfo.io/json",
      pick: (d) => ({
        ip: d.ip,
        org: d.org,
        city: d.city,
        region: d.region,
        country: d.country
      })
    },
    {
      url: "https://ifconfig.co/json",
      pick: (d) => ({
        ip: d.ip,
        org: d.asn_org,
        city: d.city,
        region: d.region_name,
        country: d.country_iso
      })
    }
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: {
          "User-Agent": CATBOX_USER_AGENT,
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const picked = source.pick(data);

      if (picked.ip) {
        return { ...picked, source: source.url };
      }
    } catch {
      // Tenta a proxima fonte.
    }
  }

  return { ip: null, note: "Nao foi possivel consultar o IP de saida" };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

function tinyFile() {
  const stamp = new Date().toISOString();
  const content =
    "Teste de upload do Render para o Catbox.\n" +
    "Gerado em " + stamp + "\n" +
    "Se voce esta lendo isto, o egress do Render nao foi bloqueado.\n";

  return {
    buffer: Buffer.from(content, "utf8"),
    filename: "render-catbox-test-" + Date.now() + ".txt"
  };
}

async function selftest() {
  const outbound = await egress();
  const file = tinyFile();

  const withHash = await catboxUpload(file.buffer, file.filename, USERHASH);
  const anonymous = await catboxUpload(file.buffer, file.filename, "");

  const results = {
    withUserhash: { ...withHash, verdict: classify(withHash) },
    anonymous: { ...anonymous, verdict: classify(anonymous) }
  };

  const verdicts = [results.withUserhash.verdict, results.anonymous.verdict];

  let conclusion;
  let works = null;

  if (verdicts.includes("success")) {
    works = true;
    conclusion =
      "O Render conseguiu subir no Catbox. Manter o Catbox via proxy externo e viavel.";
  } else if (verdicts.includes("ip-blocked")) {
    works = false;
    conclusion =
      "O Catbox recusou com 'Invalid uploader': o IP de datacenter do Render tambem esta bloqueado. " +
      "Nao adianta trocar de provedor de nuvem; o caminho e outro storage.";
  } else if (verdicts.every((v) => v === "network-error")) {
    conclusion =
      "O Render nao conseguiu nem falar com o Catbox. Problema de rede/timeout, nao de bloqueio.";
  } else {
    conclusion =
      "Resultado inconclusivo. Veja o corpo das respostas abaixo.";
  }

  return {
    testedAt: new Date().toISOString(),
    host: process.env.RENDER ? "render" : "local",
    renderService: process.env.RENDER_SERVICE_NAME || null,
    outbound,
    catbox: "https://catbox.moe",
    userhashConfigured: Boolean(USERHASH),
    results,
    works,
    conclusion
  };
}

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Render -> Catbox</title>
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
  <h1>Render consegue subir no Catbox?</h1>
  <p class="sub">Sobe um arquivo de 1 KB no Catbox a partir do IP do Render e mostra o resultado.</p>
  <button id="go">Rodar teste</button>
  <div id="verdict"></div>
  <pre id="out">Clique em "Rodar teste".</pre>
</main>
<script>
  var go = document.getElementById('go');
  var out = document.getElementById('out');
  var verdict = document.getElementById('verdict');

  go.addEventListener('click', async function () {
    go.disabled = true;
    verdict.className = '';
    out.textContent = 'Testando... (pode levar alguns segundos)';

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/selftest") {
      json(res, 200, await selftest());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/egress") {
      json(res, 200, await egress());
      return;
    }

    // Upload manual: corpo cru + nome do arquivo em ?name=
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const filename = (url.searchParams.get("name") || "teste.txt").replace(/[^A-Za-z0-9._-]/g, "_");
      const buffer = await readBody(req, MAX_SIZE);

      if (!buffer.length) {
        json(res, 400, { error: "Corpo vazio" });
        return;
      }

      const result = await catboxUpload(buffer, filename, USERHASH);

      json(res, 200, {
        ...result,
        filename,
        bytes: buffer.length,
        verdict: classify(result)
      });
      return;
    }

    json(res, 404, { error: "Rota nao encontrada", routes: ["/", "/api/selftest", "/api/egress", "POST /api/upload?name="] });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log("Listening on " + PORT);
});
