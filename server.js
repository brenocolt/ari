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

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega o arquivo .env automaticamente, se existir (Node 20.12+).
try { process.loadEnvFile(`${__dirname}/.env`); } catch (_) { /* sem .env, usa o ambiente */ }

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("\n[ARI] ERRO: defina a variável de ambiente ANTHROPIC_API_KEY antes de iniciar.\n" +
    '       Ex.: export ANTHROPIC_API_KEY="sk-ant-..."\n');
  process.exit(1);
}

const client = new Anthropic({ apiKey });
const MODEL = process.env.ARI_MODEL || "claude-opus-4-8";

const app = express();
app.use(express.json({ limit: "16mb" })); // imagem do fluxograma vem em base64

// Endpoint de geração: recebe { prompt } e devolve { text }.
app.post("/api/complete", async (req, res) => {
  const prompt = (req.body && req.body.prompt || "").toString().trim();
  if (!prompt) return res.status(400).json({ error: "prompt vazio" });

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    res.json({ text });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    console.error("[ARI] erro na chamada à Anthropic:", err && err.message ? err.message : err);
    res.status(status).json({ error: "falha ao gerar com a ARI" });
  }
});

// Gera o POP em PowerPoint (.pptx) — importável no Canva como caixas de texto
// editáveis e posicionadas (sem o embaralhamento que ocorre ao importar PDF).
app.post("/api/pop-pptx", async (req, res) => {
  const data = (req.body && req.body.data) || {};
  const imageBase64 = req.body && req.body.imageBase64;
  if (!data.processName) return res.status(400).json({ error: "dados incompletos" });

  // Data de emissão/revisão padrão = hoje (dd/mm/aaaa).
  const today = new Date().toLocaleDateString("pt-BR");
  if (!data.emission) data.emission = today;
  if (!data.lastRevision) data.lastRevision = today;
  if (!data.code) {
    const ab = (data.sector || "XX").normalize("NFD").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "XX";
    data.code = "POP-" + ab + "-001";
  }

  // Converte a imagem (dataURL ou base64 puro) em Buffer.
  if (imageBase64) {
    try {
      const b64 = String(imageBase64).replace(/^data:[^;]+;base64,/, "");
      data.flowchartImage = Buffer.from(b64, "base64");
    } catch (_) { data.flowchartImage = null; }
  }

  try {
    const pptx = await buildPopPptx(data);
    const fname = "POP-" + String(data.processName).normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) + ".pptx";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", 'attachment; filename="' + fname + '"');
    res.send(pptx);
  } catch (err) {
    console.error("[ARI] erro ao gerar POP PPTX:", err && err.message ? err.message : err);
    res.status(500).json({ error: "falha ao gerar o POP" });
  }
});

// A raiz (/) serve a versão atual do site: o ARI.dc.html (IA via /api/complete e
// pinning de scroll corrigido). Precede o static para não cair no index.html antigo.
app.get("/", (req, res) => res.sendFile(`${__dirname}/ARI.dc.html`));

// Serve os arquivos estáticos do site (support.js, bpmn-viewer.js, CSS, etc.).
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n[ARI] no ar em http://localhost:${PORT}/ARI.dc.html`);
  console.log(`[ARI] modelo: ${MODEL}\n`);
});
