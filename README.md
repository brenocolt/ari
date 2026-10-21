# ARI — Assistente de Rotinas Inteligentes

Site que transforma descrições em linguagem natural em:

1. **Mapeamentos BPMN**: diagrama `.bpmn` com raias por responsável, prévia e ajustes por texto.
2. **POPs** (Procedimento Operacional Padrão): arquivo `.pptx` em um de três modelos de design, nas cores da logo da empresa, importável no Canva.
3. **Manuais**: texto estruturado, com opções de copiar e baixar.

## Como rodar

Requer Node.js 20.12 ou superior.

```bash
npm install
cp .env.example .env   # preencha ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

`npm run dev` reinicia o servidor a cada alteração. `npm test` gera um POP de exemplo na pasta temporária do sistema.

## Configuração (`.env`)

| Variável | Padrão | Para quê |
|---|---|---|
| `ANTHROPIC_API_KEY` | (obrigatória) | Chave da API da Anthropic, usada só no servidor |
| `ARI_MODEL` | `claude-opus-5-5` | Modelo usado nas gerações |
| `PORT` | `3000` | Porta do servidor |
| `ARI_EMPRESA` | `Produtiva Junior` | Autoria impressa no POP ("Elaborado por") |
| `ARI_REVISAO` | `Trimestral` | Periodicidade de revisão impressa no POP |
| `TYPESAFE_API_KEY` | (opcional) | Ativa a escolha do modelo do mapeamento pelo Jev |
| `ARI_MODEL_SIMPLES` / `ARI_MODEL_MEDIO` / `ARI_MODEL_COMPLEXO` | Haiku 5.5 / Sonnet 5.5 / Opus 5.5 | Modelo de cada faixa de complexidade |

### Conversa com a ARI

As três telas (mapeamento, POP e manual) usam um chat: a mensagem vai pelo campo de baixo (Enter envia, Shift+Enter quebra a linha) e a ARI responde na conversa; o resultado aparece no painel ao lado. A estrutura segue os componentes `message-scroller`, `message`, `bubble` e `input-group` do shadcn/ui, refeitos em HTML/CSS dentro do `ARI.dc.html` (o site não usa React com build nem Tailwind, então não dá para instalá-los com `npx shadcn add`).

- **Mapeamento:** com um diagrama na tela, a próxima mensagem ajusta o atual ("Ajustar este") ou gera um novo ("Novo mapeamento"). Os ajustes só são feitos pela conversa; depois de um mapeamento novo, o modo volta para "Ajustar este".
- **POP:** quando a ARI pede informações, a resposta é juntada à descrição anterior. A imagem do fluxograma é anexada pelo botão "Fluxograma" ou arrastada sobre o campo.
- Cada tela tem a sua conversa, guardada no navegador (últimas 40 mensagens). "Limpar conversa" apaga só o histórico.

### Como o mapeamento é gerado

1. **Complexidade.** O Jev (TypeSafe, `jev-latest`) dá uma nota à descrição em quatro dimensões: decisões, participantes, quantidade de atividades e ambiguidade. O `model-router.js` combina as notas com pesos e escolhe o modelo da faixa: baixa → simples, alta → o mais capaz. Sem `TYPESAFE_API_KEY`, ou se o Jev falhar, vale o `ARI_MODEL`. Pesos e limites ficam no topo do `model-router.js`.
2. **Perguntas (só na faixa alta).** O modelo complexo lista as ambiguidades que mudam a estrutura do diagrama (para onde vai um cancelamento, até onde volta um retrabalho, o que acontece quando um prazo estoura…). O usuário responde as que quiser; as demais usam a suposição sugerida.
3. **Geração.** A IA devolve um grafo BPMN (`bpmn-graph.js`): nós com tipo e raia, fluxos com condição. O formato aceita fins em qualquer ramo, gateways exclusivos, paralelos e inclusivos com várias saídas, ciclos de retrabalho, eventos de tempo e temporizadores de prazo presos às atividades. As regras de modelagem ficam no prompt de sistema do `bpmn-ai.js`.
4. **Validação e reparo.** O código verifica a estrutura: todos os caminhos alcançáveis e terminando num fim, fim sem saída, decisões com todas as saídas rotuladas, atividades com uma saída, ramos paralelos sincronizados por gateway paralelo. Se houver erros, a IA corrige (até duas rodadas).
5. **Revisão (só na faixa alta).** Uma segunda passada audita o grafo contra a descrição, trecho por trecho, e corrige o que estiver errado. As correções aparecem abaixo do diagrama.
6. **Desenho.** O `bpmn-layout.js` posiciona o grafo em raias e roteia as setas; o resultado abre no bpmn-js e é baixado como `.bpmn`.

Os ajustes do mapeamento usam o mesmo modelo da geração e passam pela mesma validação.

No formulário dá para escolher o tipo do início (simples, mensagem, temporizador, sinal, condicional) e do fim (simples, mensagem, terminar, erro, sinal, escalonamento); em branco, a ARI decide.

No diagrama:
- **Tipos dos elementos:** cada início, fim e atividade da prévia tem um botão azul (✎) no canto; ele (ou um clique no próprio elemento ou no nome do evento) abre, ao lado do elemento, os tipos possíveis com o ícone de cada um. Os botões entram no Tab; Esc fecha. Uma dica acima do diagrama explica o botão. A mesma troca existe em lista abaixo do diagrama (útil pelo teclado), com um seletor por início, fim e atividade (usuário, manual, serviço, envio, recebimento, script, regra de negócio, genérica). A troca é feita na hora, sem IA e sem mexer nas posições; no diagrama editado à mão só muda a tag/definição do elemento no XML. Eventos intermediários criados no editor (mensagem, sinal…) aparecem desabilitados: o tipo deles se troca pelo editor manual.
- **Baixar imagem .png:** o bpmn-js exporta o diagrama em SVG e o navegador o converte em PNG (2x; diagramas muito grandes são reduzidos para caber no limite de ~16 mil px).
- **Editar manualmente:** abre o diagrama em tela cheia no editor do bpmn-js (`bpmn-modeler.js`, baixado só nessa hora). Dá para mover caixas, religar setas arrastando a ponta, criar dobras, renomear, incluir e excluir elementos. Ao salvar, o XML editado vira a prévia e o download, fica guardado no navegador e é convertido de volta em grafo (`xmlToGraph` em `bpmn-layout.js`), que passa pelo validador. Trocar a cor das atividades mantém as posições; um ajuste por texto mantém ligações e nomes, mas refaz o layout.

### Como o POP é gerado

1. **Modelo.** Ao abrir a tela do POP, o usuário escolhe um dos três modelos de `modelo-pop/` (Clássico, Faixas ou Lateral). O conteúdo é o mesmo; muda o visual.
2. **Logo e cores.** Em seguida anexa a logo da empresa. O navegador lê as cores dela (`paletteFromPixels` em `pop-theme.js`): a cor mais escura vira a principal (títulos, tabelas, faixas) e a mais viva vira a de destaque (números, marcadores). Logo de uma cor só gera um tom escuro dela para a principal; logo preta, branca ou cinza mantém a paleta original do modelo. As cores podem ser ajustadas à mão e são escurecidas quando claras demais para o texto.
3. **Resumo.** No formulário ficam o modelo e a logo escolhidos; clicar em cada um reabre a escolha. Se o POP já foi gerado, trocar o modelo ou a logo refaz o arquivo sem chamar a IA de novo.
4. **Conteúdo.** A IA estrutura o processo (etapas, decisões com SE SIM / SE NÃO, conclusão) e mostra a lista de etapas com **todas desmarcadas**: o usuário marca só as que terão print de comprovação ("Marcar todas"/"Desmarcar todas" ajudam) e clica em "Gerar POP". A lista e as escolhas ficam no navegador; depois de um refresh, "Gerar POP" refaz o arquivo sem chamar a IA (a imagem do fluxograma não é guardada e precisa ser anexada de novo).
5. **Arquivo.** O servidor monta o `.pptx` com o `pop-layout.js`. A logo da consultoria (`modelo-pop/logo empresa.png`) entra sozinha na capa; a do cliente, no espaço "Logo do cliente". A prévia na tela é desenhada pelo mesmo `pop-layout.js`, em SVG, então mostra as mesmas páginas do arquivo.

O navegador lembra o último modelo, a logo e as cores (`localStorage`).

## Estrutura

| Arquivo | Papel |
|---|---|
| `server.js` | Express: serve o site e expõe `/api/complete`, `/api/pop-pptx` e `/api/config` |
| `ARI.dc.html` | O site inteiro (template e lógica do componente) |
| `support.js` | Runtime gerado que renderiza o `ARI.dc.html`. Não editar à mão |
| `pop-layout.js` | Layout do POP nos três modelos, escrito uma vez e desenhado em `.pptx` (servidor) ou SVG (prévia) |
| `pop-theme.js` | Modelos, paleta padrão, leitura das cores da logo e contraste |
| `pop-pptx.js` | Monta o `.pptx` do POP com pptxgenjs a partir do `pop-layout.js` |
| `modelo-pop/` | PDFs dos três modelos de referência e a logo da consultoria |
| `model-router.js` | Avalia a complexidade do processo com o Jev e escolhe o modelo do mapeamento |
| `bpmn-ai.js` | Prompts e chamadas da IA do mapeamento: perguntas, geração, reparo, revisão e ajuste |
| `bpmn-graph.js` | Formato do grafo BPMN, schema das saídas estruturadas e validador |
| `bpmn-layout.js` | Layout automático do grafo em raias e geração do XML BPMN 2.0 (roda no navegador) |
| `desk-robot.glb` | Robô 3D da página inicial (three.js r128 + GLTFLoader, carregados pelo próprio `ARI.dc.html`) |
| `bpmn-viewer.js` / `*.css` | bpmn-js 17.11.1 (visualizador) vendorizado, carregado só quando o mapeamento abre |
| `bpmn-modeler.js` / `bpmn-font.css` | bpmn-js 17.11.1 (editor) e os ícones da paleta, carregados só ao clicar em "Editar manualmente" |
| `referencia-*.bpmn` | Diagramas de referência de layout |

O navegador guarda rascunhos, o último mapeamento/manual e a lista de etapas do POP no `localStorage`, então um refresh não perde o trabalho.
