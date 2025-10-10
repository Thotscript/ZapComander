async function processImage(sessionName, message, email) {
  try {
    const session = SESSIONS.get(sessionName);
    if (!session) throw new Error(`Sessão ${sessionName} não encontrada.`);
    const { client, myNumber } = session;
    if (!myNumber) return;
    if (message.from === myNumber) return;
    if (message.to !== MAIN_BOT_NUMBER) return;

    const sender   = message.from;
    const convoKey = `${session.myNumber}:${sender}`;

    // Garante que é imagem
    const isImage =
      message.type === 'image' ||
      (message.mimetype && message.mimetype.startsWith('image/'));

    if (!isImage) {
      console.log(`[processImage] Mensagem não é imagem. type=${message.type}, mimetype=${message.mimetype}`);
      return;
    }

    console.log(`🖼️ [processImage] Recebendo imagem de ${sender} (${message.mimetype || message.type})`);

    // 1) Decodifica a imagem
    const imageBuffer = await client.decryptFile(message);
    const base64Image = imageBuffer.toString('base64');
    const mime = message.mimetype || 'image/jpeg';

    // 2) Prompt de análise de imagem (em PT-BR, conforme pedido)
    const IMAGE_ANALYSIS_PROMPT = `Você é um modelo especializado em análise e descrição de imagens.

Sempre que receber uma imagem, analise-a minuciosamente e produza uma descrição completa, estruturada e precisa do conteúdo visual.

Sua resposta deve conter:

Descrição geral: o que a imagem representa (ex: uma paisagem, uma pessoa, uma interface, um documento, um gráfico, etc.).

Elementos visuais: identifique pessoas, objetos, textos, cores predominantes, ambiente e composição (ex: iluminação, perspectiva, enquadramento).

Contexto e intenção provável: o propósito possível da imagem (ex: foto de produto, cena turística, captura de tela de sistema, diagrama técnico, etc.).

Detalhes textuais (OCR leve): se houver texto visível, transcreva-o e descreva sua posição e formato (ex: títulos, legendas, botões).

Análise técnica (se aplicável): tipo de arquivo ou estilo visual (ex: foto, ilustração digital, screenshot, render 3D, pintura, etc.).

Tom e atmosfera: sensações que a imagem transmite (ex: profissional, relaxante, caótico, tecnológico, artístico, publicitário).

⚙️ Regras de comportamento:

Nunca invente informações não visíveis.
Seja objetivo e observador, mas descreva com profundidade.
Use frases completas, sem bullet points a menos que solicitado.
Se a imagem estiver ilegível ou parcial, diga claramente o que é visível e o que não é possível identificar.
Nunca emita julgamentos pessoais ou interpretações emocionais sem base visual.

✅ Exemplo de saída esperada:
“A imagem mostra uma sala de estar moderna, com um sofá cinza em primeiro plano e uma mesa de centro de vidro. Ao fundo há uma TV montada na parede e uma estante com livros. A iluminação é natural, vinda de uma janela à esquerda. O estilo geral é minimalista e contemporâneo, possivelmente de um catálogo de imóveis.”`;

    // 3) Chama o GPT (visão) para descrever a imagem
    console.log(`🖼️ [processImage] Chamando OpenAI (gpt-4.1 visão) para descrição...`);
    const gptResponse = await axios.post('https://api.openai.com/v1/responses', {
      model: 'gpt-4.1',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text',  text: IMAGE_ANALYSIS_PROMPT },
            { type: 'input_image', image_url: `data:${mime};base64,${base64Image}` }
          ]
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });

    // 4) Extrai texto da resposta
    let description;
    if (gptResponse.data?.output?.length > 0) {
      const outputContent = gptResponse.data.output[0]?.content || [];
      description = outputContent.find(item => item.type === 'output_text')?.text;
    }
    if (!description) {
      // fallback p/ formato compatível com chat-completions
      description = gptResponse.data?.choices?.[0]?.message?.content;
    }
    if (!description) {
      throw new Error('Resposta vazia da OpenAI ao analisar a imagem.');
    }

    console.log(`🖼️ [processImage] Descrição gerada (preview): ${description.substring(0, 160)}...`);

    // (Opcional) envia a descrição para o usuário
    try {
      await client.sendText(sender, description);
    } catch (sendErr) {
      console.error('⚠️ [processImage] Falha ao enviar descrição para o usuário:', sendErr);
    }

    // 5) Usa o seu roteador para detectar gatilho a partir da descrição
    const rawTrigger = (await checkTriggerInText(description)).trim();
    console.log(`[processImage] checkTriggerInText => "${rawTrigger}"`);

    // 6) Normaliza mesma lógica do processText
    let cleaned = rawTrigger
      .replace(/```/g, '')
      .replace(/`/g, '')
      .replace(/(^["']|["']$)/g, '')
      .trim();

    let norm = cleaned
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');

    const synonyms = { tbvmortage: 'tbvmortgage' };
    if (synonyms[norm]) {
      console.log(`[processImage] applying synonym: ${norm} → ${synonyms[norm]}`);
      norm = synonyms[norm];
    }

    // 7) Fallback "nenhumbotativado"
    if (norm.startsWith('nenhumbotativado')) {
      // encaminha o texto retornado (ex: menu padrão)
      try {
        await client.sendText(sender, cleaned);
      } catch (sendErr) {
        console.error('⚠️ [processImage] Falha ao enviar fallback ao usuário:', sendErr);
      }
      return;
    }

    // 8) Dispara triggers válidos (mesmo mapa do processText)
    const valid = {
      tbvevents:          'tbvevents',
      tbvmortgage:        'tbvmortgage',
      tbvrentabilidade:   'tbvrentabilidade',
      tbvprequalificacao: 'tbvprequalificacao',
      tbvconstruction:    'tbvconstruction',
      tbvconstrucao:      'tbvconstruction',
      tbvvalidation:      'tbvvalidation',
      tbvbusinesscard:    'tbvbusinesscard',
      tbvesperardolar:    'tbvesperardolar',
      tbvesperarjuros:    'tbvesperarjuros',
    };

    if (valid[norm]) {
      const trigKey = valid[norm];
      console.log(`[processImage] dispatching trigger: ${trigKey}`);

      CONVERSATIONS.set(convoKey, { history: [], activeTrigger: trigKey });
      setConversationTimeout(convoKey, session, sender);

      return TRIGGERS[trigKey](session, message, description, sessionName, email);
    }

    // 9) Caso não reconheça nenhum trigger
    console.log(`[processImage] unrecognized trigger from image: '${norm}'`);
    // opcional: avisa o usuário que não houve roteamento
    try {
      await client.sendText(sender, 'ℹ️ Análise concluída, mas não identifiquei um contexto específico para continuar. Se quiser, me diga o que deseja fazer.');
    } catch (sendErr) {
      console.error('⚠️ [processImage] Falha ao enviar aviso de contexto não reconhecido:', sendErr);
    }
  } catch (err) {
    console.error(`❌ Erro em processImage: ${err.message}`, err.stack);
    // fallback amistoso pro usuário
    try {
      const session = SESSIONS.get(sessionName);
      if (session?.client && message?.from) {
        await session.client.sendText(message.from, '❌ Não consegui analisar esta imagem agora. Pode tentar novamente com outra foto?');
      }
    } catch (sendErr) {
      console.error('⚠️ [processImage] Falha ao enviar fallback de erro ao usuário:', sendErr);
    }
  }
}
