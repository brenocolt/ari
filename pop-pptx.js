import pptxgen from 'pptxgenjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Logo da empresa (usada na página final). Carregada uma vez do disco.
const __dir = dirname(fileURLToPath(import.meta.url));
let LOGO_B64 = null;
try { LOGO_B64 = readFileSync(join(__dir, 'logo empresa.png')).toString('base64'); } catch { /* sem logo */ }

// ---------------------------------------------------------------------------
// Paleta (hex SEM '#', como o pptxgenjs espera)
// ---------------------------------------------------------------------------
const C = {
  navy: '0A1F2E',
  body: '2A3540',
  labelGray: '8A98A5',
  teal: '2BA8BC',
  boxBg: 'F4F6F8',
  boxBorder: 'E4E9ED',
  tableLine: '3A4550',
  white: 'FFFFFF',
  chipBg: 'DCF1F4',
  chipText: '0A1F2E',
};

// Fontes seguras do Canva
const F = {
  sans: 'Arial',
  serif: 'Georgia',
};

// ---------------------------------------------------------------------------
// Geometria — pontos (pdfkit) → polegadas (pptxgenjs). 1in = 72pt.
// Página A4 retrato.
// ---------------------------------------------------------------------------
const PAGE_PT = { w: 595.28, h: 841.89, margin: 56 };
const PT = (v) => v / 72; // helper pt → in

const PAGE = {
  w: PT(PAGE_PT.w), // ~8.27
  h: PT(PAGE_PT.h), // ~11.69
  margin: PT(PAGE_PT.margin), // ~0.778
};
const CONTENT_W = PAGE.w - PAGE.margin * 2;
const BOTTOM = PAGE.h - PAGE.margin; // limite inferior de conteúdo

// ---------------------------------------------------------------------------
// Defaults (idênticos a pop-pdf.js)
// ---------------------------------------------------------------------------
function applyDefaults(raw = {}) {
  const d = { ...raw };
  const def = (k, v) => {
    if (d[k] === undefined || d[k] === null || (typeof d[k] === 'string' && d[k].trim() === '')) d[k] = v;
  };
  def('consultancy', '[ Nome da sua consultoria ]');
  def('processName', '[ Nome do processo ]');
  def('sector', '[ Setor ]');
  def('oneLineDesc', '[ Breve descrição do processo em uma linha ]');
  def('code', 'POP-XX-000');
  def('version', '001');
  def('emission', '00/00/0000');
  def('responsible', '[ Cargo / equipe ]');
  def('lastRevision', '00/00/0000');
  def('materials', '[ Ex.: Computador, sistema X ]');
  def('processText', '');
  if (!Array.isArray(d.steps)) d.steps = [];
  if (d.flowchartImage === undefined) d.flowchartImage = null;
  return d;
}

// ---------------------------------------------------------------------------
// Estimativa de altura de texto (em polegadas).
// pptxgenjs não mede texto; usamos uma heurística baseada na largura média
// do caractere para quebrar parágrafos em múltiplas linhas.
// ---------------------------------------------------------------------------
// Lê as dimensões reais da imagem (PNG/JPEG/GIF/WebP) direto dos bytes — sem
// dependências. Necessário para enquadrar a imagem com proporção exata (o
// sizing "contain" do pptxgenjs não conhece as dimensões de data-URIs).
function imgInfo(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 30) return null;
  // PNG: IHDR fixo no offset 16 (width) / 20 (height)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), mime: 'image/png' };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), mime: 'image/gif' };
  }
  // JPEG: varre marcadores até um SOFn (C0–CF, exceto C4/C8/CC)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xff) { off++; continue; }
      if (marker >= 0xd0 && marker <= 0xd9) { off += 2; continue; } // RSTn/SOI/EOI sem payload
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7), mime: 'image/jpeg' };
      }
      off += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP + VP8X/VP8 /VP8L
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), mime: 'image/webp' };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, mime: 'image/webp' };
    if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >>> 14) & 0x3fff), mime: 'image/webp' }; }
    return null;
  }
  return null;
}

function toBuf(img) {
  if (!img) return null;
  return Buffer.isBuffer(img) ? img : Buffer.from(img);
}

function estimateTextHeight(text, widthIn, fontSize, lineSpacingMult = 1.15) {
  const str = String(text || '');
  // largura média aproximada de um caractere ~ 0.5 * fontSize (pt)
  const avgCharW = fontSize * 0.5; // pt
  const widthPt = widthIn * 72;
  const charsPerLine = Math.max(1, Math.floor(widthPt / avgCharW));
  // contar linhas considerando quebras explícitas
  const paragraphs = str.split('\n');
  let lines = 0;
  paragraphs.forEach((p) => {
    lines += Math.max(1, Math.ceil(p.length / charsPerLine));
  });
  const lineHeightPt = fontSize * lineSpacingMult * 1.2;
  return PT(lines * lineHeightPt);
}

// ---------------------------------------------------------------------------
// Helpers de desenho (cada um recebe `slide`)
// ---------------------------------------------------------------------------
function rect(slide, pptx, x, y, w, h, opts = {}) {
  const shapeOpts = { x, y, w, h };
  if (opts.fill) shapeOpts.fill = { color: opts.fill };
  else shapeOpts.fill = { type: 'none' };
  if (opts.line) shapeOpts.line = opts.line;
  if (opts.rectRadius !== undefined) shapeOpts.rectRadius = opts.rectRadius;
  const type = opts.rounded ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
  slide.addShape(type, shapeOpts);
}

function hline(slide, pptx, x, y, w, color, width = 1) {
  slide.addShape(pptx.ShapeType.line, {
    x, y, w, h: 0,
    line: { color, width, dashType: 'solid' },
  });
}

function dashedBox(slide, pptx, x, y, w, h, opts = {}) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h,
    fill: { type: 'none' },
    line: { color: opts.color || C.boxBorder, width: opts.lineWidth || 1, dashType: 'dash' },
    rectRadius: opts.radius !== undefined ? opts.radius : PT(6),
  });
}

function txt(slide, text, x, y, w, h, opts = {}) {
  slide.addText(String(text), {
    x, y, w, h,
    fontFace: opts.fontFace || F.sans,
    fontSize: opts.fontSize || 10,
    color: opts.color || C.body,
    bold: !!opts.bold,
    italic: !!opts.italic,
    align: opts.align || 'left',
    valign: opts.valign || 'top',
    lineSpacingMultiple: opts.lineSpacingMultiple || 1.0,
    charSpacing: opts.charSpacing !== undefined ? opts.charSpacing : 0,
    margin: opts.margin !== undefined ? opts.margin : 0,
    fit: opts.fit || 'none',
    wrap: opts.wrap !== undefined ? opts.wrap : true,
  });
}

// logo: 3 barrinhas teal/navy/teal
function miniLogo(slide, pptx, x, y, scale = 1) {
  const s = scale;
  const bars = [
    { h: PT(14 * s), col: C.teal },
    { h: PT(20 * s), col: C.navy },
    { h: PT(11 * s), col: C.teal },
  ];
  const bw = PT(4 * s);
  const gap = PT(2.5 * s);
  const baseline = y + PT(20 * s);
  let bx = x;
  bars.forEach((b) => {
    rect(slide, pptx, bx, baseline - b.h, bw, b.h, { fill: b.col, rounded: true, rectRadius: PT(1.5 * s) });
    bx += bw + gap;
  });
}

// Cabeçalho de seção com badge numerado
function sectionHeader(slide, pptx, number, title, startY) {
  const x = PAGE.margin;
  let y = (startY == null) ? PAGE.margin : startY;
  const badge = PT(30);
  rect(slide, pptx, x, y, badge, badge, { fill: C.navy, rounded: true, rectRadius: PT(7) });
  txt(slide, String(number), x, y, badge, badge, {
    fontFace: F.sans, fontSize: 15, color: C.white, bold: true, align: 'center', valign: 'middle',
  });
  txt(slide, title, x + badge + PT(14), y, CONTENT_W - badge - PT(14), badge, {
    fontFace: F.sans, fontSize: 19, color: C.navy, bold: true, align: 'left', valign: 'middle',
  });
  y += badge + PT(12);
  // linha divisória
  hline(slide, pptx, x, y, CONTENT_W, C.boxBorder, 0.8);
  // traço teal sob o início
  hline(slide, pptx, x, y, PT(46), C.teal, 2.5);
  return y + PT(22); // próxima posição de conteúdo
}

function label(slide, text, x, y, w) {
  txt(slide, String(text).toUpperCase(), x, y, w, PT(12), {
    fontFace: F.sans, fontSize: 7.5, color: C.labelGray, bold: true, charSpacing: 0.8, valign: 'top',
  });
  return y + PT(12);
}

// Caixa de dica com barra teal à esquerda
function tipBox(slide, pptx, text, y) {
  const x = PAGE.margin;
  const w = CONTENT_W;
  const padX = PT(16);
  const padY = PT(12);
  const innerW = w - padX * 2 - PT(6);
  const textH = estimateTextHeight(text, innerW, 9.5, 1.15);
  const h = textH + padY * 2;
  rect(slide, pptx, x, y, w, h, { fill: C.boxBg, rounded: true, rectRadius: PT(6) });
  rect(slide, pptx, x, y, PT(4), h, { fill: C.teal });
  txt(slide, text, x + padX + PT(4), y + padY, innerW, h - padY * 2, {
    fontFace: F.serif, fontSize: 9.5, color: C.body, lineSpacingMultiple: 1.15,
  });
  return y + h + PT(6);
}

// Card com borda e título teal. Retorna altura.
function card(slide, pptx, x, y, w, title, lines) {
  const padX = PT(14);
  const padY = PT(12);
  const innerW = w - padX * 2;
  const titleH = PT(12);
  let contentH = titleH + PT(6);
  const lineHeights = lines.map((ln) => estimateTextHeight(ln, innerW, 9.5, 1.15) + PT(3));
  contentH += lineHeights.reduce((a, b) => a + b, 0);
  const h = contentH + padY * 2;
  rect(slide, pptx, x, y, w, h, { fill: C.white, line: { color: C.boxBorder, width: 1 }, rounded: true, rectRadius: PT(6) });
  txt(slide, String(title).toUpperCase(), x + padX, y + padY, innerW, titleH, {
    fontFace: F.sans, fontSize: 8.5, color: C.teal, bold: true, charSpacing: 0.6,
  });
  let cy = y + padY + titleH + PT(6);
  lines.forEach((ln, i) => {
    txt(slide, ln, x + padX, cy, innerW, lineHeights[i], {
      fontFace: F.serif, fontSize: 9.5, color: C.body, lineSpacingMultiple: 1.15,
    });
    cy += lineHeights[i];
  });
  return h;
}

// Grade de info 2 colunas (cada célula é seu próprio retângulo + 2 caixas)
function infoGrid(slide, pptx, cells, startY, cols = 2) {
  const x = PAGE.margin;
  const w = CONTENT_W;
  const colW = w / cols;
  const padX = PT(12);
  const padY = PT(9);
  const innerW = colW - padX * 2;
  const labelH = PT(11);
  let y = startY;
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    let rowH = 0;
    row.forEach((cell) => {
      const vh = estimateTextHeight(cell.value, innerW, 10, 1.1);
      rowH = Math.max(rowH, labelH + PT(4) + vh);
    });
    rowH += padY * 2;
    row.forEach((cell, ci) => {
      const cx = x + ci * colW;
      rect(slide, pptx, cx, y, colW, rowH, { fill: C.white, line: { color: C.boxBorder, width: 0.8 } });
      label(slide, cell.label, cx + padX, y + padY, innerW);
      txt(slide, String(cell.value), cx + padX, y + padY + labelH + PT(4), innerW, rowH - padY * 2 - labelH - PT(4), {
        fontFace: F.sans, fontSize: 10, color: C.navy, bold: true, lineSpacingMultiple: 1.05,
      });
    });
    y += rowH;
  }
  return y;
}

// Tabela genérica (cabeçalho navy + linhas), desenhada com rects + caixas
function table(slide, pptx, startY, colWidths, header, rows) {
  const x = PAGE.margin;
  const padX = PT(8);
  const padY = PT(7);
  let y = startY;
  const totalW = colWidths.reduce((a, b) => a + b, 0);

  // cabeçalho
  const headH = PT(7.5 * 1.2) + padY * 2;
  rect(slide, pptx, x, y, totalW, headH, { fill: C.navy });
  let cx = x;
  header.forEach((htxt, i) => {
    txt(slide, String(htxt).toUpperCase(), cx + padX, y + padY, colWidths[i] - padX * 2, headH - padY * 2, {
      fontFace: F.sans, fontSize: 7.5, color: C.white, bold: true, charSpacing: 0.5,
    });
    cx += colWidths[i];
  });
  y += headH;

  // linhas
  rows.forEach((row) => {
    let rowH = 0;
    row.forEach((cell, i) => {
      const h = estimateTextHeight(cell, colWidths[i] - padX * 2, 9, 1.1);
      rowH = Math.max(rowH, h);
    });
    rowH += padY * 2;
    cx = x;
    row.forEach((cell, i) => {
      rect(slide, pptx, cx, y, colWidths[i], rowH, { line: { color: C.boxBorder, width: 0.8 } });
      txt(slide, String(cell), cx + padX, y + padY, colWidths[i] - padX * 2, rowH - padY * 2, {
        fontFace: F.serif, fontSize: 9, color: C.body, lineSpacingMultiple: 1.1,
      });
      cx += colWidths[i];
    });
    y += rowH;
  });
  return y;
}

// ícones BPMN simples com formas
function bpmnIcon(slide, pptx, type, x, y, size = PT(16)) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const nLine = { color: C.navy, width: 1 };
  const ell = (px, py, w, h, line, fill) => {
    const o = { x: px, y: py, w, h, line };
    o.fill = fill ? { color: fill } : { type: 'none' };
    slide.addShape(pptx.ShapeType.ellipse, o);
  };
  const dia = (px, py, w, h, fill) => {
    const o = { x: px, y: py, w, h, line: nLine };
    o.fill = fill ? { color: fill } : { type: 'none' };
    slide.addShape(pptx.ShapeType.diamond, o);
  };
  const rr = (px, py, w, h) => {
    slide.addShape(pptx.ShapeType.roundRect, { x: px, y: py, w, h, fill: { type: 'none' }, line: nLine, rectRadius: PT(2) });
  };
  const ln = (px, py, w, h, width = 1) => {
    slide.addShape(pptx.ShapeType.line, { x: px, y: py, w, h, line: { color: C.navy, width } });
  };
  const sm = size * 0.3;
  switch (type) {
    case 'start':
      ell(x, y, size, size, { color: C.navy, width: 1 });
      break;
    case 'startMsg':
      ell(x, y, size, size, { color: C.navy, width: 1 });
      rr(cx - sm / 2, cy - sm / 3, sm, (sm * 2) / 3);
      break;
    case 'startTimer':
      ell(x, y, size, size, { color: C.navy, width: 1 });
      ln(cx, cy - sm / 2, 0, sm / 2);
      ln(cx, cy, sm / 2, 0);
      break;
    case 'end':
      ell(x, y, size, size, { color: C.navy, width: 2.5 });
      break;
    case 'terminal':
      ell(x, y, size, size, { color: C.navy, width: 1 }, C.navy);
      break;
    case 'endMsg':
      ell(x, y, size, size, { color: C.navy, width: 2 });
      rr(cx - sm / 2, cy - sm / 3, sm, (sm * 2) / 3);
      break;
    case 'task':
      rr(x, cy - size * 0.31, size, size * 0.62);
      break;
    case 'subprocess':
      rr(x, cy - size * 0.31, size, size * 0.62);
      ln(cx, cy - sm / 3, 0, (sm * 2) / 3);
      ln(cx - sm / 3, cy, (sm * 2) / 3, 0);
      break;
    case 'arrow':
      slide.addShape(pptx.ShapeType.rightArrow, {
        x, y: cy - size * 0.18, w: size, h: size * 0.36,
        fill: { type: 'none' }, line: nLine,
      });
      break;
    case 'link':
      ell(x, y, size, size, { color: C.navy, width: 1 });
      ln(cx - sm / 2, cy, sm * 0.7, 0);
      break;
    case 'gwX':
      dia(x, y, size, size);
      ln(cx - sm / 2, cy - sm / 2, sm, sm);
      ln(cx - sm / 2, cy + sm / 2, sm, -sm);
      break;
    case 'gwParallel':
      dia(x, y, size, size);
      ln(cx, cy - sm / 2, 0, sm, 1.4);
      ln(cx - sm / 2, cy, sm, 0, 1.4);
      break;
    case 'gwInclusive':
      dia(x, y, size, size);
      ell(cx - sm / 2, cy - sm / 2, sm, sm, { color: C.navy, width: 1.4 });
      break;
    case 'data':
      rr(x + size * 0.1, y, size * 0.7, size);
      break;
    case 'annotation':
      ln(x, y, 0, size, 1);
      ln(x, y, size * 0.25, 0, 1);
      ln(x, y + size, size * 0.25, 0, 1);
      break;
    default:
      ell(x, y, size, size, { color: C.navy, width: 1 });
  }
}

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------
function coverPage(slide, pptx, d) {
  const x = PAGE.margin;
  // topo esquerdo: logo + consultoria
  miniLogo(slide, pptx, x, PAGE.margin - PT(2), 1);
  txt(slide, d.consultancy, x + PT(30), PAGE.margin, PT(280), PT(20), {
    fontFace: F.sans, fontSize: 11, color: C.navy, bold: true, valign: 'middle',
  });
  // topo direito
  txt(slide, 'DOCUMENTO INTERNO', PAGE.w - PAGE.margin - PT(200), PAGE.margin + PT(2), PT(200), PT(20), {
    fontFace: F.sans, fontSize: 8, color: C.labelGray, bold: true, align: 'right', charSpacing: 1.5, valign: 'middle',
  });
  // linha divisória sob o topo
  const lineY = PAGE.margin + PT(32);
  hline(slide, pptx, x, lineY, CONTENT_W, C.boxBorder, 0.8);

  // bloco central-baixo
  let y = PT(300);
  // eyebrow
  txt(slide, 'PROCEDIMENTO OPERACIONAL PADRÃO', x, y, CONTENT_W, PT(18), {
    fontFace: F.sans, fontSize: 10, color: C.teal, bold: true, charSpacing: 1,
  });
  y += PT(28);
  // título gigante "POP" — caixa própria
  txt(slide, 'POP', x, y, PT(300), PT(110), {
    fontFace: F.sans, fontSize: 96, color: C.navy, bold: true, valign: 'top',
  });
  y += PT(120);
  // traço teal curto e grosso
  hline(slide, pptx, x + PT(4), y, PT(76), C.teal, 6);
  y += PT(24);

  // chip do nome do processo (retângulo arredondado próprio + caixa de texto própria)
  const chipFontSize = 22;
  const chipPadX = PT(22);
  const chipPadY = PT(12);
  const chipTextW = Math.min(CONTENT_W - chipPadX * 2, String(d.processName).length * chipFontSize * 0.55 / 72);
  const chipW = chipTextW + chipPadX * 2;
  const chipH = PT(chipFontSize * 1.2) + chipPadY * 2;
  rect(slide, pptx, x, y, chipW, chipH, { fill: C.chipBg, rounded: true, rectRadius: PT(10) });
  txt(slide, d.processName, x + chipPadX, y, chipTextW, chipH, {
    fontFace: F.sans, fontSize: chipFontSize, color: C.teal, bold: true, valign: 'middle',
  });
  y += chipH + PT(18);

  // descrição
  txt(slide, d.oneLineDesc, x, y, CONTENT_W - PT(40), PT(50), {
    fontFace: F.serif, fontSize: 12, color: C.labelGray, italic: true, lineSpacingMultiple: 1.25,
  });

  // rodapé: 4 colunas (CÓDIGO/VERSÃO/EMISSÃO/ÁREA)
  const ty = PAGE.h - PAGE.margin - PT(70);
  const cols = [
    { label: 'CÓDIGO', value: d.code },
    { label: 'VERSÃO', value: d.version },
    { label: 'EMISSÃO', value: d.emission },
    { label: 'ÁREA', value: d.sector },
  ];
  const cw = CONTENT_W / 4;
  const th = PT(56);
  cols.forEach((c, i) => {
    const cx = x + i * cw;
    rect(slide, pptx, cx, ty, cw, th, { line: { color: C.boxBorder, width: 0.8 } });
    label(slide, c.label, cx + PT(12), ty + PT(12), cw - PT(24));
    txt(slide, String(c.value), cx + PT(12), ty + PT(12) + PT(11) + PT(5), cw - PT(24), PT(20), {
      fontFace: F.sans, fontSize: 12, color: C.navy, bold: true,
    });
  });
}

function identificationPage(slide, pptx, d) {
  let y = sectionHeader(slide, pptx, 'i', 'Identificação do documento');
  const cells = [
    { label: 'Título / Atividade', value: d.processName },
    { label: 'Código', value: d.code },
    { label: 'Área / Setor', value: d.sector },
    { label: 'Responsável(is)', value: d.responsible },
    { label: 'Data de emissão', value: d.emission },
    { label: 'Última revisão', value: d.lastRevision },
    { label: 'Versão', value: d.version },
    { label: 'Materiais necessários', value: d.materials },
  ];
  y = infoGrid(slide, pptx, cells, y);
  y += PT(24);

  // Histórico de revisões
  txt(slide, 'HISTÓRICO DE REVISÕES', PAGE.margin, y, CONTENT_W, PT(16), {
    fontFace: F.sans, fontSize: 12, color: C.navy, bold: true, charSpacing: 0.5,
  });
  y += PT(20);
  const cw = [PT(60), PT(90), CONTENT_W - PT(60) - PT(90) - PT(150), PT(150)];
  y = table(slide, pptx, y, cw,
    ['Versão', 'Data', 'Descrição da alteração', 'Responsável'],
    [
      ['001', d.emission, 'Criação do documento', d.responsible],
      ['—', '—', '—', '—'],
    ],
  );
  y += PT(24);

  // Sumário
  txt(slide, 'SUMÁRIO', PAGE.margin, y, CONTENT_W, PT(16), {
    fontFace: F.sans, fontSize: 12, color: C.navy, bold: true, charSpacing: 0.5,
  });
  y += PT(22);
  const toc = [
    ['1', 'Introdução', '3'],
    ['2', 'Mapeamento de processos', '3'],
    ['3', 'Legenda BPMN', '4'],
    ['4', 'O processo & fluxograma', '5'],
    ['5', 'Descrição das etapas', '6'],
    ['6', 'POP — procedimento detalhado', '7'],
  ];
  const x = PAGE.margin;
  toc.forEach(([num, title, pg]) => {
    txt(slide, num, x, y, PT(18), PT(16), {
      fontFace: F.sans, fontSize: 10, color: C.teal, bold: true,
    });
    txt(slide, title, x + PT(22), y, CONTENT_W - PT(22) - PT(30), PT(16), {
      fontFace: F.serif, fontSize: 10.5, color: C.body,
    });
    txt(slide, pg, PAGE.w - PAGE.margin - PT(30), y, PT(30), PT(16), {
      fontFace: F.sans, fontSize: 10, color: C.navy, bold: true, align: 'right',
    });
    y += PT(22);
  });
}

// Introdução + Mapeamento de processos em UMA página (os textos são curtos;
// separados ficavam com muito espaço vazio ao importar no Canva).
function introMappingPage(slide, pptx, d) {
  let y = sectionHeader(slide, pptx, 1, 'Introdução');
  const blocks = [
    {
      sub: 'O que é um POP?',
      par: 'O Procedimento Operacional Padrão (POP) é um documento que descreve, de forma clara e detalhada, todas as etapas necessárias para a execução de uma atividade. Funciona como guia de referência que padroniza a maneira como o trabalho é realizado, garantindo que qualquer colaborador o execute com o mesmo nível de qualidade, independentemente de quem o faça.',
    },
    {
      sub: 'Qual a finalidade deste POP?',
      par: `Este POP tem como finalidade padronizar, documentar e orientar todas as etapas envolvidas no processo de ${d.processName}, realizado pelo setor de ${d.sector}. O objetivo é assegurar uniformidade, clareza e eficiência na execução, reduzindo erros, retrabalho e variações entre colaboradores.`,
    },
    {
      sub: 'Quem deve seguir este POP?',
      par: `Este documento é de uso obrigatório para todos os colaboradores do setor de ${d.sector}, bem como para novos integrantes em fase de treinamento. Deve ser consultado sempre que houver dúvidas sobre a execução correta do processo.`,
    },
  ];
  blocks.forEach((b) => {
    txt(slide, b.sub, PAGE.margin, y, CONTENT_W, PT(15), {
      fontFace: F.sans, fontSize: 11.5, color: C.navy, bold: true,
    });
    y += PT(17);
    const ph = estimateTextHeight(b.par, CONTENT_W, 10, 1.18);
    txt(slide, b.par, PAGE.margin, y, CONTENT_W, ph, {
      fontFace: F.serif, fontSize: 10, color: C.body, align: 'justify', lineSpacingMultiple: 1.18,
    });
    y += ph + PT(10);
  });

  // Seção 2 na mesma página
  y = sectionHeader(slide, pptx, 2, 'Mapeamento de processos', y + PT(10));
  txt(slide, 'O que são processos?', PAGE.margin, y, CONTENT_W, PT(15), {
    fontFace: F.sans, fontSize: 11.5, color: C.navy, bold: true,
  });
  y += PT(17);
  const p1 = 'Processos são conjuntos de atividades organizadas com o objetivo de transformar entradas em saídas e gerar resultados. Eles alinham o trabalho dos setores aos objetivos da empresa, integrando tarefas de diferentes áreas de forma coordenada. Processos bem definidos proporcionam visão clara da operação, promovem o engajamento da equipe e facilitam a tomada de decisão.';
  const p2 = 'O mapeamento de processos registra como as atividades ocorrem na prática, permitindo identificar pontos de melhoria. A partir dele evolui-se para a modelagem, que representa a versão otimizada do processo. Para compreender os fluxogramas deste documento utilizamos a notação BPMN, cuja legenda está descrita a seguir.';
  let ph = estimateTextHeight(p1, CONTENT_W, 10, 1.18);
  txt(slide, p1, PAGE.margin, y, CONTENT_W, ph, {
    fontFace: F.serif, fontSize: 10, color: C.body, align: 'justify', lineSpacingMultiple: 1.18,
  });
  y += ph + PT(8);
  ph = estimateTextHeight(p2, CONTENT_W, 10, 1.18);
  txt(slide, p2, PAGE.margin, y, CONTENT_W, ph, {
    fontFace: F.serif, fontSize: 10, color: C.body, align: 'justify', lineSpacingMultiple: 1.18,
  });
  y += ph + PT(14);

  const gap = PT(16);
  const cardW = (CONTENT_W - gap) / 2;
  card(slide, pptx, PAGE.margin, y, cardW, 'Mapeamento', [
    'Como o processo acontece hoje — o estado atual ("as is").',
  ]);
  card(slide, pptx, PAGE.margin + cardW + gap, y, cardW, 'Modelagem', [
    'Como o processo deve acontecer — o estado otimizado ("to be").',
  ]);
}

function bpmnPage(slide, pptx, d) {
  let y = sectionHeader(slide, pptx, 3, 'Legenda BPMN');
  const intro = 'Referência dos principais elementos da notação BPMN utilizados nos fluxogramas deste documento.';
  const ih = estimateTextHeight(intro, CONTENT_W, 10.5, 1.2);
  txt(slide, intro, PAGE.margin, y, CONTENT_W, ih, {
    fontFace: F.serif, fontSize: 10.5, color: C.body, lineSpacingMultiple: 1.2,
  });
  y += ih + PT(12);

  const groups = [
    {
      title: 'Eventos de início',
      items: [
        ['start', 'Início', 'Início de um processo.'],
        ['startMsg', 'Mensagem', 'Início pela chegada de uma comunicação.'],
        ['startTimer', 'Temporal', 'Início a partir de um fato temporal.'],
      ],
    },
    {
      title: 'Eventos de fim',
      items: [
        ['end', 'Fim', 'Fim de um processo.'],
        ['terminal', 'Terminal', 'Fim sem nenhuma atividade posterior.'],
        ['endMsg', 'Mensagem', 'Fim com envio de uma comunicação.'],
      ],
    },
    {
      title: 'Atividades',
      items: [
        ['task', 'Tarefa', 'Ação realizada por pessoa ou sistema.'],
        ['subprocess', 'Subprocesso', 'Conjunto de atividades em sequência.'],
      ],
    },
    {
      title: 'Conexão',
      items: [
        ['arrow', 'Seta (fluxo)', 'Sequência entre os símbolos do processo.'],
        ['link', 'Link', 'Conexão entre partes do mesmo fluxo.'],
      ],
    },
    {
      title: 'Gateways',
      items: [
        ['gwX', 'Exclusivo', 'Apenas um dos caminhos será seguido.'],
        ['gwParallel', 'Paralelo', 'Divide o fluxo em caminhos simultâneos.'],
        ['gwInclusive', 'Inclusivo', 'Combinação possível de caminhos.'],
      ],
    },
    {
      title: 'Artefatos',
      items: [
        ['data', 'Objeto de dados', 'Documento ou dado ligado à atividade.'],
        ['annotation', 'Anotação', 'Comentário que agrega informação.'],
      ],
    },
  ];

  const gap = PT(16);
  const cardW = (CONTENT_W - gap) / 2;
  const padX = PT(14);
  const padY = PT(12);
  const iconSize = PT(16);
  const titleH = PT(12);
  const itemGap = PT(8);
  const innerW = cardW - padX * 2 - PT(24);

  let col = 0;
  let rowY = y;
  let rowMaxH = 0;

  groups.forEach((g) => {
    const cx = PAGE.margin + col * (cardW + gap);
    // medir altura
    const itemHeights = g.items.map(([, name, desc]) => {
      const nameH = PT(9 * 1.2);
      const descH = estimateTextHeight(desc, innerW, 8.5, 1.1);
      return Math.max(PT(20), nameH + descH);
    });
    let h = padY + titleH + PT(6);
    itemHeights.forEach((ih2) => { h += ih2 + itemGap; });
    h += padY - PT(4);

    rect(slide, pptx, cx, rowY, cardW, h, { fill: C.white, line: { color: C.boxBorder, width: 1 }, rounded: true, rectRadius: PT(6) });
    txt(slide, g.title.toUpperCase(), cx + padX, rowY + padY, cardW - padX * 2, titleH, {
      fontFace: F.sans, fontSize: 8.5, color: C.teal, bold: true, charSpacing: 0.6,
    });
    let iy = rowY + padY + titleH + PT(6);
    g.items.forEach(([icon, name, desc], idx) => {
      bpmnIcon(slide, pptx, icon, cx + padX, iy + PT(1), iconSize);
      const tx = cx + padX + PT(24);
      txt(slide, name, tx, iy, innerW, PT(9 * 1.2), {
        fontFace: F.sans, fontSize: 9, color: C.navy, bold: true,
      });
      const descH = estimateTextHeight(desc, innerW, 8.5, 1.1);
      txt(slide, desc, tx, iy + PT(9 * 1.2), innerW, descH, {
        fontFace: F.serif, fontSize: 8.5, color: C.labelGray, lineSpacingMultiple: 1.1,
      });
      iy += itemHeights[idx] + itemGap;
    });

    rowMaxH = Math.max(rowMaxH, h);
    col++;
    if (col === 2) {
      col = 0;
      rowY += rowMaxH + gap;
      rowMaxH = 0;
    }
  });
}

function processFlowPage(slide, pptx, d) {
  let y = sectionHeader(slide, pptx, 4, 'O processo & fluxograma');
  // descrição do processo
  txt(slide, 'Descrição do processo', PAGE.margin, y, CONTENT_W, PT(16), {
    fontFace: F.sans, fontSize: 12, color: C.navy, bold: true,
  });
  y += PT(20);
  const x = PAGE.margin;
  const w = CONTENT_W;
  const padX = PT(14);
  const padY = PT(12);
  const innerW = w - padX * 2;
  const hasText = d.processText && d.processText.trim() !== '';
  const textContent = hasText ? d.processText : '[ Descreva o processo em texto corrido ]';
  const textH = estimateTextHeight(textContent, innerW, 10.5, 1.2);
  const boxH = Math.max(PT(70), textH + padY * 2);
  rect(slide, pptx, x, y, w, boxH, { fill: C.boxBg, rounded: true, rectRadius: PT(6) });
  txt(slide, textContent, x + padX, y + padY, innerW, boxH - padY * 2, {
    fontFace: F.serif, fontSize: 10.5, color: hasText ? C.body : C.labelGray, italic: !hasText,
    align: hasText ? 'justify' : 'left', lineSpacingMultiple: 1.2,
  });
  y += boxH + PT(22);

  // fluxograma
  txt(slide, 'Fluxograma', PAGE.margin, y, CONTENT_W, PT(16), {
    fontFace: F.sans, fontSize: 12, color: C.navy, bold: true,
  });
  y += PT(20);
  const fy = y;
  const fh = BOTTOM - fy;
  dashedBox(slide, pptx, x, fy, w, fh, { radius: PT(8) });
  if (d.flowchartImage) {
    try {
      const pad = PT(14);
      const buf = toBuf(d.flowchartImage);
      const info = imgInfo(buf);
      const mime = (info && info.mime) || 'image/png';
      const dataUri = 'data:' + mime + ';base64,' + buf.toString('base64');
      const availW = w - pad * 2, availH = fh - pad * 2;
      if (info && info.w > 0 && info.h > 0) {
        // Enquadramento exato: escala pela proporção real e centraliza na caixa.
        const a = info.w / info.h;
        const dw = Math.min(availW, availH * a);
        const dh = dw / a;
        slide.addImage({ data: dataUri, x: x + pad + (availW - dw) / 2, y: fy + pad + (availH - dh) / 2, w: dw, h: dh });
      } else {
        slide.addImage({ data: dataUri, x: x + pad, y: fy + pad, w: availW, h: availH, sizing: { type: 'contain', w: availW, h: availH } });
      }
    } catch (e) {
      txt(slide, '[ Não foi possível carregar a imagem do fluxograma ]', x, fy + fh / 2 - PT(8), w, PT(20), {
        fontFace: F.serif, fontSize: 11, color: C.labelGray, italic: true, align: 'center',
      });
    }
  } else {
    txt(slide, '[ Cole aqui o fluxograma do processo ]', x, fy + fh / 2 - PT(10), w, PT(20), {
      fontFace: F.serif, fontSize: 12, color: C.labelGray, italic: true, align: 'center',
    });
  }
}

// Página extra para fluxogramas LARGOS (pools BPMN): imagem girada 90° para
// aproveitar a altura da folha — leitura muito maior que espremida na largura.
function flowchartZoomPage(slide, pptx, buf, info) {
  let y = sectionHeader(slide, pptx, 4, 'Fluxograma — visualização ampliada');
  txt(slide, 'Versão ampliada do fluxograma, girada 90° para melhor leitura: o início do processo fica no TOPO da página. Gire a página (ou o elemento, no Canva) para visualizar na horizontal.', PAGE.margin, y, CONTENT_W, PT(14), {
    fontFace: F.serif, fontSize: 10, color: C.labelGray, italic: true,
  });
  y += PT(24);
  const availW = CONTENT_W;
  const availH = BOTTOM - y;
  const a = info.w / info.h; // largo: a > 1
  // Girada 90° HORÁRIO: o lado esquerdo da imagem (início do processo) fica no
  // topo da página e o fim embaixo — leitura natural de cima para baixo.
  const dw = Math.min(availH, availW * a); // desenhada (vira ALTURA visual)
  const dh = dw / a;                       // desenhada (vira largura visual)
  const cx = PAGE.margin + availW / 2;
  const cy = y + availH / 2;
  const mime = info.mime || 'image/png';
  slide.addImage({
    data: 'data:' + mime + ';base64,' + buf.toString('base64'),
    x: cx - dw / 2, y: cy - dh / 2, w: dw, h: dh, rotate: 90,
  });
}

function stepsListPage(slide, pptx, d) {
  let y = sectionHeader(slide, pptx, 5, 'Descrição das etapas');

  const steps = d.steps.length ? d.steps : [{ title: '[ Descreva a primeira etapa ]', description: '' }];
  const x = PAGE.margin;
  steps.forEach((step, i) => {
    const num = String(i + 1);
    const badge = PT(26);
    const titleW = CONTENT_W - PT(38);
    const titleText = step.title || '[ Etapa ]';
    const titleH = estimateTextHeight(titleText, titleW, 11.5, 1.15);
    const rowH = Math.max(badge, titleH);
    rect(slide, pptx, x, y, badge, badge, { fill: C.chipBg, rounded: true, rectRadius: PT(6) });
    txt(slide, num, x, y, badge, badge, {
      fontFace: F.sans, fontSize: 12, color: C.teal, bold: true, align: 'center', valign: 'middle',
    });
    txt(slide, titleText, x + PT(38), y, titleW, rowH, {
      fontFace: F.serif, fontSize: 11.5, color: C.body, valign: 'top', lineSpacingMultiple: 1.15,
    });
    const endY = y + rowH + PT(10);
    hline(slide, pptx, x, endY, CONTENT_W, C.boxBorder, 0.6);
    y = endY + PT(10);
  });
}

// POP detalhado — tópico 6 no formato de tabela do modelo (POP-RH-003):
// cabeçalho (logo · título · página), metadados, OBSERVAÇÕES, PROCEDIMENTO com
// as etapas numeradas + bullets + caixa de evidência, e rodapé. Pode ocupar
// vários slides; cada linha desenha a própria borda, reconstruindo a tabela.
function popDetailPages(slides, pptx, d, addSlide) {
  const slide = slides[0];
  const x = PAGE.margin;
  const w = CONTENT_W;
  const padX = PT(8), padY = PT(7);
  const TB = { color: C.tableLine, width: 1 };

  const ctx = { slide, y: sectionHeader(slide, pptx, 6, 'POP — procedimento detalhado') };
  const ensure = (h) => { if (ctx.y + h > BOTTOM) { ctx.slide = addSlide(); ctx.y = PAGE.margin; } };

  // célula "Rótulo: valor" (rótulo em negrito navy + valor regular)
  const lvCell = (cx, cy, cw, ch, l, v) => {
    rect(ctx.slide, pptx, cx, cy, cw, ch, { line: TB });
    ctx.slide.addText([
      { text: l + ' ', options: { bold: true, color: C.navy } },
      { text: String(v == null ? '' : v), options: { bold: false, color: C.body } },
    ], { x: cx + padX, y: cy, w: cw - padX * 2, h: ch, fontFace: F.sans, fontSize: 9.5, valign: 'middle', align: 'left', margin: 0, lineSpacingMultiple: 1.05 });
  };
  // célula de metadado (rótulo pequeno acima do valor)
  const metaCell = (cx, cy, cw, ch, l, v) => {
    rect(ctx.slide, pptx, cx, cy, cw, ch, { line: TB });
    txt(ctx.slide, l, cx + padX, cy + PT(4), cw - padX * 2, PT(10), { fontFace: F.sans, fontSize: 7, color: C.body });
    txt(ctx.slide, String(v == null ? '' : v), cx + padX, cy + PT(13), cw - padX * 2, PT(12), { fontFace: F.sans, fontSize: 9, color: C.navy, bold: true });
  };
  // faixa escura full-width (OBSERVAÇÕES / PROCEDIMENTO)
  const bar = (t) => {
    const h = PT(18);
    rect(ctx.slide, pptx, x, ctx.y, w, h, { fill: C.navy, line: TB });
    txt(ctx.slide, t, x, ctx.y, w, h, { fontFace: F.sans, fontSize: 9, color: C.white, bold: true, align: 'center', valign: 'middle', charSpacing: 1.2 });
    ctx.y += h;
  };

  // ── cabeçalho: logo · título · página ──
  const headH = PT(38);
  ensure(headH);
  const logoW = PT(92), pageW = PT(70), titleW = w - logoW - pageW;
  rect(ctx.slide, pptx, x, ctx.y, logoW, headH, { line: TB });
  miniLogo(ctx.slide, pptx, x + logoW / 2 - PT(8), ctx.y + PT(9), 0.95);
  rect(ctx.slide, pptx, x + logoW, ctx.y, titleW, headH, { line: TB });
  txt(ctx.slide, 'PROCEDIMENTO OPERACIONAL PADRÃO - POP', x + logoW, ctx.y, titleW, headH, { fontFace: F.sans, fontSize: 11, color: C.navy, bold: true, align: 'center', valign: 'middle' });
  rect(ctx.slide, pptx, x + logoW + titleW, ctx.y, pageW, headH, { line: TB });
  txt(ctx.slide, 'Página 1 de 1', x + logoW + titleW, ctx.y, pageW, headH, { fontFace: F.sans, fontSize: 7.5, color: C.body, align: 'center', valign: 'middle' });
  ctx.y += headH;

  // ── metadados (4 colunas) ──
  const metaH = PT(26);
  ensure(metaH);
  const q = w / 4;
  metaCell(x, ctx.y, q, metaH, 'Data de emissão:', d.emission);
  metaCell(x + q, ctx.y, q, metaH, 'Data da Revisão:', d.lastRevision);
  metaCell(x + 2 * q, ctx.y, q, metaH, 'Área:', d.sector);
  metaCell(x + 3 * q, ctx.y, q, metaH, 'Versão nº', d.version);
  ctx.y += metaH;

  // ── Código · Atividade ──
  const caH = PT(20);
  ensure(caH);
  const codW = w * 0.40;
  lvCell(x, ctx.y, codW, caH, 'Código:', d.code);
  lvCell(x + codW, ctx.y, w - codW, caH, 'Atividade:', String(d.processName || '').toUpperCase());
  ctx.y += caH;

  // ── Responsável / Materiais (full width) ──
  [['Responsável:', d.responsible], ['Materiais necessários:', d.materials]].forEach(([l, v]) => {
    const h = PT(20); ensure(h);
    lvCell(x, ctx.y, w, h, l, v);
    ctx.y += h;
  });

  // ── OBSERVAÇÕES ──
  const obs = (d.processText && d.processText.trim()) ? d.processText : d.oneLineDesc;
  {
    const inner = w - padX * 2;
    const th = estimateTextHeight(obs, inner, 9.5, 1.2);
    const contentH = th + padY * 2;
    ensure(PT(18) + contentH);
    bar('OBSERVAÇÕES');
    rect(ctx.slide, pptx, x, ctx.y, w, contentH, { line: TB });
    txt(ctx.slide, obs, x + padX, ctx.y + padY, inner, th, { fontFace: F.serif, fontSize: 9.5, color: C.body, lineSpacingMultiple: 1.2, align: 'left' });
    ctx.y += contentH;
  }

  // ── PROCEDIMENTO ──
  const steps = d.steps.length
    ? d.steps
    : [{ title: '[ Descreva a primeira etapa ]', description: '[ Descreva o que deve ser feito nesta etapa ]' }];
  ensure(PT(18) + PT(64));
  bar('PROCEDIMENTO');

  const drawStepRow = (step, num) => {
    const hasPrint = step.hasPrint !== false;
    const inner = w - padX * 2;
    const title = num + '. ' + (step.title || '[ Etapa ]');
    const desc = (step.description && step.description.trim()) ? step.description : '[ Descreva o que deve ser feito nesta etapa ]';
    const titleH = estimateTextHeight(title, inner, 10.5, 1.15);
    const descH = estimateTextHeight(desc, inner - PT(12), 9.5, 1.2);
    const evH = hasPrint ? PT(96) : 0;
    const rowH = padY + titleH + PT(6) + descH + (hasPrint ? PT(10) + evH : 0) + padY;
    ensure(rowH);
    const yy = ctx.y;
    rect(ctx.slide, pptx, x, yy, w, rowH, { line: TB });
    txt(ctx.slide, title, x + padX, yy + padY, inner, titleH, { fontFace: F.sans, fontSize: 10.5, color: C.navy, bold: true, lineSpacingMultiple: 1.15 });
    const by = yy + padY + titleH + PT(6);
    txt(ctx.slide, '•', x + padX, by, PT(10), descH, { fontFace: F.sans, fontSize: 9.5, color: C.teal, bold: true });
    txt(ctx.slide, desc, x + padX + PT(12), by, inner - PT(12), descH, { fontFace: F.serif, fontSize: 9.5, color: C.body, lineSpacingMultiple: 1.2, align: 'left' });
    if (hasPrint) {
      const evY = by + descH + PT(10);
      dashedBox(ctx.slide, pptx, x + padX, evY, inner, evH, { radius: PT(5), color: C.boxBorder });
      txt(ctx.slide, '[ Cole o print da tela ]', x + padX, evY + evH / 2 - PT(8), inner, PT(16), { fontFace: F.serif, fontSize: 9.5, color: C.labelGray, italic: true, align: 'center' });
    }
    ctx.y += rowH;
  };
  steps.forEach((step, i) => drawStepRow(step, i + 1));

  // ── rodapé ──
  {
    const h = PT(20); ensure(h);
    rect(ctx.slide, pptx, x, ctx.y, w, h, { line: TB });
    ctx.slide.addText([
      { text: 'Referência complementar: ', options: { bold: true, color: C.navy } },
      { text: '[ preencha se houver ]', options: { italic: true, color: C.labelGray } },
    ], { x: x + padX, y: ctx.y, w: w - padX * 2, h, fontFace: F.sans, fontSize: 9, valign: 'middle', align: 'left', margin: 0 });
    ctx.y += h;
  }
  {
    const h = PT(20); ensure(h);
    const cW = w * 0.6;
    lvCell(x, ctx.y, cW, h, 'Elaborado por:', 'Produtiva Junior');
    lvCell(x + cW, ctx.y, w - cW, h, 'Revisão:', 'Trimestral');
    ctx.y += h;
  }
}

// Página final: logo da empresa centralizada + crédito Produtiva Junior.
function finalPage(slide, pptx, d) {
  const cx = PAGE.w / 2;
  let y = PAGE.h * 0.36;
  if (LOGO_B64) {
    const lw = 1.7;                 // largura da logo (in)
    const lh = lw * (422 / 418);    // proporção real do arquivo
    slide.addImage({ data: 'data:image/png;base64,' + LOGO_B64, x: cx - lw / 2, y: y - lh / 2, w: lw, h: lh });
    y += lh / 2 + PT(26);
  }
  txt(slide, 'Feito por', cx - 2, y, 4, PT(16), {
    fontFace: F.serif, fontSize: 11, color: C.labelGray, italic: true, align: 'center',
  });
  y += PT(20);
  txt(slide, 'PRODUTIVA JUNIOR', cx - 2.5, y, 5, PT(26), {
    fontFace: F.sans, fontSize: 19, color: C.navy, bold: true, align: 'center', charSpacing: 1,
  });
  y += PT(30);
  hline(slide, pptx, cx - PT(23), y, PT(46), C.teal, 2.5);
  y += PT(18);
  txt(slide, `${d.code} · v${d.version}`, cx - 2, y, 4, PT(14), {
    fontFace: F.sans, fontSize: 9, color: C.labelGray, align: 'center',
  });
}

// ---------------------------------------------------------------------------
// API principal
// ---------------------------------------------------------------------------
export async function buildPopPptx(rawData) {
  const d = applyDefaults(rawData);

  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'A4', width: PAGE.w, height: PAGE.h });
  pptx.layout = 'A4';

  const addSlide = () => pptx.addSlide();

  // Página 1 — capa
  coverPage(addSlide(), pptx, d);
  // Página 2 — identificação
  identificationPage(addSlide(), pptx, d);
  // Página 3 — introdução + mapeamento de processos (combinadas)
  introMappingPage(addSlide(), pptx, d);
  // Página 4 — legenda BPMN
  bpmnPage(addSlide(), pptx, d);
  // Página 5 — processo & fluxograma
  processFlowPage(addSlide(), pptx, d);
  // Página 5b — versão ampliada (girada) quando o fluxograma é muito largo
  const fbuf = toBuf(d.flowchartImage);
  const finfo = fbuf ? imgInfo(fbuf) : null;
  if (fbuf && finfo && finfo.w > 0 && finfo.h > 0 && finfo.w / finfo.h >= 1.6) {
    flowchartZoomPage(addSlide(), pptx, fbuf, finfo);
  }
  // Página 6 — descrição das etapas
  stepsListPage(addSlide(), pptx, d);
  // Página 7+ — POP detalhado (pode quebrar em vários slides)
  popDetailPages([addSlide()], pptx, d, addSlide);
  // Página final — logo da empresa + crédito
  finalPage(addSlide(), pptx, d);

  const buf = await pptx.write({ outputType: 'nodebuffer' });
  return buf;
}

export default buildPopPptx;

// ---------------------------------------------------------------------------
// Auto-teste (somente quando executado diretamente)
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(process.argv[1] || '###');
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    const fs = await import('node:fs/promises');
    const sample = {
      consultancy: 'Consultoria Exemplo',
      processName: 'Aprovação de pedidos',
      sector: 'Comercial',
      oneLineDesc: 'Processo de análise e aprovação de pedidos de clientes pelo time comercial.',
      code: 'POP-CO-001',
      version: '001',
      emission: '29/06/2026',
      responsible: 'Equipe Comercial',
      lastRevision: '29/06/2026',
      materials: 'Computador, sistema de gestão (ERP), e-mail',
      processText:
        'O processo de aprovação de pedidos inicia com o recebimento da solicitação do cliente. O time comercial verifica os dados, valida o crédito e confirma a disponibilidade de estoque antes de prosseguir com a aprovação formal e a emissão da ordem de venda.',
      steps: [
        { title: 'Receber a solicitação do cliente', description: 'Acessar a caixa de entrada do canal comercial e registrar o pedido recebido no sistema de gestão, conferindo se todos os campos obrigatórios foram preenchidos pelo cliente.' },
        { title: 'Validar dados cadastrais e de crédito', description: 'Consultar o cadastro do cliente no ERP, verificar o limite de crédito disponível e confirmar que não há pendências financeiras. Caso haja restrição, encaminhar para o setor financeiro antes de prosseguir. Esta etapa é crítica para evitar inadimplência e garantir que o pedido esteja em conformidade com a política comercial vigente da empresa, incluindo descontos autorizados e condições especiais de pagamento previamente negociadas.' },
        { title: 'Confirmar disponibilidade de estoque', description: 'Verificar no sistema a quantidade disponível dos itens solicitados e reservar os produtos para o pedido em análise.' },
        { title: 'Aprovar e emitir a ordem de venda', description: 'Registrar a aprovação no sistema, gerar a ordem de venda e notificar o cliente e a logística sobre a confirmação do pedido.' },
      ],
      flowchartImage: null,
    };
    const buf = await buildPopPptx(sample);
    const out = '/tmp/pop-sample.pptx';
    await fs.writeFile(out, buf);
    console.log(`OK ${out} ${buf.length}`);
  })().catch((e) => {
    console.error('FALHOU:', e);
    process.exit(1);
  });
}
