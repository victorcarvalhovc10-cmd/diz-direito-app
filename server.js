require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10mb pra caber fotos anexadas
app.use(express.static('public'));

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
async function callClaude({ system, content, maxTokens = 1400 }) {
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
      messages: [{ role: 'user', content }]
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const block = (data.content || []).find(b => b.type === 'text');
  return block ? block.text.trim() : '';
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

app.post('/api/questions', async (req, res) => {
  const quota = checkAndConsumeQuota(req.deviceId);
  if (!quota.allowed) {
    return res.status(429).json({ error: 'limite_gratuito_atingido', message: 'Você usou seus prompts gratuitos de hoje. Volte amanhã ou assine o plano completo.' });
  }
  try {
    const { projectInput } = req.body;
    const system = `Você decompõe pedidos de criação em perguntas interativas para montar o prompt de IA perfeito depois. Dado o pedido do usuário, gere SEMPRE NO MÍNIMO 3 e no máximo 4 perguntas ESPECÍFICAS para esse tipo de projeto (não genéricas — se for uma foto, pergunte sobre estética/composição/luz; se for um texto de venda, pergunte sobre público/tom/gatilho; adapte sempre ao pedido). Nunca gere menos de 3 perguntas: se o pedido for muito simples e você não encontrar 3 perguntas específicas o suficiente, complete com perguntas relevantes mas um pouco mais gerais (ex: tom desejado, formato de saída, nível de detalhe) até atingir o mínimo de 3. Para cada pergunta, gere de 4 a 6 opções curtas (2-4 palavras), específicas ao contexto, cada uma com um emoji representativo.
Além disso, avalie se esse tipo de projeto normalmente exige que o usuário anexe algum arquivo de referência (uma foto para editar/estilizar, um documento para basear um texto, uma imagem de produto, um logo, etc). Se exigir, marque "requires_attachment": true e escreva um "attachment_label" curto pedindo o anexo certo. Se não fizer sentido pedir anexo, marque "requires_attachment": false.
Responda APENAS com JSON válido neste formato exato, sem markdown, sem texto fora do JSON:
{"project_type": "nome curto do tipo de projeto", "requires_attachment": true, "attachment_label": "frase curta pedindo o anexo", "questions": [{"id": "slug_curto", "label": "pergunta", "options": [{"label": "opção", "icon": "emoji"}]}]}`;

    const raw = await callClaude({ system, content: projectInput });
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
    const { projectInput, questions, answers, attachmentBase64, attachmentMime } = req.body;
    const hasImage = !!attachmentBase64;
    const qaLines = (questions || []).map(q => `${q.label}: ${answers[q.id]}`).join('\n');

    const system = `Você é um motor de engenharia de prompts. O usuário descreveu um projeto e já respondeu perguntas de refinamento${hasImage ? ', e anexou uma foto de referência que você está vendo' : ''}. Monte o prompt final otimizado em português, pronto para colar em qualquer IA generativa, incorporando TODAS as respostas dadas.
Aplique boas práticas: contexto claro, persona quando fizer sentido, formato de saída definido, restrições relevantes.
${hasImage ? 'Como há uma foto anexada: descreva no prompt, com detalhe real e específico, o que está na foto (composição, iluminação, ângulo, cores, ambiente) e como isso deve ser preservado ou transformado. Inclua instruções explícitas contra artefatos comuns de geração de imagem (pele plástica, mãos deformadas, fundo genérico, watermarks) e peça texturas reais e iluminação coerente.' : ''}
Se restar alguma informação que só o usuário sabe, inclua como campo entre colchetes, ex: [Nome da marca].
Responda APENAS com o prompt final, texto puro, sem explicações, sem markdown, sem aspas ao redor.`;

    const textContent = `Pedido original: ${projectInput}\n\nRespostas:\n${qaLines}`;
    const content = hasImage
      ? [
          { type: 'image', source: { type: 'base64', media_type: attachmentMime || 'image/jpeg', data: attachmentBase64 } },
          { type: 'text', text: textContent }
        ]
      : textContent;

    const finalPrompt = await callClaude({ system, content });
    res.json({ finalPrompt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'erro_interno', message: 'Não consegui gerar o prompt final. Tenta de novo.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Diz Direito backend rodando em http://localhost:${PORT}`);
  console.log(`Limite gratuito: ${FREE_LIMIT_PER_DAY} prompts por dia por dispositivo`);
});
