# Teste: o Render consegue subir arquivos no Catbox?

Serviço mínimo (uma dependência zero) que tenta um upload de 1 KB no Catbox a
partir do IP do Render e mostra o veredito. O objetivo é responder, com fato,
se vale a pena manter o Catbox atrás de um proxy hospedado no Render.

## Por que isso importa

O Catbox responde **`412 Invalid uploader`** para IPs de datacenter/CI. Já
confirmamos isso em:

- Cloudflare Workers (`https://institucionais.pages.dev/api/catbox` → 502 `Invalid uploader`)
- GitHub Actions (vários relatos reproduzíveis)
- Netlify Functions, VPS e CI em geral

Um upload a partir de uma conexão residencial funciona. Este teste verifica em
qual dos dois lados o Render cai.

## Como rodar

### 1. Publicar o código

O Render precisa de um repositório Git. Se ainda não tem, crie um repositório
**público** no GitHub só com o conteúdo desta pasta (`server.js`,
`package.json`, `README.md`).

Se for publicar o projeto inteiro, não tem problema: o Render vai usar
`render-catbox-test` como diretório raiz.

### 2. Criar o serviço no Render

1. **New → Web Service**
2. Conecte o repositório
3. **Language**: `Node`
4. **Root Directory**: `render-catbox-test` (omita se o repositório for só essa pasta)
5. **Build Command**: `npm install`
6. **Start Command**: `npm start`
7. **Instance Type**: `Free`

### 3. Rodar o teste

Abra a URL do serviço e clique em **Rodar teste**. Na primeira vez o Render free
pode levar ~50 s para acordar.

Alternativa por linha de comando:

```bash
curl -sS https://SEU-SERVICO.onrender.com/api/selftest | python3 -m json.tool
```

Upload manual de um arquivo real (corpo cru, nome via query):

```bash
curl -sS -X POST "https://SEU-SERVICO.onrender.com/api/upload?name=teste.txt" \
  --data-binary @arquivo.txt | python3 -m json.tool
```

## Como ler o resultado

| `works` | `verdict` | Significado |
|---|---|---|
| `true` | `success` | O Render não foi bloqueado. Manter o Catbox via proxy no Render é viável. |
| `false` | `ip-blocked` | Catbox devolveu `Invalid uploader`. Render = mesmo bloqueio do Workers. Descartar. |
| `false` | `empty-response` | Catbox devolveu 200 com corpo vazio (rate limit ou recusa silenciosa). Repita em alguns minutos. |
| `false` | `network-error` | Render não falou com o Catbox (timeout/DNS). Problema diferente de bloqueio. |
| — | `auth-error` | `412 Not signed in!` — userhash inválido. Não é o caso do teste padrão. |

O teste faz dois uploads: com `userhash` e anônimo. O campo `outbound` mostra o
IP e a operadora (ASN) de saída do Render — útil para documentar o bloqueio.

O `userhash` usa `CATBOX_USERHASH` se estiver definido no ambiente; senão, cai
no valor padrão do projeto.

## Rodando localmente (para comparar)

```bash
cd render-catbox-test
PORT=8777 npm start
# abra http://127.0.0.1:8777 e clique em "Rodar teste"
```

Diferença entre local e Render é exatamente o que queremos medir.

## Aviso

Este é um teste descartável. Se o veredito for `ip-blocked`, apague o serviço
no Render — a alternativa é trocar de storage (Supabase Storage ou Cloudflare
R2), não de nuvem.
