require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // 25mb pra caber múltiplos anexos
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''; // opcional — habilita edição de imagem de verdade (preserva a foto real)
const MODEL = 'claude-sonnet-4-6'; // troque se precisar de outra versão
const FREE_LIMIT_PER_DAY = parseInt(process.env.FREE_LIMIT_PER_DAY || '8', 10);

if (!ANTHROPIC_API_KEY) {
  console.error('ERRO: defina ANTHROPIC_API_KEY no arquivo .env antes de rodar o servidor.');
  process.exit(1);
}

// --- controle de uso gratuito (em memória; some se reiniciar o servidor) ---
// Pra produção de verdade isso deveria ir num banco (Postgres, Redis etc),
// mas pra testar sozinho e validar o produto isso já resolve.
const usage = new Map(); // deviceId -> { count, date }

function checkAndConsumeQuota(deviceId) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = usage.get(deviceId);
  if (!entry || entry.date !== today) {
    usage.set(deviceId, { count: 1, date: today });
    return { allowed: true, remaining: FREE_LIMIT_PER_DAY - 1 };
  }
  if (entry.count >= FREE_LIMIT_PER_DAY) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: FREE_LIMIT_PER_DAY - entry.count };
}

// --- helper pra chamar a API da Anthropic ---
async function callClaude({ system, content, maxTokens = 1400, messages = null, timeoutMs = 28000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: messages || [{ role: 'user', content }]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    const block = (data.content || []).find(b => b.type === 'text');
    return { text: block ? block.text.trim() : '', stopReason: data.stop_reason };
  } finally {
    clearTimeout(timer);
  }
}

// middleware simples de identificação do dispositivo (sem login)
app.use((req, res, next) => {
  req.deviceId = req.headers['x-device-id'] || req.ip;
  next();
});

// checa quota sem consumir (pro app mostrar "quantos restam" antes de gerar)
app.get('/api/quota', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const entry = usage.get(req.deviceId);
  const used = (entry && entry.date === today) ? entry.count : 0;
  res.json({ limit: FREE_LIMIT_PER_DAY, used, remaining: Math.max(0, FREE_LIMIT_PER_DAY - used) });
});

app.post('/api/next-question', async (req, res) => {
  try {
    const { projectInput, previousQA } = req.body;
    const isFirst = !Array.isArray(previousQA) || previousQA.length === 0;
    const countSoFar = isFirst ? 0 : previousQA.length;
    const MIN_Q = 3, MAX_Q = 5;

    let system, content;

    if (isFirst) {
      system = `Você conduz uma entrevista adaptativa, uma pergunta de cada vez, pra montar o prompt de IA perfeito depois. Gere APENAS a PRIMEIRA pergunta, específica pro tipo de projeto (não genérica), com 4 a 6 opções curtas (2-4 palavras) cada uma com emoji representativo.
Classifique também o pedido: "project_type" (nome curto do tipo de projeto), "output_type" ("imagem" quando o resultado final é uma imagem/foto/design, ou "texto" quando é texto/código/roteiro/documento), "requires_attachment" (true se normalmente precisa de um arquivo de referência tipo foto ou documento antigo, senão false) e "attachment_label" (frase curta pedindo o anexo certo, só se requires_attachment for true).
Caso especial — se for currículo/CV: a entrevista deve cobrir ao longo das perguntas (não precisa ser tudo na primeira): cargo/área desejada, nível de experiência, habilidades técnicas, formação, conquistas mensuráveis, e o estilo de layout (onde fica a foto: topo, lateral, sem foto, canto).
Responda APENAS com JSON válido, sem markdown:
{"project_type":"...", "output_type":"texto", "requires_attachment":false, "attachment_label":"", "question":{"id":"slug_curto","label":"pergunta","options":[{"label":"opção","icon":"emoji"}]}}`;
      content = projectInput;
    } else {
      const historyText = previousQA.map(qa => `${qa.label}: ${qa.answer}`).join('\n');
      system = `Você está no meio de uma entrevista adaptativa pra montar o prompt de IA perfeito. Já foram feitas e respondidas ${countSoFar} pergunta(s). Avalie o que já se sabe e decida:
- Se já há contexto suficiente (mínimo ${MIN_Q} perguntas já respondidas) e nenhuma lacuna importante ficou faltando, retorne {"done": true}.
- Caso contrário, gere a PRÓXIMA pergunta mais relevante considerando especificamente as respostas já dadas (não repita perguntas nem temas já cobertos), com 4 a 6 opções curtas com emoji. NUNCA ultrapasse ${MAX_Q} perguntas no total — se já chegou em ${MAX_Q}, retorne {"done": true} mesmo que reste alguma dúvida menor.
Responda APENAS com JSON válido, sem markdown:
{"done": false, "question": {"id":"slug_curto","label":"pergunta","options":[{"label":"opção","icon":"emoji"}]}}
ou, se decidir encerrar:
{"done": true}`;
      content = `Pedido original: ${projectInput}\n\nRespostas até agora:\n${historyText}`;
    }

    // consome a cota de uso gratuito só na primeira pergunta de cada projeto
    if (isFirst) {
      const quota = checkAndConsumeQuota(req.deviceId);
      if (!quota.allowed) {
        return res.status(429).json({ error: 'limite_gratuito_atingido', message: 'Você usou seus prompts gratuitos de hoje. Volte amanhã ou assine o plano completo.' });
      }
    }

    const { text: raw } = await callClaude({ system, content });
    const clean = raw.replace(/```json|```/g, '').trim();
    const json = JSON.parse(clean);
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui gerar a próxima pergunta. Tenta de novo.' });
  }
});

app.post('/api/questions', async (req, res) => {
  const quota = checkAndConsumeQuota(req.deviceId);
  if (!quota.allowed) {
    return res.status(429).json({ error: 'limite_gratuito_atingido', message: 'Você usou seus prompts gratuitos de hoje. Volte amanhã ou assine o plano completo.' });
  }
  try {
    const { projectInput } = req.body;
    const system = `Você decompõe pedidos de criação em perguntas interativas para montar o prompt de IA perfeito depois. Dado o pedido do usuário, gere SEMPRE NO MÍNIMO 3 e no máximo 4 perguntas ESPECÍFICAS para esse tipo de projeto (não genéricas — se for uma foto, pergunte sobre estética/composição/luz; se for um texto de venda, pergunte sobre público/tom/gatilho; adapte sempre ao pedido). Nunca gere menos de 3 perguntas: se o pedido for muito simples e você não encontrar 3 perguntas específicas o suficiente, complete com perguntas relevantes mas um pouco mais gerais (ex: tom desejado, formato de saída, nível de detalhe) até atingir o mínimo de 3. Para cada pergunta, gere de 4 a 6 opções curtas (2-4 palavras), específicas ao contexto, cada uma com um emoji representativo.
Além disso, avalie se esse tipo de projeto normalmente exige que o usuário anexe algum arquivo de referência (uma foto para editar/estilizar, um documento para basear um texto, uma imagem de produto, um logo, etc). Se exigir, marque "requires_attachment": true e escreva um "attachment_label" curto pedindo o anexo certo. Se não fizer sentido pedir anexo, marque "requires_attachment": false.
Por fim, classifique o "output_type" do projeto como "imagem" (quando o resultado final é uma imagem/foto/ilustração/design) ou "texto" (quando o resultado final é texto, código, roteiro, etc).
Caso especial — se o pedido for sobre currículo/CV: as perguntas devem ser profissionais e específicas para montar um currículo de verdade, cobrindo (adapte a quantidade ao mínimo/máximo de perguntas): cargo ou área desejada, nível de experiência, principais habilidades/competências técnicas, formação acadêmica, e conquistas ou resultados mensuráveis relevantes. As opções de cada pergunta devem refletir isso (ex: níveis como "Estagiário/Trainee", "Pleno", "Sênior", "Especialista").
Responda APENAS com JSON válido neste formato exato, sem markdown, sem texto fora do JSON:
{"project_type": "nome curto do tipo de projeto", "output_type": "imagem", "requires_attachment": true, "attachment_label": "frase curta pedindo o anexo", "questions": [{"id": "slug_curto", "label": "pergunta", "options": [{"label": "opção", "icon": "emoji"}]}]}`;

    const { text: raw } = await callClaude({ system, content: projectInput });
    const clean = raw.replace(/```json|```/g, '').trim();
    const json = JSON.parse(clean);
    res.json({ ...json, quotaRemaining: quota.remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui gerar as perguntas. Tenta de novo.' });
  }
});

app.post('/api/final-prompt', async (req, res) => {
  try {
    const { projectInput, questions, answers, attachments } = req.body;
    const allAttachments = Array.isArray(attachments) ? attachments.filter(a => a && a.base64) : [];
    const imageList = allAttachments.filter(a => (a.mime || '').startsWith('image/'));
    const pdfList = allAttachments.filter(a => a.mime === 'application/pdf');
    const otherList = allAttachments.filter(a => !(a.mime || '').startsWith('image/') && a.mime !== 'application/pdf');
    const hasAnalyzable = imageList.length + pdfList.length > 0;
    const totalCount = allAttachments.length;
    const qaLines = (questions || []).map(q => `${q.label}: ${answers[q.id]}`).join('\n');

    const system = `Você é um motor de engenharia de prompts. O usuário descreveu um projeto e já respondeu perguntas de refinamento${totalCount ? `, e anexou ${totalCount > 1 ? totalCount + ' arquivos de referência' : 'um arquivo de referência'} que você está vendo (ou que foram mencionados por nome, se o formato não puder ser analisado diretamente)` : ''}. Monte o prompt final otimizado em português, pronto para colar em qualquer IA generativa, incorporando TODAS as respostas dadas.
Aplique boas práticas: contexto claro, persona quando fizer sentido, formato de saída definido, restrições relevantes.
${hasAnalyzable ? 'Como há anexo(s) analisáveis: descreva no prompt, com detalhe real e específico, o que está neles (composição, iluminação, ângulo, cores, ambiente, ou conteúdo relevante se for um documento como currículo antigo) e como isso deve ser aproveitado, preservado ou transformado. Se for referência de foto/imagem, inclua instruções explícitas contra artefatos comuns de geração de imagem (pele plástica, mãos deformadas, fundo genérico, watermarks) e peça texturas reais e iluminação coerente.' : ''}
Se restar alguma informação que só o usuário sabe, inclua como campo entre colchetes, ex: [Nome da marca].
Responda APENAS com o prompt final, texto puro, sem explicações, sem markdown, sem aspas ao redor.`;

    let textContent = `Pedido original: ${projectInput}\n\nRespostas:\n${qaLines}`;
    if(otherList.length){
      textContent += `\n\nArquivos anexados que não puderam ser analisados diretamente pelo formato (considere-os pelo nome/contexto): ${otherList.map(a => a.name || 'arquivo').join(', ')}`;
    }

    const content = hasAnalyzable
      ? [
          ...imageList.map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.base64 } })),
          ...pdfList.map(a => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } })),
          { type: 'text', text: textContent }
        ]
      : textContent;

    const { text: finalPrompt } = await callClaude({ system, content });
    res.json({ finalPrompt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui gerar o prompt final. Tenta de novo.' });
  }
});

app.post('/api/execute-text', async (req, res) => {
  const { finalPrompt } = req.body;
  const system = `Responda ao pedido abaixo da melhor forma possível, com qualidade profissional, pronto para uso.
Antes de começar, avalie mentalmente se o conteúdo completo e ideal cabe com folga no espaço de resposta disponível. Se sim, escreva o quanto for necessário, sem resumir demais — pode escrever bastante se o pedido pedir algo extenso (ex: apostila, guia completo, material longo, petição, contrato).
Se avaliar que o conteúdo ideal NÃO caberia por completo, priorize entregar uma versão mais condensada mas COMPLETA — nunca termine no meio de uma frase, de um argumento, de uma seção ou sem a conclusão/fechamento apropriado (ex: uma petição sem pedido final e fecho, um contrato sem assinatura, um texto sem conclusão). É sempre melhor um documento mais curto e inteiro do que um documento mais longo e cortado.`;
  const messages = [{ role: 'user', content: finalPrompt }];
  let fullText = '';
  let stopReason = null;
  const MAX_ROUNDS = 8;
  const ROUND_MAX_TOKENS = 1200; // menor = termina bem mais rápido, com folga confortável de tempo
  const ROUND_TIMEOUT_MS = 40000; // generoso o suficiente pra não cortar geração normal, ainda protege contra travamento de verdade
  const TIME_BUDGET_MS = 42000; // a partir daqui, para de pedir continuação normal
  const WRAP_UP_DEADLINE_MS = 50000; // depois disso, nem tenta mais fechar — usa o que tem
  const startedAt = Date.now();
  let didWrapUp = false;

  const CONTINUE_PROMPT = 'Continue exatamente de onde parou, sem repetir o que já foi escrito e sem reintroduzir o assunto. Se estiver perto do fim, conclua o documento de forma completa e apropriada.';
  const WRAP_UP_PROMPT = 'O tempo está acabando. Pare por aqui e conclua AGORA: se não deu tempo de terminar todo o conteúdo planejado, resuma rapidamente o que faltaria em poucas linhas e finalize o documento de forma completa e apropriada (com fechamento/conclusão de verdade). Seja direto, sem continuar detalhando como antes.';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > WRAP_UP_DEADLINE_MS) break; // sem tempo nem pra fechar — usa o que já tem

    let isWrapUp = false;
    if (round > 0) {
      // decide a instrução desta rodada de continuação, com base no tempo restante
      const outOfNormalTime = elapsed > TIME_BUDGET_MS;
      if (outOfNormalTime && didWrapUp) break; // já tentou fechar — encerra com o que tem
      isWrapUp = outOfNormalTime && !didWrapUp;
      messages.push({ role: 'user', content: isWrapUp ? WRAP_UP_PROMPT : CONTINUE_PROMPT });
      if (isWrapUp) didWrapUp = true;
    }

    try {
      const roundMaxTokens = isWrapUp ? 900 : ROUND_MAX_TOKENS;
      const { text, stopReason: sr } = await callClaude({ system, messages, maxTokens: roundMaxTokens, timeoutMs: ROUND_TIMEOUT_MS });
      fullText += text;
      stopReason = sr;
      if (isWrapUp) break; // depois de fechar, não continua de jeito nenhum
      if (stopReason !== 'max_tokens') break; // terminou naturalmente
      messages.push({ role: 'assistant', content: text });
    } catch (roundErr) {
      console.error('Rodada falhou ou expirou:', roundErr.message);
      break; // aproveita o que já foi gerado nas rodadas anteriores, se houver
    }
  }

  if (!fullText) {
    return res.status(500).json({ error: 'erro_interno', message: 'Não consegui gerar o resultado. Tenta de novo.' });
  }
  res.json({ result: fullText, truncated: stopReason === 'max_tokens' || stopReason === 'time_budget' });
});

app.get('/api/image-provider', (req, res) => {
  res.json({ geminiAvailable: !!GEMINI_API_KEY });
});

app.post('/api/generate-image', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(400).json({ error: 'gemini_nao_configurado', message: 'Chave do Gemini não configurada nesse servidor.' });
  }
  try {
    const { prompt, attachments } = req.body;
    const imageAttachments = Array.isArray(attachments) ? attachments.filter(a => a && a.base64 && (a.mime || '').startsWith('image/')) : [];

    const parts = [{ text: prompt }];
    imageAttachments.forEach(a => {
      parts.push({ inlineData: { mimeType: a.mime, data: a.base64 } });
    });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API error:', errText);
      return res.status(502).json({ error: 'gemini_erro', message: 'O editor de imagem não respondeu corretamente.' });
    }

    const data = await response.json();
    const resultParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = resultParts.find(p => p.inlineData || p.inline_data);
    const inline = imagePart && (imagePart.inlineData || imagePart.inline_data);

    if (!inline) {
      return res.status(502).json({ error: 'sem_imagem', message: 'O editor de imagem não devolveu uma imagem dessa vez.' });
    }

    res.json({ base64: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui editar a imagem agora.' });
  }
});

app.post('/api/execute-presentation', async (req, res) => {
  try {
    const { finalPrompt } = req.body;
    const system = `Você é um especialista em criar apresentações profissionais. Com base no pedido a seguir, gere o conteúdo completo de uma apresentação em slides, com título forte, conteúdo objetivo e bem distribuído (nada de slides lotados de texto — poucos bullets curtos por slide).
IMPORTANTE: todo texto deve ser puro, sem markdown (sem **negrito**, sem # títulos, sem símbolos de formatação).
Gere entre 6 e 10 slides, dependendo da complexidade do pedido. Seja conciso em cada bullet (máximo uma frase curta).
Responda APENAS com JSON válido, compacto, sem markdown, sem comentários, neste formato exato:
{"title": "título da apresentação", "slides": [{"title": "título do slide", "bullets": ["ponto 1", "ponto 2"], "notes": "observações do apresentador, opcional"}]}`;
    const { text: raw } = await callClaude({ system, content: finalPrompt, maxTokens: 3000, timeoutMs: 45000 });
    let clean = raw.replace(/```json|```/g, '').trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) clean = clean.slice(firstBrace, lastBrace + 1);
    let presentationData;
    try {
      presentationData = JSON.parse(clean);
    } catch (parseErr) {
      // fallback: tenta recuperar só os slides que já vieram completos antes do corte
      const partialSlides = [];
      const slideMatches = clean.matchAll(/\{\s*"title"\s*:\s*"([^"]*)"\s*,\s*"bullets"\s*:\s*\[([^\]]*)\]/g);
      for (const m of slideMatches) {
        const bullets = (m[2].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1));
        if (m[1] && bullets.length) partialSlides.push({ title: m[1], bullets, notes: '' });
      }
      presentationData = partialSlides.length
        ? { title: 'Apresentação', slides: partialSlides }
        : { title: 'Apresentação', slides: [{ title: 'Resumo', bullets: [raw.replace(/```json|```/g, '').trim().slice(0, 300)], notes: '' }] };
    }
    res.json({ presentationData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui montar a apresentação. Tenta de novo.' });
  }
});

app.post('/api/execute-resume', async (req, res) => {
  try {
    const { finalPrompt } = req.body;
    const system = `Você é um especialista em currículos profissionais. Com base no pedido a seguir, gere o conteúdo completo de um currículo profissional otimizado, com linguagem objetiva, verbos de ação e resultados mensuráveis nos pontos de experiência sempre que fizer sentido.
Para campos de dado pessoal que não foram informados (nome, e-mail, telefone), use um placeholder entre colchetes, ex: [Seu nome], [seu@email.com].
IMPORTANTE: o VALOR de cada campo deve ser texto puro, sem markdown — nunca use **negrito**, *itálico*, # títulos ou qualquer símbolo de formatação dentro dos textos.
Se houver muita experiência pra caber com folga, priorize entregar TODOS os campos preenchidos de forma mais concisa (menos bullets por cargo) em vez de deixar o JSON incompleto ou cortado — o JSON precisa sempre fechar corretamente.
Responda APENAS com JSON válido, compacto, sem markdown, sem comentários, neste formato exato:
{"name":"...", "title":"...", "contact":"...", "summary":"...", "experience":[{"role":"...","company":"...","period":"...","bullets":["...","..."]}], "education":[{"degree":"...","institution":"...","period":"..."}], "skills":["...","..."]}`;
    const { text: raw } = await callClaude({ system, content: finalPrompt, maxTokens: 3000, timeoutMs: 45000 });
    let clean = raw.replace(/```json|```/g, '').trim();
    // se vier algum texto extra antes/depois do JSON, recorta só o objeto
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      clean = clean.slice(firstBrace, lastBrace + 1);
    }
    let resumeData;
    try {
      resumeData = JSON.parse(clean);
    } catch (parseErr) {
      // fallback: currículo ainda sai, só que como texto corrido dentro do resumo
      resumeData = { name: '[Seu nome]', title: '', contact: '', summary: raw.replace(/```json|```/g, '').trim(), experience: [], education: [], skills: [] };
    }
    res.json({ resumeData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui montar o currículo. Tenta de novo.' });
  }
});

module.exports = app;
