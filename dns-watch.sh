#!/usr/bin/env bash
# Renova o DNS do container n8n a CADA troca de rede, em vez de num horário fixo.
#
# O Docker congela os servidores de DNS do host no momento em que o container sobe
# (ExtServers em /etc/resolv.conf). Este notebook troca de rede o tempo todo, e o n8n
# segue consultando o DNS da rede anterior — sintoma: getaddrinfo EAI_AGAIN em
# www.googleapis.com, dias inteiros sem uma execução bem-sucedida.
#
# O antecessor (triagem-dns-refresh.timer, horário fixo pela manhã) não cobria troca de
# rede DEPOIS do horário: mudar de rede no meio da manhã fazia o dia inteiro falhar.
#
# NÃO troque isso por um `dns:` fixo no compose: na rede da PUC, 1.1.1.1 e 8.8.8.8 dão
# ETIMEDOUT (DNS externo bloqueado) — só o 172.16.0.3/.4 local responde.
#
# ── Por que o script é mais chato do que parece necessário ──────────────────────────
# A 1ª versão (18/08) usava só o exit code do `docker exec` para decidir. Mas ele dá 1
# tanto para "o DNS não resolve" quanto para "o container ainda está subindo" — então
# um restart derrubava o probe seguinte, que pedia outro restart, e assim por diante:
# 39 restarts em dois dias, e a rodada das 09:00 de 20/08 morreu numa dessas cascatas
# (o n8n levou SIGTERM 250ms depois de "Initializing n8n process"). Daí as três
# proteções: probe que distingue os casos, cooldown, e não reiniciar durante uma rodada.

set -uo pipefail

CONTAINER=n8n
PROBE_HOST=www.googleapis.com
DB="$HOME/.n8n/database.sqlite"
# nmcli emite uma rajada de linhas por troca de rede (link, IP, DNS, connectivity).
DEBOUNCE_SECS=8
# Piso entre dois restarts. Só a troca de rede justifica reiniciar, e ela não acontece
# de minuto em minuto — se o pedido vier antes disso, é sintoma de cascata.
COOLDOWN_SECS=300
# Quanto esperar o container ficar sondável depois de subir, antes de desistir da volta.
READY_TIMEOUT_SECS=90
# Confirmações seguidas de falha antes de reiniciar: uma falha isolada costuma ser
# a rede ainda assentando depois do evento, não o resolv.conf congelado.
FAIL_CONFIRMATIONS=3
FAIL_INTERVAL_SECS=5

LAST_RESTART=0

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

# 0 = DNS ok | 1 = DNS quebrado | 2 = indeterminado (não deu para sondar)
probe() {
    local out
    out=$(docker exec "$CONTAINER" node \
        -e "require('dns').lookup('$PROBE_HOST',e=>console.log(e?'FAIL:'+e.code:'OK'))" 2>/dev/null)
    case "$out" in
        OK)     return 0 ;;
        FAIL:*) return 1 ;;
        *)      return 2 ;;   # container parado, subindo, ou exec recusado
    esac
}

container_running() {
    [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]]
}

# Espera o container responder ao probe (qualquer veredito que não seja "indeterminado").
wait_probeable() {
    local deadline=$((SECONDS + READY_TIMEOUT_SECS))
    while (( SECONDS < deadline )); do
        probe; [[ $? -ne 2 ]] && return 0
        sleep 3
    done
    return 1
}

# Uma rodada de triagem leva ~30 min. Reiniciar no meio joga o lote fora e ainda deixa a
# execução marcada como "crashed" com uma mensagem enganosa de falta de memória.
execution_running() {
    [[ -f "$DB" ]] || return 1
    local n
    n=$(python3 -c "
import sqlite3,sys
try:
    con=sqlite3.connect('file:$DB?mode=ro',uri=True)
    print(con.execute(\"select count(*) from execution_entity where status in ('running','new')\").fetchone()[0])
    con.close()
except Exception:
    print(0)" 2>/dev/null)
    [[ "${n:-0}" -gt 0 ]]
}

refresh_if_broken() {
    if ! container_running; then
        log "container '$CONTAINER' não está rodando — nada a fazer"
        return 0
    fi

    probe; local st=$?
    if [[ $st -eq 2 ]]; then
        log "probe indeterminado (container subindo?) — aguardando, sem restart"
        wait_probeable || { log "container não ficou sondável em ${READY_TIMEOUT_SECS}s — desisto desta rodada"; return 0; }
        probe; st=$?
    fi
    [[ $st -eq 0 ]] && { log "DNS ok — sem restart"; return 0; }

    # Confirma antes de agir: só falha persistente é resolv.conf congelado.
    local i
    for ((i = 2; i <= FAIL_CONFIRMATIONS; i++)); do
        sleep "$FAIL_INTERVAL_SECS"
        probe; st=$?
        [[ $st -eq 0 ]] && { log "DNS voltou sozinho na tentativa $i — sem restart"; return 0; }
        [[ $st -eq 2 ]] && { log "probe ficou indeterminado — sem restart"; return 0; }
    done

    local since=$(( $(date +%s) - LAST_RESTART ))
    if (( since < COOLDOWN_SECS )); then
        log "DNS quebrado, mas último restart foi há ${since}s (cooldown ${COOLDOWN_SECS}s) — adiando"
        return 0
    fi

    if execution_running; then
        log "DNS quebrado, mas há execução em andamento — adiando para não matar o lote"
        return 0
    fi

    log "DNS quebrado ($PROBE_HOST não resolve, ${FAIL_CONFIRMATIONS}x) -> docker restart $CONTAINER"
    if docker restart "$CONTAINER" >/dev/null; then
        LAST_RESTART=$(date +%s)
        wait_probeable && log "restart concluído, container sondável" || log "restart feito, mas container não respondeu ao probe"
    else
        log "docker restart falhou"
    fi
}

# Confere no start também: cobre o container ter subido no boot com o DNS de outra rede.
refresh_if_broken

nmcli monitor | while IFS= read -r _; do
    while read -r -t "$DEBOUNCE_SECS" _; do :; done   # drena a rajada
    refresh_if_broken
done
