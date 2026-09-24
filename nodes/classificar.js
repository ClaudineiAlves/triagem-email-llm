// Code node "Classificar" — modo: Run Once for All Items, linguagem: JavaScript.
// Lê config.yaml, classifica via Ollama (modelo LOCAL), valida o JSON e resolve labelIds.
// Falha de rede/parse -> _Revisar (nunca trava a fila, nunca reprocessa em loop).

const fs = require('fs');
const yaml = require('js-yaml');
// js-yaml v4: load() já usa o schema seguro (não executa código). Alias só para legibilidade.
const parseYaml = yaml.load.bind(yaml);

const cfg = parseYaml(fs.readFileSync('/home/node/.n8n/config.yaml', 'utf8'));

const model = cfg.model || 'llama3.1';
// URL do Ollama vista de DENTRO do container (ver docker-compose.yml / README).
const ollamaUrl = (cfg.ollama_url || 'http://host.docker.internal:11434').replace(/\/+$/, '');
const threshold = typeof cfg.confidence_threshold === 'number' ? cfg.confidence_threshold : 0.6;
const keepAlive = cfg.ollama_keep_alive || '2m';
const numCtx = typeof cfg.ollama_num_ctx === 'number' ? cfg.ollama_num_ctx : 1024;
const fallbackLabel = cfg.fallback_label || '_Revisar';
const actionLabel = cfg.action_label || 'Ação necessária';
const multiLabel = cfg.multi_label === true;
const allowed = cfg.categories.map((c) => c.name);
const labelIds = cfg.gmail_label_ids || {};
const catLines = cfg.categories.map((c) => `- ${c.name}: ${c.description}`).join('\n');
// Remetentes que nunca geram "Ação necessária" — ver never_action_senders no config.yaml.
const neverAction = (cfg.never_action_senders || []).map((s) => String(s).toLowerCase());

function idFor(name) {
  const id = labelIds[name];
  if (!id) {
    throw new Error(`Sem ID de label para "${name}" em gmail_label_ids (config.yaml). Veja o README.`);
  }
  return id;
}

// O Gmail Trigger (Simplify off) devolve from/subject como objeto
// ({value:[{address,name}], text, html}); o modelo precisa de string limpa.
function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    const a = Array.isArray(v.value) && v.value[0];
    if (a) return a.name ? `${a.name} <${a.address}>` : (a.address || '');
  }
  return String(v);
}

const out = [];

for (const item of $input.all()) {
  const j = item.json;

  // Extração defensiva (campos variam conforme a versão/Simplify do Gmail Trigger).
  const headers = (j.payload && j.payload.headers) || j.headers || [];
  const getHeader = (n) =>
    Array.isArray(headers)
      ? ((headers.find((h) => (h.name || '').toLowerCase() === n) || {}).value || '')
      : (headers[n] || '');
  const subject = asText(j.Subject || j.subject || getHeader('subject'));
  const from = asText(j.From || j.from || getHeader('from'));
  const snippet = j.snippet || j.Snippet || '';
  const messageId = j.id || j.messageId || '';

  let label = fallbackLabel;
  let needs_action = false;
  let confidence = 0;
  let reason = '';
  let errored = false;

  try {
    const userPrompt = cfg.prompt_template
      .replaceAll('{{categories}}', catLines)
      .replaceAll('{{from}}', from)
      .replaceAll('{{subject}}', subject)
      .replaceAll('{{snippet}}', snippet);

    const resp = await this.helpers.httpRequest({
      method: 'POST',
      url: `${ollamaUrl}/api/chat`,
      headers: { 'content-type': 'application/json' },
      body: {
        model,
        stream: false,
        format: 'json', // Ollama garante JSON sintaticamente válido
        keep_alive: keepAlive,
        options: { temperature: 0, num_ctx: numCtx },
        messages: [
          { role: 'system', content: cfg.system_prompt },
          { role: 'user', content: userPrompt },
        ],
      },
      json: true,
      timeout: 60000, // modelo local pode ter "cold start" na 1ª chamada
    });

    const text = String((resp.message && resp.message.content) || '').trim();

    // Parsing robusto: pega o primeiro objeto JSON mesmo com texto em volta.
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);

    confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    needs_action = parsed.needs_action === true;
    reason = String(parsed.reason || '').slice(0, 120);
    // Label fora da lista permitida -> fallback.
    label = allowed.includes(parsed.label) ? parsed.label : fallbackLabel;
  } catch (e) {
    errored = true;
    reason = 'erro: ' + (e.message || String(e)).slice(0, 120);
    label = fallbackLabel;
    confidence = 0;
  }

  // Corte determinístico: o modelo insiste em marcar alerta automático de vaga como
  // ação, mesmo com esses casos listados no prompt como exemplos de false.
  const fromLower = from.toLowerCase();
  if (needs_action && neverAction.some((s) => fromLower.includes(s))) {
    needs_action = false;
    reason = (reason ? reason + ' | ' : '') + 'ação suprimida: remetente automático';
  }

  // Baixa confiança -> revisão (não chuta com confiança baixa).
  const finalLabel = (!errored && confidence >= threshold) ? label : fallbackLabel;

  const names = [finalLabel];
  if (multiLabel && needs_action && finalLabel !== fallbackLabel) {
    names.push(actionLabel);
  }

  const finalLabelIds = names.map(idFor);

  out.push({
    json: { messageId, from, subject, snippet, finalLabel, finalLabelIds, confidence, needs_action, reason, error: errored },
  });
}

// Lote terminado: devolve os ~5,6 GB do modelo em vez de esperar o keep_alive expirar.
// keep_alive: 0 com messages vazio é a forma que o Ollama expõe para descarregar.
// Best-effort — falhar aqui não pode invalidar a classificação que já foi feita.
try {
  await this.helpers.httpRequest({
    method: 'POST',
    url: `${ollamaUrl}/api/chat`,
    headers: { 'content-type': 'application/json' },
    body: { model, keep_alive: 0, messages: [] },
    json: true,
    timeout: 15000,
  });
} catch (e) {
  // sem unload o modelo sai sozinho quando o keep_alive vence; não é motivo de falha.
}

return out;
