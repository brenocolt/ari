import pptxgen from 'pptxgenjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderPop, PAGE } from './pop-layout.js';
import { normHex } from './pop-theme.js';

// Monta o .pptx do POP. O layout dos três modelos está em pop-layout.js; aqui
// fica só a "superfície" que traduz o desenho para o pptxgenjs.

const __dir = dirname(fileURLToPath(import.meta.url));

// Lê as dimensões reais da imagem (PNG/JPEG/GIF/WebP) direto dos bytes, para
// enquadrar com a proporção exata.
export function imgInfo(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 30) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), mime: 'image/gif' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xff) { off++; continue; }
      if (marker >= 0xd0 && marker <= 0xd9) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7), mime: 'image/jpeg' };
      }
      off += 2 + len;
    }
    return null;
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), mime: 'image/webp' };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, mime: 'image/webp' };
    if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >>> 14) & 0x3fff), mime: 'image/webp' }; }
    return null;
  }
  return null;
}

// Buffer de imagem → { data (data URI), w, h }, ou null se não for imagem.
export function imageAsset(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const info = imgInfo(b);
  if (!info || !info.w || !info.h) return null;
  return { data: `data:${info.mime};base64,${b.toString('base64')}`, w: info.w, h: info.h };
}

// Logo da consultoria (entra sozinha na capa). Carregada uma vez do disco.
function loadLogo() {
  for (const p of [join(__dir, 'modelo-pop', 'logo empresa.png'), join(__dir, 'logo empresa.png')]) {
    try { return imageAsset(readFileSync(p)); } catch { /* tenta o próximo */ }
  }
  return null;
}
const CONSULTANCY_LOGO = loadLogo();

// Superfície pptxgenjs: recebe pt e converte para polegadas.
function pptxSurface(pptx) {
  const I = (v) => v / 72;
  const line = (l) => (l ? { color: l.color, width: l.width || 1, dashType: l.dash ? 'dash' : 'solid' } : undefined);
  return {
    addPage() {
      const s = pptx.addSlide();
      return {
        rect(x, y, w, h, o = {}) {
          s.addShape(o.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
            x: I(x), y: I(y), w: I(w), h: I(h),
            fill: o.fill ? { color: o.fill } : { type: 'none' },
            line: line(o.line),
            rectRadius: o.radius ? I(o.radius) : undefined,
          });
        },
        ellipse(x, y, w, h, o = {}) {
          s.addShape(pptx.ShapeType.ellipse, { x: I(x), y: I(y), w: I(w), h: I(h), fill: o.fill ? { color: o.fill } : { type: 'none' }, line: line(o.line) });
        },
        diamond(x, y, w, h, o = {}) {
          s.addShape(pptx.ShapeType.diamond, { x: I(x), y: I(y), w: I(w), h: I(h), fill: o.fill ? { color: o.fill } : { type: 'none' }, line: line(o.line) });
        },
        // Só linhas horizontais e verticais (é o que o layout usa).
        line(x1, y1, x2, y2, o = {}) {
          const l = line(o);
          if (o.arrow) l.endArrowType = 'triangle';
          s.addShape(pptx.ShapeType.line, { x: I(Math.min(x1, x2)), y: I(Math.min(y1, y2)), w: I(Math.abs(x2 - x1)), h: I(Math.abs(y2 - y1)), line: l });
        },
        image(x, y, w, h, img, o = {}) {
          s.addImage({ data: img.data, x: I(x), y: I(y), w: I(w), h: I(h), rotate: o.rotate || undefined });
        },
        text(x, y, w, h, content, st = {}) {
          const runs = Array.isArray(content)
            ? content.map((r) => ({ text: String(r.text), options: { ...(r.bold != null ? { bold: r.bold } : {}), ...(r.color ? { color: r.color } : {}) } }))
            : String(content);
          // Texto vertical: caixa horizontal girada 270° (lê de baixo para cima),
          // que o Canva e o PowerPoint importam melhor que o modo vertical.
          const box = st.vert ? { x: x + w / 2 - h / 2, y: y + h / 2 - w / 2, w: h, h: w } : { x, y, w, h };
          s.addText(runs, {
            x: I(box.x), y: I(box.y), w: I(box.w), h: I(box.h),
            rotate: st.vert ? 270 : undefined,
            fontFace: st.font || 'Inter', fontSize: st.size, color: st.outline ? st.outline.color : st.color,
            bold: !!st.bold, italic: !!st.italic,
            align: st.align || 'left', valign: st.valign || 'top',
            lineSpacing: st.lh, charSpacing: st.charSpacing || undefined,
            margin: 0, fit: 'none', wrap: true,
            // Texto vazado: só o contorno, preenchimento transparente.
            outline: st.outline ? { color: st.outline.color, size: st.outline.width } : undefined,
            transparency: st.outline ? 100 : undefined,
          });
        },
      };
    },
  };
}

// data: dados do POP; opts: { model, palette, clientLogo, flowchart } (imagens em Buffer).
export async function buildPopPptx(data = {}, opts = {}) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'A4', width: PAGE.w / 72, height: PAGE.h / 72 });
  pptx.layout = 'A4';
  const palette = opts.palette && { primary: normHex(opts.palette.primary), accent: normHex(opts.palette.accent) };
  renderPop(pptxSurface(pptx), data, {
    flowchart: imageAsset(opts.flowchart || data.flowchartImage),
    logo: CONSULTANCY_LOGO,
    clientLogo: imageAsset(opts.clientLogo),
  }, { model: opts.model, palette });
  return pptx.write({ outputType: 'nodebuffer' });
}

export default buildPopPptx;

// ---------------------------------------------------------------------------
// Auto-teste (somente quando executado diretamente): um POP de exemplo em cada
// modelo, na pasta temporária do sistema.
// ---------------------------------------------------------------------------
const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1] || '###'); } catch { return false; }
})();

if (isMain) {
  (async () => {
    const { default: assert } = await import('node:assert/strict');
    const { prepareData, svgSurface } = await import('./pop-layout.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const sample = {
      processName: 'Aprovação de pedidos',
      sector: 'Comercial',
      code: 'POP-CO-001',
      responsible: 'Equipe Comercial',
      materials: 'Computador, sistema de gestão (ERP), e-mail',
      processText: 'O processo de aprovação de pedidos inicia com o recebimento da solicitação do cliente.\nO time comercial verifica os dados, valida o crédito e confirma a disponibilidade de estoque antes da aprovação formal e da emissão da ordem de venda.',
      conclusion: 'Ordem de venda emitida e cliente notificado.',
      steps: [
        { title: 'Receber a solicitação do cliente', description: 'Acessar a caixa de entrada do canal comercial e registrar o pedido no sistema de gestão, conferindo os campos obrigatórios.' },
        { title: 'Validar o crédito do cliente', description: 'Consultar o cadastro no ERP e verificar o limite de crédito disponível e as pendências financeiras.', hasPrint: true, ifYes: 'Seguir para a confirmação de estoque.', ifNo: 'Encaminhar ao Financeiro e aguardar a liberação.' },
        { title: 'Confirmar disponibilidade de estoque', description: 'Verificar no sistema a quantidade disponível e reservar os produtos.', hasPrint: false },
        { title: 'Aprovar e emitir a ordem de venda', description: 'Registrar a aprovação, gerar a ordem de venda e notificar o cliente e a logística.' },
      ],
    };
    assert.deepEqual(prepareData(sample).steps.map((step) => step.hasPrint), [false, true, false, false]);
    assert.deepEqual(prepareData({ steps: [{}, { hasPrint: 'false' }, { hasPrint: null }] }).steps.map((step) => step.hasPrint), [false, false, false]);
    for (const model of [1, 2, 3]) {
      // A prévia e o PPTX compartilham a geometria: sem print, a descrição usa
      // toda a largura; só a escolha explícita reserva a coluna de evidência.
      const surface = svgSurface();
      const descriptions = new Map();
      const addPage = surface.addPage.bind(surface);
      surface.addPage = () => {
        const page = addPage(), text = page.text.bind(page);
        page.text = (x, y, w, h, content, style) => {
          if (sample.steps.some((step) => step.description === content)) descriptions.set(content, w);
          text(x, y, w, h, content, style);
        };
        return page;
      };
      renderPop(surface, sample, {}, { model });
      const svg = surface.pages.map((_, i) => surface.svg(i)).join('');
      assert.equal(svg.split('PRINT / EVIDÊNCIA DA TELA').length - 1, 1);
      assert(descriptions.get(sample.steps[0].description) > descriptions.get(sample.steps[1].description) * 1.8);
      const withoutPrints = svgSurface();
      renderPop(withoutPrints, { ...sample, steps: sample.steps.map((step) => ({ ...step, hasPrint: false })) }, {}, { model });
      assert(!withoutPrints.pages.map((_, i) => withoutPrints.svg(i)).join('').includes('PRINT / EVIDÊNCIA DA TELA'));
      assert(withoutPrints.pages.length <= surface.pages.length);
      const buf = await buildPopPptx(sample, { model });
      const out = path.join(os.tmpdir(), `pop-modelo-${model}.pptx`);
      await fs.writeFile(out, buf);
      console.log(`OK ${out} ${buf.length}`);
    }
  })().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
}
