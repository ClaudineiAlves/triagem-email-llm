[← README](../README.md)

# Deploy 24/7 grátis (Oracle Cloud Always Free)

Rodando no seu PC, a triagem só funciona com a máquina ligada. Para rodar **24/7 sem
depender do PC** e **sem custo**, hospede o mesmo stack (n8n + Ollama) numa VM **Oracle
Cloud Always Free** (ARM Ampere, até 4 vCPU / 24 GB — roda o `llama3.1` tranquilo).

> **Estratégia que simplifica tudo:** copie a pasta **`~/.n8n` inteira** para o servidor.
> Ela já contém os workflows, a **credencial Gmail autorizada (com o refresh token)** e a
> chave de criptografia. Com isso **não é preciso re-autorizar o Gmail** (o n8n renova o
> token sozinho, servidor→Google, sem navegador), **nem mexer em redirect URI/HTTPS/domínio**.
> A interface você abre por **túnel SSH** quando precisar.

## Fase 1 — Conta + VM ARM

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

## Fase 2 — Acesso SSH

```bash
ssh ubuntu@<IP_PUBLICO>      # usuário padrão da imagem Ubuntu da Oracle é "ubuntu"
```

## Fase 3 — Docker + Ollama na VM

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

> Aqui o `0.0.0.0` é aceitável porque a Security List da VCN só abre a porta 22 (Fase 5).
> Se preferir o mesmo isolamento do setup local, use `172.17.0.1` e as linhas `After=` e
> `Requires=` do [passo 2 do setup](setup.md#2-docker-ollama-na-bridge-e-n8n).

## Fase 4 — Empacotar e transferir

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

## Fase 5 — Firewall (mesma pegadinha do Ollama, versão Oracle)

A imagem Ubuntu da Oracle usa **iptables** restritivo. Libere a bridge do Docker para
alcançar o Ollama no host:

```bash
sudo iptables -I INPUT -s 172.16.0.0/12 -p tcp --dport 11434 -j ACCEPT
sudo apt-get install -y iptables-persistent   # salva as regras ao reiniciar
sudo netfilter-persistent save
```

> No **Security List** da VCN (painel Oracle) deixe aberto só o **22 (SSH)**. O n8n
> fica acessível só por túnel SSH — sem expor a 5678 na internet.

## Fase 6 — Subir e validar

```bash
cd ~/email_agent
docker compose up -d
docker exec n8n wget -qO- http://host.docker.internal:11434/api/tags   # deve listar llama3.1
docker compose logs -f n8n
```

Os workflows e a credencial Gmail vêm do `~/.n8n` migrado, **já ativos** — a triagem
roda 24/7. (Token Gmail renova sozinho; só precisa de internet de saída.)

## Fase 7 — Acessar a UI por túnel SSH

```bash
# no seu PC, quando quiser abrir a interface:
ssh -L 5678:localhost:5678 ubuntu@<IP_PUBLICO>
# então abra http://localhost:5678 no navegador
```

## Backfill da conta inteira (no servidor)

Já no servidor (24/7), para varrer **todo o histórico**: importe o `backfill.json`
(filtro `-has:userlabels`, agendado a cada 15 min, lote 30) num workflow **vazio**,
religue a credencial Gmail nos dois nós Gmail e **ative**. Ele mói o histórico sozinho
(~24s/email no Ollama; milhares de emails podem levar dias — é resumível e seguro:
só pega o que ainda não tem label). Desative quando o log parar de crescer.

> Detalhes e armadilhas do backfill (timeout de 300s do Code node, `simple=true` no
> Gmail "Get Many", etc.) estão em [Operação → Backfill](operacao.md#backfill--classificar-emails-antigos).
