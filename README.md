# Triagem de E-mail com LLM Local (n8n + Ollama)

Classifica os e-mails do Gmail em 8 categorias semânticas com um LLM rodando localmente
(Ollama, `llama3.1`), orquestrado por **n8n** self-hosted em Docker Compose. Nenhum conteúdo
de e-mail vai para API de terceiro: o modelo roda no próprio host, sem custo por chamada.

![Arquitetura: n8n no container chama o Ollama no host; o watchdog, fora do container, lê o banco de execuções](docs/arquitetura.png)

## Como funciona

1. Um fluxo agendado do n8n (09:00 e 21:00) busca os e-mails que ainda não têm label.
2. O nó `Classificar` monta o prompt com as descrições das 8 categorias do `config.yaml` e
   chama o Ollama pedindo JSON: `label`, `needs_action`, `confidence` e `reason`.
3. Com confiança de 0,6 ou mais e label dentro da lista, o e-mail recebe o label da categoria
   (e `Ação necessária`, quando for o caso). Label fora da lista, confiança baixa ou falha de
   rede → `_Revisar`. A fila nunca trava.
4. Cada classificação vira uma linha JSON em `~/.n8n/triagem-log.jsonl`, para auditoria.
5. No host, um watchdog confere duas vezes por dia se o fluxo continua processando.

## Decisões de projeto

- **Configuração fora do fluxo.** Prompt, descrições das categorias, limiar e modelo ficam no
  `config.yaml`, montado read-only no container. Trocar categoria ou ajustar o prompt não
  exige mexer no workflow.
- **Limiar com rota de revisão.** Abaixo de 0,6 o e-mail vai para `_Revisar` em vez de receber
  um rótulo chutado. O prompt pede que o modelo use a escala de confiança inteira, para que os
  casos ambíguos caiam na revisão, e não num palpite.
- **Saída do modelo validada.** A resposta passa por `JSON.parse` com try/catch e o label tem
  de estar na lista de categorias; qualquer outra coisa vai para revisão.
- **Watchdog fora do container.** O aviso precisa sobreviver justamente ao que costuma quebrar
  (container parado, OAuth do Gmail revogado). Por isso roda no host, disparado por um timer do
  systemd, e alerta por `notify-send`, não por e-mail. Nasceu depois que uma credencial
  expirou em silêncio e a triagem ficou **38 dias parada sem ninguém notar**.

## Diagnóstico: labels inventados, sem erro nenhum

Com `ollama_num_ctx: 1024` e um prompt de ~1.410 tokens, o modelo perdia a lista de categorias
e passava a inventar labels (`marketing`, `Oportunidade`, `spam`), acertando 1 de 16 casos —
sem lançar erro nenhum. A correção foi dimensionar a janela de contexto pelo tamanho do prompt
(hoje `3072`, com folga para um prompt de ~1.760 tokens) e medir de novo sempre que as
descrições das categorias mudam. A regra de bolso está no `config.yaml`: `chars / 3.3 ≈ tokens`.

## Stack

Python · n8n · Ollama (`llama3.1`) · Docker Compose · SQLite · systemd · YAML ·
JavaScript (Code nodes do n8n)

---

## Arquivos

| Arquivo | O quê |
|---|---|
| `docker-compose.yml` | Sobe o n8n self-hosted com as envs necessárias |
| `config.yaml` | Categorias, prompt, limiar de confiança e mapa de IDs dos labels |
| `workflow.json` | Fluxo n8n importável da triagem ao vivo (4 nós) |
| `backfill.json` | Fluxo n8n importável para classificar emails **antigos** em lote (ver "Backfill") |
| `nodes/classificar.js` | Código do Code node de classificação (cópia editável) |
| `nodes/log.js` | Código do Code node de log estruturado |
| `watchdog.py` | Watchdog que alerta quando a triagem para (roda no host, fora do container) |
| `systemd/` | Units `triagem-watchdog.service` e `.timer` (checagem às 10:30 e 22:30) |
| `dns-watch.sh` | Renova o DNS do container n8n a cada troca de rede |

> O fluxo tem 4 nós. O `IF (confiança)` da especificação foi consolidado **dentro**
> do nó `Classificar` (comparar float em expressão do n8n é frágil; em código é
> determinístico). O comportamento é idêntico: `confidence < confidence_threshold`
> → `_Revisar`. Se preferir o IF visível, é trivial reintroduzir.

## Fluxo

`Gmail Trigger` → `Classificar` (Ollama + validação + resolve labelIds) → `Aplicar label` → `Log`

- **Gmail Trigger**: DESATIVADO desde 13/08/2026. O poll de 2 min nunca deixava passar
  os 5 min de `keep_alive` do Ollama, então o modelo (~5,6 GB) ficava residente na RAM
  24h por dia. O backfill diário cobre exatamente o mesmo conjunto de emails, porque
  `-has:userlabels` contém `is:unread -has:userlabels`.
- **Classificar**: lê `config.yaml`, chama o Ollama (`/api/chat` com `format: json`),
  faz `JSON.parse` com try/catch. Label fora da lista, baixa confiança ou falha de
  rede → `_Revisar`. Nunca trava a fila.
- **Aplicar label**: `messages.modify` por ID de label (retry 3x, backoff 2s).
- **Log**: anexa linha JSON em `~/.n8n/triagem-log.jsonl` (auditoria).

---

## Setup (Arch Linux)

### 1. Ollama — o modelo local que classifica

```bash
# instala e habilita
sudo pacman -S --needed ollama
sudo systemctl enable --now ollama

# baixa o modelo (≈4,7 GB) — o mesmo definido em config.yaml (model: llama3.1)
ollama pull llama3.1
```

**Faça o Ollama escutar em todas as interfaces.** Por padrão ele só aceita conexões
de `127.0.0.1`, e o container do n8n não enxerga isso. Edite o serviço:

```bash
sudo systemctl edit ollama
```

No editor que abrir, cole (entre as linhas indicadas) e salve:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

Reinicie e teste:

```bash
sudo systemctl restart ollama
curl http://localhost:11434/api/tags          # deve listar o llama3.1
# (opcional) teste a partir da ótica do container:
curl http://172.17.0.1:11434/api/tags
```

> Sem GPU funciona, só fica mais lento. A 1ª classificação carrega o modelo na RAM
> (alguns segundos) — por isso o nó tem timeout de 60s.

### 2. Subir o n8n

```bash
sudo pacman -S --needed docker docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # relogar depois

mkdir -p ~/.n8n
docker compose up -d              # rode na pasta do projeto (monta ./config.yaml)
docker compose logs -f n8n        # acompanhar a subida (Ctrl-C para sair)
```

Acesse `http://localhost:5678` e crie a conta de admin (primeiro acesso).

> **Rode o `docker compose` na pasta do projeto.** O compose monta `./config.yaml`
> por caminho relativo; rodar de outro diretório (ex.: `~`) dá
> `no configuration file provided: not found`.

> **Depois de editar o `config.yaml`, use `docker compose up -d --force-recreate`.**
> O bind mount é de um ARQUIVO, e o Docker o prende ao inode. Todo editor que salva
> escrevendo em temporário e renomeando (a maioria) cria um inode novo, e o container
> continua lendo o conteúdo ANTIGO — inclusive depois de `restart`. O sintoma é
> traiçoeiro: nenhum erro, só a triagem se comportando como antes da sua mudança.
> Confira com:
> `docker exec n8n head -20 /home/node/.n8n/config.yaml`

> **Ao mexer nas descrições das categorias ou nas regras do prompt, remeça os tokens.**
> `ollama_num_ctx` precisa ser MAIOR que o prompt inteiro. Em 13/08/2026 o prompt cresceu
> para ~1.410 tokens com `num_ctx: 1024`: o modelo perdia a lista de categorias e passava
> a inventar labels (`marketing`, `Oportunidade`, `spam`), acertando 1 de 16 casos. A
> conta é `chars / 3.3 ≈ tokens`, com folga para a resposta.

> **Se você usa `ufw` (ou outro firewall):** ele bloqueia o container de alcançar o
> Ollama no host — o nó `Classificar` cai sempre em `_Revisar` por timeout de rede.
> Libere a faixa das redes bridge do Docker na porta do Ollama:
> ```bash
> sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp comment 'n8n -> Ollama'
> ```
> Valide pela ótica do container:
> ```bash
> docker exec n8n wget -qO- http://host.docker.internal:11434/api/tags  # deve listar o llama3.1
> ```

> O `docker-compose.yml` já define `NODE_FUNCTION_ALLOW_BUILTIN=fs` +
> `NODE_FUNCTION_ALLOW_EXTERNAL=js-yaml` (Code node lê o `config.yaml`),
> `N8N_RUNNERS_ENABLED=false` (execução clássica em processo) e
> `extra_hosts: host.docker.internal:host-gateway` (o container alcança o Ollama no host).

### 3. Credencial Gmail OAuth2 no n8n

1. [Google Cloud Console](https://console.cloud.google.com) → novo projeto.
2. **APIs e Serviços → Biblioteca** → ative **Gmail API**.
3. **Tela de consentimento OAuth** → tipo *External* → adicione seu email como *test user*.
4. **Credenciais → Criar credencial → ID do cliente OAuth → Aplicativo da Web**.
   - URI de redirecionamento autorizado:
     `http://localhost:5678/rest/oauth2-credential/callback`
5. No n8n: **Credentials → New → Gmail OAuth2 API** → cole *Client ID* e *Client Secret*
   → **Connect** → autorize a conta.

### 4. Criar os labels e descobrir os IDs

A API do Gmail aplica labels **por ID**, não por nome. Crie os labels uma vez e
preencha `gmail_label_ids` no `config.yaml`.

1. No Gmail, crie os labels (nomes exatos das categorias + `Ação necessária` + `_Revisar`):
   `Trabalho/Projetos`, `Vagas/Carreira`, `Faculdade/PUC`, `Financeiro`,
   `Contas/Segurança`, `Pessoal`, `Newsletters`, `Promoções`, `Ação necessária`,
   `_Revisar`.
   Labels com barra viram sub-labels no Gmail, que cria o pai vazio junto (`Trabalho`,
   `Vagas`, `Faculdade`, `Contas`) — é esperado, não é sobra de configuração errada.
2. Descobrir os IDs (escolha um caminho):
   - **Pelo n8n**: adicione temporariamente um nó **Gmail → Label → Get Many**,
     execute e copie os `id` (formato `Label_123...`) de cada nome.
   - **Por API**: `GET https://gmail.googleapis.com/gmail/v1/users/me/labels`
     com o token OAuth da conta.
3. Cole cada ID em `gmail_label_ids` no `config.yaml`.
4. Reinicie o container para recarregar o config montado: `docker compose restart`.

### 5. Importar e ativar o fluxo

1. n8n → **Workflows → Import from File** → `workflow.json`.
2. Nos nós **Gmail Trigger** e **Aplicar label**, selecione a credencial Gmail criada
   (o import deixa um placeholder).
3. Clique em **Execute Workflow** com um email de teste não-lido para validar.
4. Ative o workflow (toggle **Active**).

### 6. Watchdog — alerta quando a triagem para

O `watchdog.py` roda no **host**, disparado por um timer do systemd de usuário. Ele copia o
banco do n8n para um arquivo temporário, abre em modo somente leitura, conta as execuções das
últimas 14 horas e dispara `notify-send -u critical` quando:

- o container `n8n` não está rodando;
- não consegue ler o banco de execuções;
- só houve execuções com erro na janela;
- não houve execução nenhuma na janela.

A janela de 14h cobre as duas rodadas diárias (09:00 e 21:00) com folga, e um container
recém-subido tem 40 minutos de carência antes de gerar alarme.

```bash
mkdir -p ~/.config/systemd/user
cp systemd/triagem-watchdog.service systemd/triagem-watchdog.timer ~/.config/systemd/user/
# ajuste o ExecStart do .service para o caminho deste repositório
systemctl --user daemon-reload
systemctl --user enable --now triagem-watchdog.timer
systemctl --user list-timers triagem-watchdog.timer

./watchdog.py   # teste manual: imprime "ok — N execuções…" ou dispara o alerta
```

---

## Deploy 24/7 grátis (Oracle Cloud Always Free)

Rodando no seu PC, a triagem só funciona com a máquina ligada. Para rodar **24/7 sem
depender do PC** e **sem custo**, hospede o mesmo stack (n8n + Ollama) numa VM **Oracle
Cloud Always Free** (ARM Ampere, até 4 vCPU / 24 GB — roda o `llama3.1` tranquilo).

> **Estratégia que simplifica tudo:** copie a pasta **`~/.n8n` inteira** para o servidor.
> Ela já contém os workflows, a **credencial Gmail autorizada (com o refresh token)** e a
> chave de criptografia. Com isso **não é preciso re-autorizar o Gmail** (o n8n renova o
> token sozinho, servidor→Google, sem navegador), **nem mexer em redirect URI/HTTPS/domínio**.
> A interface você abre por **túnel SSH** quando precisar.

### Fase 1 — Conta + VM ARM

1. Conta: <https://www.oracle.com/cloud/free/> → **Start for free** (exige cartão para
   verificação; **não cobra** no Always Free). Escolha a **home region** mais próxima
   (não muda depois).
2. Chave SSH no seu PC:
   ```bash
   ls ~/.ssh/id_ed25519.pub 2>/dev/null || ssh-keygen -t ed25519 -C "oracle-n8n" -f ~/.ssh/id_ed25519 -N ""
   cat ~/.ssh/id_ed25519.pub
   ```
3. **Compute → Instances → Create instance**:
   - Image: **Ubuntu 22.04/24.04**.
   - Shape: **Change shape → Ampere (ARM) → VM.Standard.A1.Flex**, 4 OCPU / 24 GB
     (confirme **"Always Free eligible"**).
   - Cole o conteúdo do `id_ed25519.pub` em **SSH keys**.
   - Marque **assign public IPv4**. **Create**.
   > "Out of host capacity" na Ampere é comum no tier grátis: tente outra Availability
   > Domain / região, ou repita mais tarde.

### Fase 2 — Acesso SSH

```bash
ssh ubuntu@<IP_PUBLICO>      # usuário padrão da imagem Ubuntu da Oracle é "ubuntu"
```

### Fase 3 — Docker + Ollama na VM

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"        # relogar (saia e entre de novo no SSH)

# Ollama
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl edit ollama             # cole entre as linhas indicadas:
#   [Service]
#   Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
ollama pull llama3.1                   # ~4,7 GB
```

### Fase 4 — Empacotar e transferir

O `~/.n8n` acumula o **histórico de execuções** (corpos de email etc.) e pode passar de
centenas de MB. Só precisamos migrar **workflows + credencial + chave** — então geramos um
snapshot **enxuto**, podando o histórico numa **cópia** (o banco local fica intacto). Rode no
**seu PC**:

```bash
cd ..   # a pasta que contém email_agent/

# 1) pacote do projeto (arquivos pequenos)
tar czf email_agent.tar.gz --exclude='.claude' email_agent

# 2) snapshot enxuto do ~/.n8n (sem o histórico de execuções)
docker compose -f email_agent/docker-compose.yml down        # SQLite consistente
STAGE=$(mktemp -d)/.n8n; mkdir -p "$STAGE"
cp -a ~/.n8n/config ~/.n8n/database.sqlite* "$STAGE/"
[ -d ~/.n8n/nodes ]   && cp -a ~/.n8n/nodes   "$STAGE/"
[ -d ~/.n8n/storage ] && cp -a ~/.n8n/storage "$STAGE/"
[ -f ~/.n8n/triagem-log.jsonl ] && cp -a ~/.n8n/triagem-log.jsonl "$STAGE/"
python3 - "$STAGE/database.sqlite" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1]); c = db.cursor()
c.execute("PRAGMA wal_checkpoint(TRUNCATE)")   # mescla o WAL no banco
c.execute("PRAGMA foreign_keys=OFF")
for stmt in ("DELETE FROM execution_data",     # remove só o histórico de execuções;
             "DELETE FROM execution_metadata", # workflows e credenciais ficam intactos
             "DELETE FROM execution_annotation_tags",
             "DELETE FROM execution_annotations",
             "DELETE FROM execution_entity"):
    try: c.execute(stmt)
    except sqlite3.OperationalError: pass       # tabela pode não existir nesta versão
db.commit(); c.execute("VACUUM"); db.close()
PY
rm -f "$STAGE"/database.sqlite-wal "$STAGE"/database.sqlite-shm
tar czf n8n_data.tar.gz -C "$(dirname "$STAGE")" .n8n
docker compose -f email_agent/docker-compose.yml up -d       # religa a triagem local

# 3) transferir
scp email_agent.tar.gz n8n_data.tar.gz ubuntu@<IP_PUBLICO>:~
```

Na **VM**:

```bash
tar xzf email_agent.tar.gz             # cria ~/email_agent
tar xzf n8n_data.tar.gz -C ~           # cria ~/.n8n (workflows + credencial + chave)
```

> ⚠️ **`n8n_data.tar.gz` é segredo:** contém a credencial Gmail (criptografada) **e** a chave
> que a decifra (`config`). Transfira só para a sua VM e **apague os tarballs** depois
> (`rm email_agent.tar.gz n8n_data.tar.gz`) no PC e na VM.

### Fase 5 — Firewall (mesma pegadinha do Ollama, versão Oracle)

A imagem Ubuntu da Oracle usa **iptables** restritivo. Libere a bridge do Docker para
alcançar o Ollama no host:

```bash
sudo iptables -I INPUT -s 172.16.0.0/12 -p tcp --dport 11434 -j ACCEPT
sudo apt-get install -y iptables-persistent   # salva as regras ao reiniciar
sudo netfilter-persistent save
```

> No **Security List** da VCN (painel Oracle) deixe aberto só o **22 (SSH)**. O n8n
> fica acessível só por túnel SSH — sem expor a 5678 na internet.

### Fase 6 — Subir e validar

```bash
cd ~/email_agent
docker compose up -d
docker exec n8n wget -qO- http://host.docker.internal:11434/api/tags   # deve listar llama3.1
docker compose logs -f n8n
```

Os workflows e a credencial Gmail vêm do `~/.n8n` migrado, **já ativos** — a triagem
roda 24/7. (Token Gmail renova sozinho; só precisa de internet de saída.)

### Fase 7 — Acessar a UI por túnel SSH

```bash
# no seu PC, quando quiser abrir a interface:
ssh -L 5678:localhost:5678 ubuntu@<IP_PUBLICO>
# então abra http://localhost:5678 no navegador
```

### Backfill da conta inteira (no servidor)

Já no servidor (24/7), para varrer **todo o histórico**: importe o `backfill.json`
(filtro `-has:userlabels`, agendado a cada 15 min, lote 30) num workflow **vazio**,
religue a credencial Gmail nos dois nós Gmail e **ative**. Ele mói o histórico sozinho
(~24s/email no Ollama; milhares de emails podem levar dias — é resumível e seguro:
só pega o que ainda não tem label). Desative quando o log parar de crescer.

> Detalhes e armadilhas do backfill (timeout de 300s do Code node, `simple=true` no
> Gmail "Get Many", etc.) estão na seção [Backfill](#backfill--classificar-emails-antigos).

---

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
  trigger de 2 min, trocado por economia de RAM — ver "Fluxo").
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
  Confirme também que o Ollama escuta em `0.0.0.0` (`OLLAMA_HOST=0.0.0.0:11434`).

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
