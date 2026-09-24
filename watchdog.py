#!/usr/bin/env python3
# Watchdog da triagem — roda no HOST (systemd user timer), de propósito FORA do n8n:
# o aviso precisa sobreviver justamente ao que costuma quebrar (container parado, OAuth
# do Gmail revogado). Por isso alerta via notify-send, e não por email.
#
# Em 30/06/2026 o refresh token do Gmail morreu e a triagem ficou 38 dias parada sem que
# ninguém notasse — este script existe para que isso não se repita.
#
# Uso: ./watchdog.py [--quiet]   (--quiet: só alerta, sem imprimir o "ok")

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

CONTAINER = "n8n"
DB_IN_CONTAINER = "/home/node/.n8n/database.sqlite"
# Janela de tolerância: o backfill roda 2x por dia (09:00 e 21:00), então basta cobrir
# mais de 12h — senão o watchdog acusa "sem atividade" em todo horário fora da rodada.
# As 2h a mais são folga para atraso do disparo e para o próprio horário do check.
# Era 26h quando a rodada era 1x/dia; encurtar faz a falha aparecer em ~12h em vez de 24h.
WINDOW_HOURS = 14
# Container recém-subido ainda não teve tempo de acumular execuções — não alarma à toa.
GRACE_MINUTES = 40


def notify(title, body):
    print(f"[ALERTA] {title}: {body}", file=sys.stderr)
    # -u critical: fica na tela até ser dispensado; um toast que some não serve de nada
    # para uma falha que pode passar semanas despercebida.
    subprocess.run(
        ["notify-send", "-u", "critical", "-i", "mail-mark-junk", title, body],
        check=False,
    )


def container_state():
    """(rodando?, segundos desde o start). Container inexistente -> (False, 0)."""
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}} {{.State.StartedAt}}", CONTAINER],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return False, 0
    running, started = r.stdout.split()
    # Docker devolve nanossegundos; o Python só aceita microssegundos.
    started = re.sub(r"\.(\d{6})\d+", r".\1", started).replace("Z", "+00:00")
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds()
    return running == "true", age


def first_error_message(raw):
    """Extrai a mensagem legível do blob 'flatted' da execução.

    O blob é um array plano de strings (formato 'flatted'), então basta varrer os
    pedaços: a mensagem útil é a menor candidata sem stack trace — as maiores são
    a explicação longa do Google e o próprio stack.
    """
    try:
        parts = json.loads(raw)
    except ValueError:
        return "ver detalhes no n8n"
    cands = [
        s
        for s in parts
        if isinstance(s, str)
        and 20 < len(s) < 200
        and "\n    at " not in s
        and ("rror" in s or "reconnect" in s or "denied" in s)
    ]
    return min(cands, key=len) if cands else "ver detalhes no n8n"


def check_executions(dbpath):
    """(n_erros, n_sucessos, n_total, msg_do_ultimo_erro) na janela recente."""
    since = (datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    con = sqlite3.connect(f"file:{dbpath}?mode=ro", uri=True)
    rows = con.execute(
        "select id, status from execution_entity where startedAt > ? order by id desc",
        (since,),
    ).fetchall()
    errors = [r for r in rows if r[1] == "error"]
    successes = [r for r in rows if r[1] == "success"]
    msg = ""
    if errors:
        data = con.execute(
            "select data from execution_data where executionId = ?", (errors[0][0],)
        ).fetchone()
        msg = first_error_message(data[0]) if data else ""
    con.close()
    return len(errors), len(successes), len(rows), msg


def main():
    quiet = "--quiet" in sys.argv

    running, age = container_state()
    if not running:
        notify("Triagem parada", f"O container '{CONTAINER}' não está rodando. Suba com docker compose up -d.")
        return 1

    tmp = tempfile.mkdtemp(prefix="triagem-watchdog-")
    try:
        # Copia com o WAL junto: sem ele o snapshot perde as execuções mais recentes,
        # que são exatamente as que interessam aqui.
        for suffix in ("", "-wal", "-shm"):
            subprocess.run(
                ["docker", "cp", f"{CONTAINER}:{DB_IN_CONTAINER}{suffix}", tmp],
                capture_output=True,
                check=False,
            )
        dbpath = os.path.join(tmp, "database.sqlite")
        if not os.path.exists(dbpath):
            notify("Triagem sem diagnóstico", "Não consegui ler o banco do n8n para verificar as execuções.")
            return 1
        n_err, n_ok, n_total, msg = check_executions(dbpath)
    finally:
        # O banco carrega a credencial do Gmail (cifrada) — não deixa cópia para trás.
        shutil.rmtree(tmp, ignore_errors=True)

    # Só alarma se NENHUMA execução deu certo na janela: um erro isolado com sucessos
    # em volta é ruído, e alarmar por erro passado dispara alerta de coisa já resolvida.
    if n_err and not n_ok:
        notify(
            "Triagem falhando",
            f"{n_err} de {n_total} execuções com erro nas últimas {WINDOW_HOURS}h, nenhuma bem-sucedida.\n{msg}",
        )
        return 1

    if n_total == 0 and age > GRACE_MINUTES * 60:
        notify(
            "Triagem sem atividade",
            f"Nenhuma execução nas últimas {WINDOW_HOURS}h. Verifique se os workflows continuam ativos.",
        )
        return 1

    if not quiet:
        print(f"ok — {n_total} execuções nas últimas {WINDOW_HOURS}h ({n_ok} ok, {n_err} com erro)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
