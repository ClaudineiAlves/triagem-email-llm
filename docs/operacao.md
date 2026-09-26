[← README](../README.md)

# Operação

Ajustes, backfill, auditoria e armadilhas conhecidas.

## Ajustar a classificação

Tudo no `config.yaml` (sem tocar no fluxo) — depois `docker compose restart`:

- **Categorias**: edite a lista `categories` (lembre de criar o label e mapear o ID).
- **Prompt**: edite `prompt_template` / `system_prompt`.
- **Limiar**: `confidence_threshold` (padrão 0.6).
- **Multi-label**: `multi_label: true` aplica também `Ação necessária` quando
  `needs_action=true`. Coloque `false` para label único.
- **Modelo**: `model` (padrão `llama3.1`; ex.: `qwen2.5:7b`, `gemma2:9b` — rode
  `ollama pull <modelo>` antes). `ollama_url` é o endereço do Ollama visto do container.

## Backfill — classificar emails antigos

A triagem ao vivo (`workflow.json`) só pega emails **novos** (o Gmail Trigger faz polling
do que chega). Para classificar o que **já está na caixa**, use o `backfill.json`: um fluxo
separado, **descartável**, que varre o histórico em lotes e reaproveita os mesmos nós
`Classificar → Aplicar label → Log`.

**Fluxo:** `Schedule (a cada 15 min)` → `Buscar emails` (Gmail *Get Many*) → `Classificar`
→ `Aplicar label` **+** `Log`. A cada disparo processa um **lote de 30**, etiqueta, grava e
termina. Como todo email recebe ao menos um label, o filtro `-has:userlabels` esvazia
sozinho — e o backfill **para** quando não acha mais nada.

**Como rodar:**

1. **Importe num workflow VAZIO** (Create workflow → Start from scratch → ⋯ → Import from
   File → `backfill.json`). ⚠️ Importar por cima de um fluxo existente **mescla e renomeia**
   os nós (`Classificar` → `Classificar1`), quebrando referências internas.
2. Religue a credencial Gmail nos dois nós Gmail (**Buscar emails** e **Aplicar label**).
3. **Ative** (toggle Active) — ele dispara sozinho a cada 15 min. Para começar já, clique
   **Execute workflow** uma vez.
4. Acompanhe pelo log (`wc -l ~/.n8n/triagem-log.jsonl`). **Desative** quando parar de crescer
   (ou quando o nó **Buscar emails** retornar 0).

**Escopo (filtro do nó `Buscar emails`):**

- `newer_than:90d -has:userlabels` — últimos 3 meses.
- `-has:userlabels` — **conta inteira** (pode ser milhares de emails / vários dias).

**Por que essas escolhas (armadilhas reais):**

- **Lote pequeno (30) + `N8N_RUNNERS_TASK_TIMEOUT=1800`:** o Code node morre aos 300s por
  padrão, e o Ollama leva ~24s/email na CPU — lote grande estoura. Ver `docker-compose.yml`.
- **`simple: true` no Gmail *Get Many*:** com Simplify **off** ele baixa o corpo inteiro de
  cada msg (N+1 chamadas) e a conexão **trava/timeout**. Com `simple: true` pega só
  metadados (rápido) e ainda traz `from`/`subject`/`snippet`.
- **`Schedule` + `limit`, nunca `Return All`:** puxar centenas de uma vez estoura; lotes
  agendados independentes são resilientes (um erro num lote não derruba os outros).
- **`onError: continueRegularOutput` + retry:** um email problemático é pulado, não trava o lote.

**Seguro e resumível:** cada email ganha ≥1 label e o filtro exclui os já feitos, então
re-executar continua de onde parou — nunca reprocessa nem perde nada.

## Critérios de aceite — como isso é atendido

- **Etiquetado em até 24h**: backfill 2x/dia, às 09:00 e 21:00 (era "< 5 min" com o
  trigger de 2 min, trocado por economia de RAM — ver [Fluxo](../README.md#fluxo)).
- **Nunca sem label**: qualquer falha/baixa confiança cai em `_Revisar`.
- **Falha não trava nem reprocessa**: erro é capturado no Code node (vira `_Revisar`);
  como o email passa a ter label, o filtro `-has:userlabels` o exclui no próximo poll.
- **Config externo**: categorias/prompt/limiar em `config.yaml`.
- **Log estruturado**: `~/.n8n/triagem-log.jsonl` (uma linha JSON por email).

## Auditar / refinar

```bash
tail -n 20 ~/.n8n/triagem-log.jsonl
# emails que caíram em revisão:
grep '"label":"_Revisar"' ~/.n8n/triagem-log.jsonl
# contagem por categoria (precisa do jq):
jq -r '.label' ~/.n8n/triagem-log.jsonl | sort | uniq -c | sort -rn
```

## Troubleshooting — armadilhas comuns

Problemas que aparecem na prática e como resolver:

### Setup / Docker
- **`no configuration file provided: not found`** ao subir o n8n → você rodou `docker
  compose` fora da pasta do projeto. O compose monta `./config.yaml` por caminho relativo;
  rode **dentro de `email_agent/`**.
- **Tudo cai em `_Revisar` / o nó `Classificar` dá timeout de rede** → o container não
  alcança o Ollama no host. Quase sempre é **firewall** (ufw/iptables) bloqueando a bridge
  do Docker. Libere a porta do Ollama:
  ```bash
  sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp   # (na Oracle: regra iptables equivalente)
  docker exec n8n wget -qO- http://host.docker.internal:11434/api/tags   # deve listar o llama3.1
  ```
  Confirme também onde o Ollama escuta com `ss -ltn | grep 11434`: `172.17.0.1` no setup
  local, `0.0.0.0` na VM da Oracle. Se aparecer `127.0.0.1`, o drop-in do
  [passo 2 do setup](setup.md#2-docker-ollama-na-bridge-e-n8n) não foi aplicado.

### Credencial Gmail (OAuth)
- **`Error 403: access_denied`** ao conectar → seu email não está como **Test user** na
  tela de consentimento (Audience → Test users).
- **`redirect_uri_mismatch`** → a *Authorized redirect URI* no Google precisa ser
  **exatamente** `http://localhost:5678/rest/oauth2-credential/callback` (sem barra final).
  Mudanças podem levar alguns minutos para valer.
- **`401: invalid_client` / "OAuth client was not found"** → Client ID ou Secret
  incompletos/errados no n8n (cuidado ao copiar — recole do JSON, sem cortar dígitos).
- **Não consigo ver o Client Secret** → o Google só mostra **uma vez**. Em
  *Clients → seu client → Client secrets*, clique **Add secret** e copie o novo na hora.
- **Cuidado:** a *redirect URI* vai em **Authorized redirect URIs**, não em *Authorized
  JavaScript origins* (essa fica **vazia**).

### Backfill
- **`Task execution timed out after 300 seconds`** (Code node morto) → o Ollama é lento
  (~24s/email na CPU) e o n8n mata Code nodes aos 300s. Use **lotes pequenos** (≤30) e suba
  `N8N_RUNNERS_TASK_TIMEOUT=1800` no `docker-compose.yml`.
- **Gmail "Get Many" trava / `connection timed out`** → estava com **Simplify off** (baixa o
  corpo de cada email, N+1 chamadas). Use **`simple: true`** (só metadados — rápido e ainda
  traz `from`/`subject`/`snippet`). E **nunca `Return All`** com centenas; use `limit`.
- **Importei e os nós viraram `Classificar1`/`Log1` e quebrou** → você importou por cima de
  um fluxo existente. Importe sempre num **workflow vazio**.
- **O backfill não repete sozinho** → o **Schedule Trigger** só dispara com o workflow
  **Active/Published**. `Execute workflow` roda só uma vez.

### Cloud (Oracle)
- **`Out of host capacity`** ao criar a VM Ampere → capacidade ARM grátis esgotada na hora;
  tente outra Availability Domain/região ou repita mais tarde.
- **Triagem na nuvem para de funcionar sozinha** → não é redirect/HTTPS: o token Gmail
  renova via `refresh_token` (servidor→Google). Garanta **internet de saída** na VM e que o
  `~/.n8n/config` (chave) foi migrado junto com o `database.sqlite`.
