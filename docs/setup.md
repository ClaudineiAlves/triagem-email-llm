[← README](../README.md)

# Setup local (Arch Linux)

## 1. Ollama — o modelo local que classifica

```bash
# instala e habilita
sudo pacman -S --needed ollama
sudo systemctl enable --now ollama

# baixa o modelo (≈4,7 GB) — o mesmo definido em config.yaml (model: llama3.1)
ollama pull llama3.1
```

> Por padrão o Ollama só aceita conexões de `127.0.0.1`, que o container do n8n não
> alcança. O passo 2 resolve isso, depois de instalar o Docker.

> Sem GPU funciona, só fica mais lento. A 1ª classificação carrega o modelo na RAM
> (alguns segundos) — por isso o nó tem timeout de 60s.

## 2. Docker, Ollama na bridge e n8n

```bash
sudo pacman -S --needed docker docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # relogar depois
```

**Faça o Ollama escutar só na bridge do Docker.** Não use `OLLAMA_HOST=0.0.0.0`: o Ollama
não tem autenticação, e sem firewall qualquer máquina da mesma rede (o Wi-Fi da faculdade,
por exemplo) usaria o seu modelo. O container alcança o host pelo IP da bridge,
`172.17.0.1`, que é para onde aponta o `host.docker.internal` do compose.

```bash
sudo systemctl edit ollama
```

No editor que abrir, cole (entre as linhas indicadas) e salve:

```ini
[Unit]
# 172.17.0.1 só existe depois que o Docker cria a interface docker0;
# sem essa ordem, o Ollama sobe antes e falha ao abrir a porta
After=docker.service
Requires=docker.service

[Service]
Environment="OLLAMA_HOST=172.17.0.1:11434"
```

Reinicie e teste:

```bash
sudo systemctl restart ollama
ss -ltn | grep 11434                    # deve mostrar só 172.17.0.1:11434
curl http://172.17.0.1:11434/api/tags   # deve listar o llama3.1
```

> O CLI `ollama` procura o servidor em `127.0.0.1`. Para continuar usando `ollama pull`,
> `ollama list` etc. no host, aponte para o novo endereço:
> `echo 'export OLLAMA_HOST=172.17.0.1:11434' >> ~/.bashrc`

Suba o n8n:

```bash
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

## 3. Credencial Gmail OAuth2 no n8n

1. [Google Cloud Console](https://console.cloud.google.com) → novo projeto.
2. **APIs e Serviços → Biblioteca** → ative **Gmail API**.
3. **Tela de consentimento OAuth** → tipo *External* → adicione seu email como *test user*.
4. **Credenciais → Criar credencial → ID do cliente OAuth → Aplicativo da Web**.
   - URI de redirecionamento autorizado:
     `http://localhost:5678/rest/oauth2-credential/callback`
5. No n8n: **Credentials → New → Gmail OAuth2 API** → cole *Client ID* e *Client Secret*
   → **Connect** → autorize a conta.

## 4. Criar os labels e descobrir os IDs

A API do Gmail aplica labels **por ID**, não por nome. Crie os labels uma vez e
preencha `gmail_label_ids` no `config.yaml` (se ainda não existe, crie a partir do modelo:
`cp config.example.yaml config.yaml`).

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

## 5. Importar e ativar o fluxo

1. n8n → **Workflows → Import from File** → `workflow.json`.
2. Nos nós **Gmail Trigger** e **Aplicar label**, selecione a credencial Gmail criada
   (o import deixa um placeholder).
3. Clique em **Execute Workflow** com um email de teste não-lido para validar.
4. Ative o workflow (toggle **Active**).

## 6. Watchdog — alerta quando a triagem para

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
