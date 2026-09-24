// Code node "Log" — modo: Run Once for All Items, linguagem: JavaScript.
// Anexa uma linha JSON estruturada por email em /home/node/.n8n/triagem-log.jsonl
// (persistido no host via volume ~/.n8n). Serve para auditar acertos e refinar o prompt.

const fs = require('fs');
const LOG_PATH = '/home/node/.n8n/triagem-log.jsonl';

// Recebe a saída do "Classificar" diretamente (ramo paralelo ao "Aplicar label"),
// então $input já traz finalLabel/from/subject/confidence/etc. — sem depender do
// nome do nó anterior (robusto a renomeações na importação).
for (const item of $input.all()) {
  const j = item.json;
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      messageId: j.messageId,
      from: j.from,
      subject: j.subject,
      label: j.finalLabel,
      confidence: j.confidence,
      needs_action: j.needs_action,
      error: j.error,
      // Sem isto a causa da falha se perde: o Classificar monta 'erro: <mensagem>' em
      // reason, e sem ela não dá para saber se foi timeout, parse ou rede. Em 18/08
      // dois emails caíram em _Revisar e o motivo era inauditável.
      reason: j.reason,
    }) + '\n';
  fs.appendFileSync(LOG_PATH, line);
}

return $input.all();
