const TRIGGER_KEYWORDS = ['casas', 'orlando', 'aluguel'];
const CONVERSATIONS = new Map();

async function processText(sessionName, message) {
    try {
      if (!SESSIONS.has(sessionName)) {
        throw new Error(`Sessão ${sessionName} não encontrada.`);
      }
      const session = SESSIONS.get(sessionName);
      const client = session.client;
      const myNumber = session.myNumber;
      if (!myNumber) {
        console.error(`⚠️ Número da sessão ${sessionName} ainda não definido.`);
        return;
      }
  
      const text = message.body?.trim();
      if (!text) return;
  
      const lower = text.toLowerCase();
      const shouldTrigger = TRIGGER_KEYWORDS.some(kw => lower.includes(kw));
      if (!shouldTrigger && !CONVERSATIONS.has(sessionName)) {
        // só processa se já estivermos no modo conversa
        return;
      }
  
      // Se disparou o trigger pela primeira vez, inicializa o histórico
      if (shouldTrigger && !CONVERSATIONS.has(sessionName)) {
        CONVERSATIONS.set(sessionName, [
          {
            role: 'system',
            content: `
  - Você é um agente de IA da imobiliaria The Florida Lounge, vendemos casas de férias e moradia, e ajudamos a investir em imóveis em Orlando.
  - Você deve sempre analisar o contexto para responder de acordo!
  - Tente entender a necessidade de compra do cliente, entenda se ele deseja um investimento, uma moradia ou somente alugar para passar as férias
  - Entenda o potencial de compra do cliente, clientes com valores acima de 400mil dólares são premium.
  - Seja cordial e gentil, mas interaja de acordo com o tipo de expressão utilizada pelo cliente, para gerar empatia.
  - Sempre pergunte o nome do cliente e passe a chamá‑lo pelo nome durante o atendimento.
  - Caso seja do interesse do cliente, podemos agendar uma conversa com um corretor, bastando perguntar o horário e datas desejadas
  - Temos escritórios em São Paulo no Alphaville e no Rio de Janeiro em Copacabana
            `.trim()
          }
        ]);
      }
  
      const contact = await client.getContact(message.from);
      const senderName = contact.name || contact.pushname || message.from;
      console.log(`📝 [${sessionName}] ${senderName}: ${text}`);
  
      // Empilha a mensagem do usuário
      const history = CONVERSATIONS.get(sessionName);
      history.push({ role: 'user', content: text });
      // Limita tamanho
      if (history.length > 13) history.splice(1, history.length - 13);
  
      // Chama OpenAI com o histórico completo
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: history
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
  
      const resumo = response.data.choices[0].message.content;
  
      // Empilha resposta do assistente
      history.push({ role: 'assistant', content: resumo });
  
      // Envia ao cliente
      await client.sendText(
        myNumber,
        `*WppTalk Assistant — ${senderName}:*\n\n${resumo}`,
        { quotedMsg: message.id }
      );
      console.log(`✅ Resposta enviada a ${senderName}.`);
  
    } catch (error) {
      console.error('❌ Erro ao processar texto:', error?.response?.data || error.message);
    }
  }



  if (message.type === 'chat') {
    console.log(`Mensagem de texto, ativando BOT para -> ${sessionName}. Processando...`);
    await processText(sessionName, message);
}