require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // 25mb pra caber múltiplos anexos
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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
async function callClaude({ system, content, maxTokens = 1400, messages = null }) {
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
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const block = (data.content || []).find(b => b.type === 'text');
  return { text: block ? block.text.trim() : '', stopReason: data.stop_reason };
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
  try {
    const { finalPrompt } = req.body;
    const system = 'Responda ao pedido abaixo da melhor forma possível, com qualidade profissional, pronto para uso. Se o conteúdo pedido for extenso (ex: apostila, guia completo, material longo), pode escrever bastante — não resuma demais.';
    const messages = [{ role: 'user', content: finalPrompt }];
    let fullText = '';
    let stopReason = null;
    const MAX_ROUNDS = 4;
    const ROUND_MAX_TOKENS = 3000;
    const TIME_BUDGET_MS = 42000; // fica com folga dentro do limite de 60s do Vercel
    const startedAt = Date.now();

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        stopReason = 'time_budget';
        break;
      }
      const { text, stopReason: sr } = await callClaude({ system, messages, maxTokens: ROUND_MAX_TOKENS });
      fullText += text;
      stopReason = sr;
      if (stopReason !== 'max_tokens') break;
      // pede pra continuar exatamente de onde parou
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: 'Continue exatamente de onde parou, sem repetir o que já foi escrito e sem reintroduzir o assunto.' });
    }

    res.json({ result: fullText, truncated: stopReason === 'max_tokens' || stopReason === 'time_budget' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui gerar o resultado. Tenta de novo.' });
  }
});

app.post('/api/execute-resume', async (req, res) => {
  try {
    const { finalPrompt } = req.body;
    const system = `Você é um especialista em currículos profissionais. Com base no pedido a seguir, gere o conteúdo completo de um currículo profissional otimizado, com linguagem objetiva, verbos de ação e resultados mensuráveis nos pontos de experiência sempre que fizer sentido.
Para campos de dado pessoal que não foram informados (nome, e-mail, telefone), use um placeholder entre colchetes, ex: [Seu nome], [seu@email.com].
Responda APENAS com JSON válido, compacto, sem markdown, sem comentários, neste formato exato:
{"name":"...", "title":"...", "contact":"...", "summary":"...", "experience":[{"role":"...","company":"...","period":"...","bullets":["...","..."]}], "education":[{"degree":"...","institution":"...","period":"..."}], "skills":["...","..."]}`;
    const { text: raw } = await callClaude({ system, content: finalPrompt, maxTokens: 3000 });
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
