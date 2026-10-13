// IA do mapeamento BPMN: perguntas de esclarecimento, geração, reparo
// automático, revisão e ajuste. Toda chamada devolve o grafo de bpmn-graph.js;
// o código valida o grafo e, se houver erros, a IA corrige antes de o
// navegador receber o resultado.

import { GRAPH_SCHEMA, normalizeGraph, validateGraph } from "./bpmn-graph.js";

// ─── Capacidades por modelo ───────────────────────────────────────────────────
// Saídas estruturadas (JSON garantido pelo schema) e raciocínio adaptativo.
function modelCaps(model) {
  const m = String(model || "");
  const gen5 = /^claude-(fable|mythos|opus|sonnet|haiku)-5/.test(m);
  return {
    structured: gen5 || /^claude-opus-4-8/.test(m) || /^claude-haiku-4-5/.test(m),
    adaptive: gen5 || /^claude-(opus|sonnet)-4-[6-9]/.test(m),
  };
}

// Esforço de raciocínio por faixa de complexidade (Jev).
const EFFORT = { simple: "medium", medium: "high", complex: "high" };

const REQUEST_TIMEOUT_MS = 14 * 60 * 1000;

function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

// Falhas passageiras (conexão resetada no meio do streaming, sobrecarga, 5xx):
// o SDK só repete erros anteriores ao início da resposta, então repetimos aqui.
function isTransient(err) {
  if (!err || err.code) return false; // erros nossos (truncated, refusal...) não se repetem
  if (/abort|timed out|timeout/i.test(String(err.message) + (err.constructor && err.constructor.name))) return false; // nosso próprio limite de tempo
  const status = err.status;
  if (status) return status === 429 || status >= 500;
  return true; // sem status = falha de rede/stream (ex.: "terminated", ECONNRESET)
}
async function streamWithRetry(client, params, attempts = 2) {
  for (let i = 1; ; i++) {
    try {
      return await client.messages.stream(params, { timeout: REQUEST_TIMEOUT_MS }).finalMessage();
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      console.warn(`[ARI] falha passageira na IA (${err.message}); tentando de novo…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Uma chamada que devolve JSON. Usa streaming (raciocínio + grafo grande podem
// passar de vários minutos) e o schema quando o modelo suporta.
async function callJson(client, { model, tier, effort, system, user, schema, maxTokens = 48000 }) {
  const caps = modelCaps(model);
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  const outputConfig = {};
  if (caps.adaptive) {
    params.thinking = { type: "adaptive" };
    outputConfig.effort = effort || EFFORT[tier] || "high";
  }
  if (caps.structured) outputConfig.format = { type: "json_schema", schema };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  if (!caps.structured) {
    params.messages[0].content += "\n\nResponda SOMENTE com o objeto JSON, sem markdown e sem texto antes ou depois.";
  }

  const message = await streamWithRetry(client, params);
  if (message.stop_reason === "refusal") throw fail("refusal");
  if (message.stop_reason === "max_tokens") throw fail("truncated");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const s = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1) throw fail("bad_json", "a IA não devolveu JSON");
  try { return JSON.parse(s.slice(a, b + 1)); }
  catch (_) { throw fail("bad_json", "JSON inválido da IA"); }
}

// ─── Regras de modelagem (prompt de sistema) ─────────────────────────────────
const MODELING_RULES = `Você é a ARI, analista sênior de processos e especialista em BPMN 2.0. Sua tarefa é transformar a descrição de um processo em um mapeamento AS-IS fiel: represente exatamente o que o texto descreve, com a lógica correta de cada caminho, sem inventar e sem omitir etapas, regras ou exceções.

FORMATO DE SAÍDA — um grafo:
- "processName": nome curto do processo.
- "lanes": as raias, uma por ÁREA responsável (setor, sistema ou parte externa como "Cliente" e "Fornecedor"), na ordem em que aparecem. Cargos da mesma área ficam na raia da área: gerente comercial, vendedor e diretoria comercial ficam em "Comercial"; analista e coordenador de compras em "Suprimentos". Quando o cargo importa (alçadas de aprovação), coloque-o no nome da atividade: "Aprovar desconto (gerente comercial)". Use um nome único e consistente por área — nunca duas raias para a mesma área com nomes diferentes. Crie raia própria para um cargo apenas quando o texto o trata como instância separada (ex.: "Diretoria", "Diretor de Operações"). O objetivo é um diagrama legível: em geral, de 5 a 12 raias.
- "nodes": cada nó com "id" único e curto (ex.: "t_cadastrar", "gw_desconto"), "type", "name", "lane", "taskType", "attachedTo", "interrupting" e "terminate".
- "flows": cada fluxo com "from", "to" (ids) e "label" (condição da saída de uma decisão; "" nos demais).
Campos que não se aplicam ao tipo: "taskType": "none", "attachedTo": "", "interrupting": false, "terminate": false.

TIPOS DE NÓ:
- startEvent: o gatilho do processo. endEvent: um desfecho, com nome que diz o resultado ("Pedido cancelado", "Pedido encerrado"). Use quantos fins forem necessários; "terminate": true apenas quando o desfecho precisa encerrar também caminhos paralelos ainda ativos.
- task: atividade, com nome no infinitivo + objeto ("Cadastrar pedido no ERP"). "taskType": "service" quando um sistema faz sozinho (ERP registra, cobrança automática), "user" quando uma pessoa trabalha em sistema, "manual" para trabalho físico (separar, conferir mercadoria), "send"/"receive" para enviar ou receber comunicação, "none" se não estiver claro.
- subProcess: bloco que o texto trata como subprocesso (ex.: "inicia-se um subprocesso de homologação"), representado recolhido.
- exclusiveGateway: decisão com UM caminho escolhido. Nome em forma de pergunta; cada saída com "label" de condição. Cubra TODOS os desfechos que o texto descreve — faixas de valor viram várias saídas no mesmo gateway (ex.: "até 5%", "entre 5% e 12%", "acima de 12%"), não uma cadeia de sim/não. Também use exclusiveGateway sem nome para JUNTAR caminhos alternativos antes de uma etapa comum.
- parallelGateway: atividades simultâneas ("simultaneamente", "paralelamente", "em paralelo", "ao mesmo tempo"). Um parallelGateway divide; outro parallelGateway junta (sincroniza) antes da etapa que depende de todos os ramos. Saídas sem label.
- inclusiveGateway: quando um ou mais caminhos podem acontecer juntos conforme condições.
- timerEvent: espera de tempo no caminho ("dois dias úteis após a entrega", "aguardar 3 dias"). Nome = o tempo.
- boundaryTimer: prazo de uma atividade — preso a ela ("attachedTo": id da task/subProcess). Nome = o prazo ("48 horas"). A saída do temporizador é o que acontece se o prazo estourar. "interrupting": true quando o estouro interrompe a atividade (ex.: fornecedor não respondeu, cobra); false quando a atividade continua e algo acontece em paralelo (ex.: alerta de atraso).

REGRAS DE LÓGICA (os erros mais comuns que você deve evitar):
1. Desfechos encerram: cancelamento, recusa definitiva ou abandono vão para um endEvent próprio e NÃO voltam ao fluxo normal. Nunca ligue "Cancelar pedido" a uma etapa seguinte do atendimento (a não ser que o texto diga que o processo continua).
2. Simultaneidade é paralelismo: verificações ou atividades que o texto diz ocorrerem ao mesmo tempo ficam em ramos de um parallelGateway, sincronizados por outro parallelGateway antes do ponto que depende de todas.
3. Condicional só no seu ramo: uma atividade que só acontece em certa condição (ex.: comprar só quando falta estoque) fica apenas no ramo dessa condição. Os demais ramos a contornam e se juntam depois — nunca passam por ela.
4. Retrabalho é ciclo: "refazer", "reiniciar", "volta", "revisar e submeter de novo", "nova aprovação" viram um fluxo de VOLTA para a etapa que se repete (a atividade ou a decisão de aprovação). Limites de tentativas ("após duas reprovações", "três divergências consecutivas") viram uma decisão no ciclo ("Já houve duas reprovações?") que leva ao tratamento excepcional.
5. Tempo é evento: prazos, esperas, SLAs e "se não responder em X" são timerEvent ou boundaryTimer. NUNCA transforme um prazo em pergunta de gateway ("Passaram 48h?").
6. Reinícios voltam ao ponto certo: "reinicia o fluxo de recebimento", "retorna à verificação de estoque e crédito" são fluxos de volta para exatamente essa etapa.
7. Pré-condições de liberação: quando o texto diz que algo "só ocorre após" A e B, garanta que todos os caminhos que chegam ali passaram por A e B (junção paralela ou sequência).
8. Integridade: todo nó é alcançável a partir do início; todo caminho chega a um endEvent; atividades têm uma entrada e uma saída (use gateways para dividir); um gateway divide OU junta.
9. Responsável correto: cada nó na raia da área de quem executa; decisões na raia de quem decide; eventos na raia do processo em que ocorrem.
10. Fidelidade: use os termos do texto; não crie etapas, sistemas ou regras ausentes; não omita regras de negócio (valores, percentuais, prazos) — coloque-as nos nomes e nas condições.

Antes de responder, confira mentalmente cada regra acima contra o grafo.`;

function clarificationBlock(answers) {
  const list = (Array.isArray(answers) ? answers : []).filter((a) => a && a.question);
  if (!list.length) return "";
  return "\n\nESCLARECIMENTOS DO USUÁRIO (prevalecem sobre interpretações do texto):\n" + list.map((a, i) => {
    const ans = String(a.answer || "").trim();
    return `${i + 1}. Pergunta: ${a.question}\n   Resposta: ${ans || `(sem resposta — adote a suposição: ${a.suggestion || "a interpretação mais provável do texto"})`}`;
  }).join("\n");
}

// ─── Bateria de perguntas (processos complexos) ──────────────────────────────
const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "why", "suggestion"],
        properties: { question: { type: "string" }, why: { type: "string" }, suggestion: { type: "string" } },
      },
    },
  },
};

export async function askClarifyingQuestions(client, { model, tier, text }) {
  const data = await callJson(client, {
    model, tier, effort: "medium", maxTokens: 24000, schema: QUESTIONS_SCHEMA,
    system: MODELING_RULES,
    user: "Antes de desenhar o mapeamento deste processo complexo, identifique os pontos em que a descrição é ambígua ou incompleta e que mudam a ESTRUTURA do diagrama: para onde vai um caminho depois de um cancelamento ou recusa, se um desfecho encerra o processo ou volta a uma etapa, quais atividades ocorrem em paralelo e onde se sincronizam, até onde volta um retrabalho, o que acontece quando um prazo estoura, quem é o responsável por uma decisão, desfechos de uma decisão que o texto não descreve.\n\n" +
      "Faça de 3 a 10 perguntas objetivas, em português, uma por ponto, das mais importantes para as menos. NÃO pergunte o que o texto já responde claramente. Para cada uma, diga em \"why\" o que muda no diagrama e em \"suggestion\" a interpretação mais provável (que será usada se o usuário não responder). Se não houver ambiguidade relevante, devolva uma lista vazia.\n\n" +
      `DESCRIÇÃO DO PROCESSO:\n"""\n${text}\n"""`,
  });
  return (Array.isArray(data.questions) ? data.questions : [])
    .map((q) => ({ question: String(q.question || "").trim(), why: String(q.why || "").trim(), suggestion: String(q.suggestion || "").trim() }))
    .filter((q) => q.question)
    .slice(0, 10);
}

// ─── Reparo: a IA corrige os erros que o validador encontrou ─────────────────
async function repairLoop(client, { model, tier, text, answers, graph, maxRounds = 2 }) {
  let g = normalizeGraph(graph);
  let report = validateGraph(g);
  for (let round = 0; round < maxRounds && report.errors.length; round++) {
    console.log(`[ARI] mapeamento: ${report.errors.length} erro(s) estrutural(is), pedindo correção (rodada ${round + 1})`);
    const fixed = await callJson(client, {
      model, tier, schema: GRAPH_SCHEMA, system: MODELING_RULES,
      user: "O mapeamento abaixo tem erros estruturais apontados pelo validador. Corrija TODOS, mantendo o restante igual (mesmos ids, nomes e responsáveis), e devolva o grafo completo corrigido. Consulte a descrição para decidir a correção certa.\n\n" +
        "ERROS:\n" + report.errors.map((e) => "- " + e).join("\n") +
        (report.warnings.length ? "\n\nAVISOS (corrija se forem de fato problemas):\n" + report.warnings.map((w) => "- " + w).join("\n") : "") +
        `\n\nDESCRIÇÃO DO PROCESSO:\n"""\n${text}\n"""` + clarificationBlock(answers) +
        "\n\nMAPEAMENTO ATUAL:\n" + JSON.stringify(g),
    });
    g = normalizeGraph(fixed);
    report = validateGraph(g);
  }
  return { graph: g, report };
}

// ─── Geração ─────────────────────────────────────────────────────────────────
export async function generateGraph(client, { model, tier, text, answers }) {
  const draft = await callJson(client, {
    model, tier, schema: GRAPH_SCHEMA, system: MODELING_RULES,
    user: "Mapeie o processo abaixo em BPMN 2.0 seguindo todas as regras. Leia o texto inteiro antes de começar: identifique responsáveis, gatilhos, decisões e todos os seus desfechos, atividades simultâneas, prazos, ciclos de retrabalho e pontos de encerramento." +
      `\n\nDESCRIÇÃO DO PROCESSO:\n"""\n${text}\n"""` + clarificationBlock(answers),
  });
  return repairLoop(client, { model, tier, text, answers, graph: draft });
}

// ─── Revisão (processos complexos) ───────────────────────────────────────────
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["problems", "graph"],
  properties: { problems: { type: "array", items: { type: "string" } }, graph: GRAPH_SCHEMA },
};

export async function reviewGraph(client, { model, tier, text, answers, graph }) {
  const g = normalizeGraph(graph);
  const { warnings } = validateGraph(g);
  const data = await callJson(client, {
    model, tier, schema: REVIEW_SCHEMA, system: MODELING_RULES,
    user: "Revise criticamente o mapeamento abaixo contra a descrição, trecho por trecho, como um auditor de processos. Para cada parágrafo da descrição, confira se as atividades, responsáveis, decisões (com todos os desfechos), paralelismos e sincronizações, ciclos de retrabalho, eventos de tempo e fins estão corretos e conforme as REGRAS DE LÓGICA. Procure especialmente: caminhos de cancelamento/recusa que continuam o fluxo; atividades condicionais executadas em todos os casos; retrabalho sem volta para a etapa certa; limites de tentativas não controlados; prazos modelados como perguntas; reinícios que não voltam ao ponto indicado; liberações que não exigem todas as pré-condições.\n\n" +
      "Em \"problems\" liste, em português, cada problema que você encontrou e corrigiu (lista vazia se o mapeamento já estava correto). Em \"graph\" devolva o mapeamento COMPLETO já corrigido, preservando ids e nomes do que estava certo." +
      (warnings.length ? "\n\nAVISOS DO VALIDADOR:\n" + warnings.map((w) => "- " + w).join("\n") : "") +
      `\n\nDESCRIÇÃO DO PROCESSO:\n"""\n${text}\n"""` + clarificationBlock(answers) +
      "\n\nMAPEAMENTO A REVISAR:\n" + JSON.stringify(g),
  });
  const problems = (Array.isArray(data.problems) ? data.problems : []).map((p) => String(p).trim()).filter(Boolean);
  const result = await repairLoop(client, { model, tier, text, answers, graph: data.graph });
  // Revisão que piorou a estrutura não substitui a versão revisada anterior.
  if (result.report.errors.length && !validateGraph(g).errors.length) return { graph: g, report: validateGraph(g), problems: [] };
  return { ...result, problems };
}

// ─── Ajuste pedido pelo usuário ──────────────────────────────────────────────
export async function editGraph(client, { model, tier, graph, instruction }) {
  const g = normalizeGraph(graph);
  const updated = await callJson(client, {
    model, tier, schema: GRAPH_SCHEMA, system: MODELING_RULES,
    user: "Aplique SOMENTE a alteração pedida pelo usuário ao mapeamento abaixo e mantenha todo o resto exatamente igual (mesmos ids, nomes, responsáveis e fluxos). Ao mover, remover ou inserir nós, refaça os fluxos afetados para que todos os caminhos continuem íntegros. Devolva o grafo completo.\n\n" +
      `ALTERAÇÃO PEDIDA:\n"""\n${instruction}\n"""\n\nMAPEAMENTO ATUAL:\n` + JSON.stringify(g),
  });
  return repairLoop(client, { model, tier, text: "(ajuste de um mapeamento existente; use o mapeamento atual como referência)\nAlteração pedida: " + instruction, answers: null, graph: updated });
}
