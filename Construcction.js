async function handleTriggerTBVConstruction(session, message, userInput, sessionName, email) {
  const client = session.client;
  const sender = message.from;
  const convoKey = `${session.myNumber}:${sender}`;

  // Obtemos (ou iniciamos) a sessão de conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvconstruction'
  };

  // Carrega o prompt "TBVConstruction" com as Instruções Revisadas
  const prompt = loadPrompt('TBVConstruction');

  // Na primeira vez, injetamos o sistema
  if (convo.history.length === 0) {
    convo.history.push({ role: 'system', content: prompt });
    // ✅ NOVO: Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // ✅ NOVO: Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }

  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });

  // Chama o GPT
  const gptResponse = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: convo.history,
    temperature: 0.2
  });

  let assistantResponse = gptResponse.choices[0].message.content.trim();
  convo.history.push({ role: 'assistant', content: assistantResponse });

  // Envia a resposta intermediária ao usuário
  await client.sendText(sender, assistantResponse);

  // Se o GPT já incluiu a pergunta de fechamento, apenas salvamos o estado e aguardamos resposta
  const esperaMaisInfo = /deseja.*(mais).*informação\?/i.test(assistantResponse);
  if (esperaMaisInfo) {
    CONVERSATIONS.set(convoKey, convo);
    return;
  }

  // Se o usuário respondeu "não" depois da pergunta de fechamento, encerramos
  if (/^(não|nao)\b/i.test(userInput) && convo.activeTrigger === 'tbvconstruction') {
    await client.sendText(sender, '👍 Entendido! Encerrando este atendimento. Se precisar, é só chamar outro serviço.');
    // ✅ NOVO: Limpar timeout quando conversa termina
    clearConversationTimeout(convoKey);
    CONVERSATIONS.delete(convoKey);
    return;
  }

  // Senão, continuamos o fluxo normalmente
  CONVERSATIONS.set(convoKey, convo);
}