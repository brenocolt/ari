// Servidor proxy da ARI.
// Guarda a chave da Anthropic no servidor (NUNCA no navegador) e repassa as
// chamadas de IA. O navegador chama POST /api/complete; este servidor é quem
// fala com a API da Anthropic usando a ANTHROPIC_API_KEY do ambiente.
//
// Como rodar:
//   1. npm install
//   2. export ANTHROPIC_API_KEY="sua-chave-aqui"   (ou use um arquivo .env)
//   3. npm start
//   4. abra http://localhost:3000/ARI.dc.html

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { buildPopPptx } from "./pop-pptx.js";
import { routeBpmnModel, tiers } from "./model-router.js";
import { askClarifyingQuestions, generateGraph, reviewGraph, editGraph } from "./bpmn-ai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega o arquivo .env automaticamente, se existir (Node 20.12+).
try { process.loadEnvFile(`${__dirname}/.env`); } catch (_) { /* sem .env, usa o ambiente */ }

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("\n[ARI] ERRO: defina a variável de ambiente ANTHROPIC_API_KEY antes de iniciar.\n" +
    '       Ex.: export ANTHROPIC_API_KEY="sk-ant-..."\n');
  process.exit(1);
}

// Timeout explícito (ms) e 1 nova tentativa: sem isso o SDK espera até 10 min
// e tenta 3 vezes, prendendo o navegador por muito tempo.
const client = new Anthropic({ apiKey, timeout: 170_000, maxRetries: 1 });
const MODEL = process.env.ARI_MODEL || "claude-opus-5-5";

// Traduz falhas da Anthropic para respostas úteis ao navegador. Erros de
// configuração (chave/modelo) viram 502 — não são culpa de quem usa o site.
function apiErrorResponse(err) {
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return [504, "timeout", "a IA demorou demais para responder"];
  if (err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && err.status === 529))
    return [503, "busy", "a IA está sobrecarregada no momento"];
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
    console.error("[ARI] verifique ANTHROPIC_API_KEY e ARI_MODEL no .env");
    return [502, "config", "o servidor da ARI está mal configurado"];
  }
  if (err instanceof Anthropic.APIConnectionError)
    return [502, "network", "sem conexão com a IA"];
  return [502, "upstream", "falha ao gerar com a ARI"];
}

const app = express();
app.use(express.json({ limit: "16mb" })); // imagem do fluxograma vem em base64

// Endpoint de geração (POP e manual): recebe { prompt } e devolve { text, model }.
app.post("/api/complete", async (req, res) => {
  const prompt = (req.body && req.body.prompt || "").toString().trim();
  if (!prompt) return res.status(400).json({ error: "prompt vazio" });
  const model = MODEL;

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
      // POP e manual são tarefas de redação/estruturação: sem raciocínio estendido,
      // que é cobrado como saída. No Sonnet 5.5 "disabled" dá erro 400; o jeito de
      // desligar é "between_tools" (só esse modelo aceita).
      ...(/sonnet-5-5/.test(model) ? { thinking: { type: "between_tools" } } : {}),
    });
    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "a IA recusou este pedido", code: "refusal" });
    }
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // truncated=true avisa o navegador que a resposta foi cortada no limite de tokens.
    res.json({ text, truncated: message.stop_reason === "max_tokens", model });
  } catch (err) {
    console.error("[ARI] erro na chamada à Anthropic:", err && err.message ? err.message : err);
    const [status, code, error] = apiErrorResponse(err);
    res.status(status).json({ error, code });
  }
});

// Autoria exibida no POP (prévia e .pptx). Configurável sem mexer no código.
app.get("/api/config", (req, res) => {
  res.json({
    author: process.env.ARI_EMPRESA || "Produtiva Junior",
    reviewCycle: process.env.ARI_REVISAO || "Trimestral",
  });
});

// ─── Mapeamento BPMN ─────────────────────────────────────────────────────────
// Fluxo: analyze (Jev escolhe o modelo; no complexo, a IA faz perguntas) ->
// generate (grafo + reparo automático) -> review (só no complexo) -> edit.
// O navegador devolve a faixa ("tier") recebida no analyze; o modelo sai
// sempre da tabela do servidor.
const MAX_TEXT = 40000;
const modelForTier = (tier) => (tiers()[tier] ? tiers()[tier].model : MODEL);

function bpmnError(res, err, what) {
  console.error(`[ARI] erro ao ${what}:`, err && err.message ? err.message : err);
  if (err && err.code === "truncated") return res.status(502).json({ error: "o mapeamento ficou grande demais", code: "truncated" });
  if (err && err.code === "refusal") return res.status(422).json({ error: "a IA recusou este pedido", code: "refusal" });
  if (err && err.code === "bad_json") return res.status(502).json({ error: "resposta inválida da IA", code: "upstream" });
  const [status, code, error] = apiErrorResponse(err);
  res.status(status).json({ error, code });
}
const textOf = (v) => (typeof v === "string" ? v.trim() : "");

app.post("/api/bpmn/analyze", async (req, res) => {
  const text = textOf(req.body && req.body.text);
  if (!text) return res.status(400).json({ error: "descrição vazia" });
  if (text.length > MAX_TEXT) return res.status(413).json({ error: "descrição longa demais", code: "too_large" });
  const r = await routeBpmnModel(text);
  const tier = r ? r.tier : null;
  const model = r ? r.model : MODEL;
  if (r) console.log(`[ARI] Jev: complexidade ${r.complexity.toFixed(2)} (${r.label}) -> ${r.model}`,
    Object.fromEntries(Object.entries(r.dims).map(([k, v]) => [k, +v.toFixed(2)])));
  let questions = [];
  // Modelo complexo (Opus): bateria de perguntas antes de mapear.
  if (tier === "complex") {
    try { questions = await askClarifyingQuestions(client, { model, tier, text }); }
    catch (err) { return bpmnError(res, err, "preparar as perguntas"); }
  }
  res.json({ tier, model, label: r ? r.label : null, complexity: r ? +r.complexity.toFixed(2) : null, questions });
});

app.post("/api/bpmn/generate", async (req, res) => {
  const text = textOf(req.body && req.body.text);
  if (!text) return res.status(400).json({ error: "descrição vazia" });
  const tier = req.body.tier, model = modelForTier(tier);
  try {
    const t0 = Date.now();
    const { graph, report } = await generateGraph(client, { model, tier, text, answers: req.body.answers, prefs: req.body.prefs });
    console.log(`[ARI] mapeamento gerado com ${model} em ${((Date.now() - t0) / 1000).toFixed(0)}s: ${graph.nodes.length} nós, ${report.errors.length} erro(s)`);
    res.json({ graph, model, errors: report.errors, warnings: report.warnings });
  } catch (err) { bpmnError(res, err, "gerar o mapeamento"); }
});

app.post("/api/bpmn/review", async (req, res) => {
  const text = textOf(req.body && req.body.text);
  const graph = req.body && req.body.graph;
  if (!text || !graph) return res.status(400).json({ error: "dados incompletos" });
  const tier = req.body.tier, model = modelForTier(tier);
  try {
    const t0 = Date.now();
    const out = await reviewGraph(client, { model, tier, text, answers: req.body.answers, prefs: req.body.prefs, graph });
    console.log(`[ARI] revisão com ${model} em ${((Date.now() - t0) / 1000).toFixed(0)}s: ${out.problems.length} correção(ões)`);
    out.problems.forEach((p) => console.log("      - " + p));
    res.json({ graph: out.graph, model, problems: out.problems, errors: out.report.errors, warnings: out.report.warnings });
  } catch (err) { bpmnError(res, err, "revisar o mapeamento"); }
});

app.post("/api/bpmn/edit", async (req, res) => {
  const instruction = textOf(req.body && req.body.instruction);
  const graph = req.body && req.body.graph;
  if (!instruction || !graph) return res.status(400).json({ error: "dados incompletos" });
  const tier = req.body.tier, model = modelForTier(tier);
  try {
    const { graph: g, report } = await editGraph(client, { model, tier, graph, instruction });
    res.json({ graph: g, model, errors: report.errors, warnings: report.warnings });
  } catch (err) { bpmnError(res, err, "ajustar o mapeamento"); }
});

// Gera o POP em PowerPoint (.pptx) — importável no Canva como caixas de texto
// editáveis e posicionadas (sem o embaralhamento que ocorre ao importar PDF).
// style = { model: 1|2|3, palette: { primary, accent } }; clientLogo e
// imageBase64 (fluxograma) chegam como dataURL ou base64 puro.
const toImageBuffer = (v) => {
  if (!v) return null;
  try { return Buffer.from(String(v).replace(/^data:[^;]+;base64,/, ""), "base64"); } catch (_) { return null; }
};
app.post("/api/pop-pptx", async (req, res) => {
  const body = req.body || {};
  const data = body.data || {};
  if (!data.processName) return res.status(400).json({ error: "dados incompletos" });
  const style = body.style || {};

  try {
    const pptx = await buildPopPptx(data, {
      model: style.model,
      palette: style.palette,
      flowchart: toImageBuffer(body.imageBase64),
      clientLogo: toImageBuffer(body.clientLogo),
    });
    const fname = "POP-" + String(data.processName).normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) + ".pptx";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", 'attachment; filename="' + fname + '"');
    res.send(pptx);
  } catch (err) {
    console.error("[ARI] erro ao gerar POP PPTX:", err && err.message ? err.message : err);
    res.status(500).json({ error: "falha ao gerar o POP" });
  }
});

// A raiz (/) serve o site: o ARI.dc.html.
app.get("/", (req, res) => res.sendFile(`${__dirname}/ARI.dc.html`));

// Serve os arquivos estáticos do site (support.js, bpmn-viewer.js, CSS, etc.).
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n[ARI] no ar em http://localhost:${PORT}/ARI.dc.html`);
  console.log(`[ARI] modelo padrão: ${MODEL}`);
  console.log(process.env.TYPESAFE_API_KEY
    ? "[ARI] mapeamentos: modelo escolhido pelo Jev conforme a complexidade\n"
    : "[ARI] mapeamentos: sem TYPESAFE_API_KEY, usando o modelo padrão\n");
});
