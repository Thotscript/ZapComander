async function handleTriggerEsperarDolar(session, message, userInput, sessionName, email) {
  const client   = session.client;
  const sender   = message.from;
  const convoKey = `${session.myNumber}:${sender}`;
  
  // Inicia ou recupera o estado da conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvesperardolar'
  };
  
  // Se for a primeira interação, injeta o system prompt
  if (convo.history.length === 0) {
    // Carrega o prompt "EsperarDolar"
    const prompt = loadPrompt('tbvdolar');
    
    // MODIFICADO: Removido instruções sobre incluir o link do PDF
    const fullSystemPrompt = `${prompt}

Você tem acesso a duas funções principais:

1. buscarCambioBCB(data) - busca a cotação do dólar no Banco Central. 
   - Se data for null, busca a cotação mais recente
   - Retorna objeto com: sucesso, data, cotacaoVenda, cotacaoCompra, tipoBoletim
   - A API do BCB pode não ter dados em fins de semana/feriados

2. calcularCustoEsperar(inputs) - calcula se vale a pena esperar o câmbio cair
   - Parâmetros obrigatórios: V0, m, FX0, FXbuy
   - Parâmetros opcionais: r, g, y, dp

Quando o usuário não souber o câmbio atual, use buscarCambioBCB() para obter a cotação oficial.
Quando tiver todos os dados necessários, use calcularCustoEsperar.

IMPORTANTE: Apresente os resultados de forma clara e profissional, mas NÃO mencione nada sobre PDF ou relatório completo. Apenas forneça a análise detalhada dos números.`;
    
    // Adiciona apenas UMA mensagem system
    convo.history.push({ role: 'system', content: fullSystemPrompt });
    
    // Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }
  
  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });
  
  // Chama o GPT com capacidade de function calling
  const gptResponse = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: convo.history,
    temperature: 0.2,
    functions: [
      {
        name: "buscarCambioBCB",
        description: "Busca a cotação atual do dólar no Banco Central do Brasil",
        parameters: {
          type: "object",
          properties: {
            data: { 
              type: "string", 
              description: "Data para buscar cotação (formato YYYY-MM-DD). Se null, busca a mais recente.",
              nullable: true
            }
          }
        }
      },
      {
        name: "calcularCustoEsperar",
        description: "Calcula se vale a pena esperar o câmbio cair para comprar um imóvel",
        parameters: {
          type: "object",
          properties: {
            V0: { type: "number", description: "Valor do imóvel em USD" },
            m: { type: "number", description: "Meses de espera" },
            FX0: { type: "number", description: "Câmbio atual R$/USD" },
            FXbuy: { type: "number", description: "Câmbio futuro esperado R$/USD" },
            r: { type: "number", description: "Taxa de aplicação anual (opcional)" },
            g: { type: "number", description: "Valorização anual do imóvel (opcional)" },
            y: { type: "number", description: "Yield anual do imóvel (opcional)" },
            dp: { type: "number", description: "Percentual de downpayment (opcional)" }
          },
          required: ["V0", "m", "FX0", "FXbuy"]
        }
      }
    ],
    function_call: "auto"
  });
  
  const responseMessage = gptResponse.choices[0].message;
  
  // Se o GPT chamou uma função
  if (responseMessage.function_call) {
    const functionName = responseMessage.function_call.name;
    const functionArgs = JSON.parse(responseMessage.function_call.arguments);
    
    if (functionName === "buscarCambioBCB") {
      try {
        // Busca a cotação do dólar usando a função existente
        const cotacao = await buscarCambioBCB(functionArgs.data);
        
        // Adiciona o resultado à conversa
        convo.history.push({
          role: 'function',
          name: 'buscarCambioBCB',
          content: JSON.stringify(cotacao)
        });
        
        // Continua a conversa com o resultado da cotação
        const continuationResponse = await openai.chat.completions.create({
          model: ASSISTANT_MODEL,
          messages: convo.history,
          temperature: 0.2,
          functions: [
            {
              name: "calcularCustoEsperar",
              description: "Calcula se vale a pena esperar o câmbio cair para comprar um imóvel",
              parameters: {
                type: "object",
                properties: {
                  V0: { type: "number", description: "Valor do imóvel em USD" },
                  m: { type: "number", description: "Meses de espera" },
                  FX0: { type: "number", description: "Câmbio atual R$/USD" },
                  FXbuy: { type: "number", description: "Câmbio futuro esperado R$/USD" },
                  r: { type: "number", description: "Taxa de aplicação anual (opcional)" },
                  g: { type: "number", description: "Valorização anual do imóvel (opcional)" },
                  y: { type: "number", description: "Yield anual do imóvel (opcional)" },
                  dp: { type: "number", description: "Percentual de downpayment (opcional)" }
                },
                required: ["V0", "m", "FX0", "FXbuy"]
              }
            }
          ],
          function_call: "auto"
        });
        
        // Processa a resposta recursivamente
        responseMessage.content = continuationResponse.choices[0].message.content;
        responseMessage.function_call = continuationResponse.choices[0].message.function_call;
        
      } catch (error) {
        console.error('Erro ao buscar cotação BCB:', error);
        
        // Se falhar, informa o usuário
        convo.history.push({
          role: 'function',
          name: 'buscarCambioBCB',
          content: JSON.stringify({
            sucesso: false,
            erro: 'Não foi possível buscar a cotação do BCB. Por favor, informe o câmbio atual manualmente.'
          })
        });
        
        // Continua a conversa
        const errorResponse = await openai.chat.completions.create({
          model: ASSISTANT_MODEL,
          messages: convo.history,
          temperature: 0.2
        });
        
        const assistantResponse = errorResponse.choices[0].message.content.trim();
        convo.history.push({ role: 'assistant', content: assistantResponse });
        
        await client.sendText(sender, assistantResponse);
        CONVERSATIONS.set(convoKey, convo);
        return;
      }
    }
    
    if (functionName === "calcularCustoEsperar" || responseMessage.function_call?.name === "calcularCustoEsperar") {
      // Se for a função de cálculo
      const args = functionName === "calcularCustoEsperar" ? functionArgs : JSON.parse(responseMessage.function_call.arguments);
      
      let pdfInfo = null;
      
      try {
        // Executa a função de cálculo
        const resultado = calcularCustoEsperar(args);
        
        // Gera o PDF com os resultados
        pdfInfo = await gerarPDFCambio(resultado, args);
        
        // MODIFICADO: Não incluímos mais o PDF no resultado enviado ao GPT
        convo.history.push({
          role: 'function',
          name: 'calcularCustoEsperar',
          content: JSON.stringify(resultado)
        });
        
        // Pede ao GPT para formatar a resposta baseada no resultado
        // MODIFICADO: Adiciona instrução explícita para apenas formatar o JSON
        convo.history.push({
          role: 'system',
          content: `INSTRUÇÃO CRÍTICA: 
          
Você recebeu um JSON com os resultados já calculados. Sua ÚNICA tarefa é apresentar esses valores de forma organizada e clara.

REGRAS OBRIGATÓRIAS:
1. NÃO faça NENHUM cálculo próprio
2. NÃO modifique NENHUM valor recebido
3. NÃO calcule percentuais, diferenças ou qualquer operação matemática
4. NÃO interprete ou valide os números
5. Use APENAS os valores exatos do JSON recebido
6. NÃO mencione PDF ou relatório

Formato EXATO para apresentação:

📊 **ANÁLISE DO CUSTO DE ESPERAR O CÂMBIO**

**Cenário Analisado:**
• Imóvel de US$ [use o valor de parametros.valor_imovel_USD]
• Espera de [use parametros.meses_espera] meses
• Câmbio: R$ [use parametros.cambio_atual] → R$ [use parametros.cambio_futuro]

**RESULTADO: [Se resultado.BRL > 0 escreva "Ganho", senão "Perda"] de R$ [use resultado.BRL] (US$ [use resultado.USD])**

✅ **GANHOS AO ESPERAR:**
• Rendimento no Brasil: R$ [use ganhos.aplicacao.rendimento_BRL]
• Economia no câmbio: R$ [use ganhos.cambio.ganho_BRL]
• Total de ganhos: R$ [use ganhos.total]

❌ **PERDAS POR ESPERAR:**
• Valorização perdida: R$ [use perdas.valorizacao.BRL] (US$ [use perdas.valorizacao.USD])
• Aluguel não recebido: R$ [use perdas.yield.BRL] (US$ [use perdas.yield.USD])
• Total de perdas: R$ [use perdas.total]

💡 **CONCLUSÃO:**
[Se resultado.BRL < 0]: Esperar resultaria em uma perda líquida. O custo de oportunidade supera a economia no câmbio.
[Se resultado.BRL > 0]: Esperar resultaria em um ganho líquido. A economia no câmbio compensa o custo de oportunidade.

Lembre-se: use APENAS os valores do JSON, sem fazer nenhum cálculo ou modificação.`
        });
        
        const formattedResponse = await openai.chat.completions.create({
          model: ASSISTANT_MODEL,
          messages: convo.history,
          temperature: 0.1  // Temperatura baixa para menor variação
        });
        
        const assistantResponse = formattedResponse.choices[0].message.content.trim();
        convo.history.push({ role: 'assistant', content: assistantResponse });
        
        // Se o GPT devolveu o token de encerramento
        if (assistantResponse === 'finalizando-atendimento') {
          await client.sendText(
            sender,
            '👍 Até mais! Quando quiser fazer uma nova análise, é só digitar o gatilho novamente.'
          );
          clearConversationTimeout(convoKey);
          CONVERSATIONS.delete(convoKey);
          return;
        }
        
        // Envia a resposta do GPT
        await client.sendText(sender, assistantResponse);
        
        // NOVO: Envia o link do PDF manualmente após a resposta do GPT
        if (pdfInfo && pdfInfo.url) {
          const pdfMessage = `💹 **RELATÓRIO COMPLETO EM PDF**

Preparei um relatório visual detalhado com gráficos comparativos da análise de câmbio.

🔗 **Acesse aqui:** ${pdfInfo.url}

⏰ *Link válido até ${new Date(pdfInfo.validade).toLocaleTimeString('pt-BR')} (5 minutos)*

💡 Dica: Salve o PDF para consultas futuras sobre sua decisão de investimento!`;
          
          // Aguarda um pequeno delay para melhor UX
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          // Envia a mensagem com o link do PDF
          await client.sendText(sender, pdfMessage);
        }
        
      } catch (error) {
        console.error('Erro ao processar cálculo ou gerar PDF:', error);
        
        // Se houve erro na geração do PDF, ainda envia a resposta do GPT
        if (!pdfInfo) {
          await client.sendText(
            sender,
            '⚠️ Não consegui gerar o PDF com o relatório visual, mas a análise acima está completa com todos os dados necessários para sua decisão.'
          );
        }
      }
    }
  } else {
    // Resposta normal sem chamar função
    const assistantResponse = responseMessage.content.trim();
    convo.history.push({ role: 'assistant', content: assistantResponse });
    
    // Se o GPT devolveu o token de encerramento
    if (assistantResponse === 'finalizando-atendimento') {
      await client.sendText(
        sender,
        '👍 Até mais! Quando quiser fazer uma nova análise, é só digitar o gatilho novamente.'
      );
      clearConversationTimeout(convoKey);
      CONVERSATIONS.delete(convoKey);
      return;
    }
    
    await client.sendText(sender, assistantResponse);
  }
  
  // Salva o estado da conversa
  CONVERSATIONS.set(convoKey, convo);
}

// Função para gerar o PDF de câmbio (mantida sem alterações)
async function gerarPDFCambio(resultado, inputs) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // HTML com design profissional
    const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', Arial, sans-serif;
            background-color: #1a1a1a;
            color: #ffffff;
            line-height: 1.6;
        }
        
        .page {
            max-width: 1200px;
            margin: 0 auto;
            background-color: #ffffff;
            min-height: 100vh;
        }
        
        /* Header */
        .header {
            background-color: #000000;
            color: #ffffff;
            padding: 30px 40px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .header h1 {
            font-size: 32px;
            font-weight: 700;
            letter-spacing: -1px;
        }
        
        .logo {
            font-size: 18px;
            font-weight: 600;
            text-align: right;
        }
        
        /* Subtitle Bar */
        .subtitle-bar {
            background-color: #e91e63;
            color: #ffffff;
            padding: 10px 40px;
            font-size: 14px;
            font-weight: 600;
        }
        
        /* Exchange Rate Display */
        .cambio-section {
            background-color: #000;
            color: #fff;
            padding: 30px 40px;
            text-align: center;
        }
        
        .cambio-grid {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            gap: 30px;
            max-width: 800px;
            margin: 0 auto;
        }
        
        .cambio-card {
            background-color: #1a1a1a;
            padding: 20px;
            border-radius: 8px;
            border: 2px solid #333;
        }
        
        .cambio-label {
            font-size: 12px;
            color: #ccc;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        
        .cambio-value {
            font-size: 36px;
            font-weight: 700;
            color: #e91e63;
        }
        
        .cambio-arrow {
            font-size: 48px;
            color: #e91e63;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        /* Main Content */
        .main-content {
            display: grid;
            grid-template-columns: 1fr 2fr;
            gap: 30px;
            padding: 30px 40px;
            background-color: #f5f5f5;
        }
        
        /* Left Section */
        .left-section {
            background-color: #ffffff;
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .section-title {
            background-color: #e91e63;
            color: #ffffff;
            padding: 10px 15px;
            margin: -25px -25px 20px -25px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 8px 8px 0 0;
        }
        
        .data-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }
        
        .data-row:last-child {
            border-bottom: none;
        }
        
        .data-label {
            font-size: 13px;
            color: #666;
        }
        
        .data-value {
            font-size: 14px;
            font-weight: 600;
            color: #333;
        }
        
        .total-row {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 2px solid #e91e63;
        }
        
        .total-row .data-label {
            font-weight: 700;
            color: #333;
        }
        
        .total-row .data-value {
            font-size: 16px;
            color: #e91e63;
        }
        
        /* Right Section - Metrics */
        .right-section {
            background-color: #000000;
            padding: 30px;
            border-radius: 8px;
            color: #ffffff;
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 25px;
            margin-bottom: 30px;
        }
        
        .metric-circle {
            text-align: center;
        }
        
        .circle-container {
            width: 120px;
            height: 120px;
            margin: 0 auto 10px;
            position: relative;
        }
        
        .circle-bg {
            width: 100%;
            height: 100%;
            border-radius: 50%;
            border: 8px solid #333;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
        }
        
        .circle-positive {
            border-color: #4caf50;
        }
        
        .circle-negative {
            border-color: #e91e63;
        }
        
        .circle-value {
            font-size: 20px;
            font-weight: 700;
        }
        
        .circle-label {
            font-size: 11px;
            color: #ccc;
            margin-top: 5px;
        }
        
        .metric-title {
            font-size: 14px;
            color: #ccc;
            font-weight: 600;
        }
        
        /* Result Section */
        .result-section {
            background-color: #ffffff;
            margin: 0 40px 30px;
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
        }
        
        .result-positive {
            border: 3px solid #4caf50;
        }
        
        .result-negative {
            border: 3px solid #e91e63;
        }
        
        .result-title {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #333;
        }
        
        .result-value {
            font-size: 36px;
            font-weight: 700;
            margin-bottom: 5px;
        }
        
        .result-value-usd {
            font-size: 24px;
            font-weight: 600;
            color: #666;
            margin-bottom: 15px;
        }
        
        .result-positive .result-value {
            color: #4caf50;
        }
        
        .result-negative .result-value {
            color: #e91e63;
        }
        
        .result-description {
            font-size: 14px;
            color: #666;
            line-height: 1.6;
        }
        
        /* Footer */
        .footer {
            background-color: #000;
            color: #ffffff;
            padding: 30px 40px;
            text-align: center;
        }
        
        .footer-brand {
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 10px;
        }
        
        .footer-info {
            font-size: 12px;
            color: #ccc;
        }
    </style>
</head>
<body>
    <div class="page">
        <!-- Header -->
        <div class="header">
            <h1>ANÁLISE ESPERAR O CÂMBIO CAIR</h1>
            <div class="logo">THE FLORIDA<br>LOUNGE</div>
        </div>
        
        <!-- Subtitle -->
        <div class="subtitle-bar">
            IMÓVEL: ${formatCurrencyUSD(inputs.V0)} | ESPERA: ${inputs.m} MESES | CÂMBIO: R$ ${inputs.FX0.toFixed(2)} → R$ ${inputs.FXbuy.toFixed(2)}
        </div>
        
        <!-- Exchange Rate Display -->
        <div class="cambio-section">
            <div class="cambio-grid">
                <div class="cambio-card">
                    <div class="cambio-label">Câmbio Atual</div>
                    <div class="cambio-value">R$ ${inputs.FX0.toFixed(2).replace('.', ',')}</div>
                </div>
                <div class="cambio-arrow">→</div>
                <div class="cambio-card">
                    <div class="cambio-label">Câmbio Esperado</div>
                    <div class="cambio-value">R$ ${inputs.FXbuy.toFixed(2).replace('.', ',')}</div>
                </div>
            </div>
        </div>
        
        <!-- Main Content -->
        <div class="main-content">
            <!-- Left Section - Details -->
            <div class="left-section">
                <h3 class="section-title">PARÂMETROS DA ANÁLISE</h3>
                <div class="data-row">
                    <span class="data-label">VALOR IMÓVEL</span>
                    <span class="data-value">${formatCurrencyUSD(inputs.V0)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">DOWNPAYMENT (${(inputs.dp*100).toFixed(0)}%)</span>
                    <span class="data-value">${formatCurrencyUSD(inputs.V0 * inputs.dp)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">PERÍODO DE ESPERA</span>
                    <span class="data-value">${inputs.m} meses</span>
                </div>
                <div class="data-row">
                    <span class="data-label">QUEDA ESPERADA</span>
                    <span class="data-value">${((inputs.FX0 - inputs.FXbuy) / inputs.FX0 * 100).toFixed(1)}%</span>
                </div>
                <div class="data-row">
                    <span class="data-label">APLICAÇÃO NO BRASIL</span>
                    <span class="data-value">${(inputs.r*100).toFixed(1)}% a.a.</span>
                </div>
                <div class="data-row">
                    <span class="data-label">VALORIZAÇÃO IMÓVEL</span>
                    <span class="data-value">${(inputs.g*100).toFixed(1)}% a.a.</span>
                </div>
                <div class="data-row">
                    <span class="data-label">YIELD/ALUGUEL</span>
                    <span class="data-value">${(inputs.y*100).toFixed(1)}% a.a.</span>
                </div>
            </div>
            
            <!-- Right Section - Metrics -->
            <div class="right-section">
                <div class="metrics-grid">
                    <!-- Ganhos -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-positive">
                                <div class="circle-value">${formatCurrencyBRL(resultado.ganhos.total)}</div>
                                <div class="circle-label">Ganhos</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL GANHOS</div>
                    </div>
                    
                    <!-- Perdas -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-negative">
                                <div class="circle-value">${formatCurrencyBRL(resultado.perdas.total)}</div>
                                <div class="circle-label">Perdas</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL PERDAS</div>
                    </div>
                </div>
                
                <!-- Capital Details -->
                <div style="text-align: center; margin-top: 30px; padding-top: 30px; border-top: 1px solid #333;">
                    <div style="font-size: 24px; font-weight: 700; color: #e91e63; margin-bottom: 10px;">
                        ${formatCurrencyBRL(resultado.ganhos.aplicacao.base_BRL)}
                    </div>
                    <div style="font-size: 14px; color: #ccc;">CAPITAL APLICADO</div>
                </div>
            </div>
        </div>
        
        <!-- Result Section -->
        <div class="result-section ${resultado.resultado.BRL > 0 ? 'result-positive' : 'result-negative'}">
            <h2 class="result-title">${resultado.resultado.BRL > 0 ? 'VALE A PENA ESPERAR' : 'MELHOR COMPRAR AGORA'}</h2>
            <div class="result-value">${formatCurrencyBRL(Math.abs(resultado.resultado.BRL))}</div>
            <div class="result-value-usd">${formatCurrencyUSD(Math.abs(resultado.resultado.USD))}</div>
            <p class="result-description">
                ${resultado.resultado.BRL > 0 
                    ? `Esperar ${inputs.m} meses resultaria em ganho de ${formatCurrencyBRL(Math.abs(resultado.resultado.BRL))}. A economia no câmbio e os rendimentos compensam a valorização do imóvel.`
                    : `Comprar agora evitaria perda de ${formatCurrencyBRL(Math.abs(resultado.resultado.BRL))}. A valorização do imóvel e os aluguéis perdidos superam a economia esperada no câmbio.`}
            </p>
        </div>
        
        <!-- Detailed Breakdown -->
        <div class="main-content">
            <div class="left-section">
                <h3 class="section-title">GANHOS AO ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">RENDIMENTO DA APLICAÇÃO</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.ganhos.aplicacao.rendimento_BRL)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">ECONOMIA NO CÂMBIO</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.ganhos.cambio.ganho_BRL)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL GANHOS</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.ganhos.total)}</span>
                </div>
            </div>
            
            <div class="left-section">
                <h3 class="section-title">PERDAS POR ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">VALORIZAÇÃO IMÓVEL (${formatCurrencyUSD(resultado.perdas.valorizacao.USD)})</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.perdas.valorizacao.BRL)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">YIELD PERDIDO (${formatCurrencyUSD(resultado.perdas.yield.USD)})</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.perdas.yield.BRL)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL PERDAS</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.perdas.total)}</span>
                </div>
            </div>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <div class="footer-brand">THE FLORIDA LOUNGE</div>
            <div class="footer-info">
                @thefloridalounge | Relatório gerado em ${new Date().toLocaleString('pt-BR')}<br>
                Este relatório é uma simulação educativa e deve ser validada com um especialista.
            </div>
        </div>
    </div>
</body>
</html>
    `;
    
    await page.setContent(html);
    
    // Usa a variável PDF_DIR ao invés do caminho hardcoded
    const timestamp = Date.now();
    const randomHash = crypto.randomBytes(4).toString('hex');
    const nomeArquivo = `analise_cambio_${timestamp}_${randomHash}.pdf`;
    const caminhoCompleto = path.join(PDF_DIR, nomeArquivo);
    
    // Gerar o PDF
    await page.pdf({
      path: caminhoCompleto,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      }
    });
    
    await browser.close();
    
    console.log(`💹 [CAMBIO-PDF] Arquivo PDF criado: ${nomeArquivo} em ${PDF_DIR}`);
    
    // Agendar exclusão do arquivo após 5 minutos
    setTimeout(async () => {
      try {
        await fs.unlink(caminhoCompleto);
        console.log(`💹 [CAMBIO-PDF] PDF ${nomeArquivo} removido após 5 minutos`);
      } catch (error) {
        console.error(`❌ [CAMBIO-PDF] Erro ao remover PDF ${nomeArquivo}:`, error);
      }
    }, 5 * 60 * 1000); // 5 minutos
    
    // URL mantém o formato esperado com subdomínio pdf
    return {
      url: `https://pdf.thebroker.vip:8443/pdf/${nomeArquivo}`,
      validade: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Funções auxiliares para formatar moeda
function formatCurrencyBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

function formatCurrencyUSD(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

// Função de cálculo (incluída aqui para referência, mas pode estar em outro arquivo)
function calcularCustoEsperar(inputs) {
    // Validar e extrair inputs com defaults
    const {
        V0,           // Valor do imóvel em US$ (obrigatório)
        m,            // Meses de espera (obrigatório)
        FX0,          // Câmbio atual (obrigatório)
        FXbuy,        // Câmbio futuro (obrigatório)
        r = 0.12,     // Taxa aplicação anual (default 12%)
        g = 0.05,     // Valorização anual imóvel (default 5%)
        y = 0.08,     // Yield anual imóvel (default 8%)
        dp = 0.30     // Downpayment (default 30%)
    } = inputs;

    // Validar inputs obrigatórios
    if (!V0 || !m || !FX0 || !FXbuy) {
        throw new Error('Inputs obrigatórios: V0, m, FX0, FXbuy');
    }

    // Cálculos intermediários
    const calculos = {};

    // 1. Bases
    calculos.downUS = V0 * dp;
    calculos.Base_Down_BRL = calculos.downUS * FX0;

    // 2. Taxas mensais
    calculos.r_m = Math.pow(1 + r, 1/12) - 1;
    calculos.g_m = Math.pow(1 + g, 1/12) - 1;
    calculos.y_m = Math.pow(1 + y, 1/12) - 1;

    // 3. Ganhos - Aplicação
    calculos.Fator_Rend = Math.pow(1 + calculos.r_m, m);
    calculos.Rend_Down_BRL = calculos.Base_Down_BRL * (calculos.Fator_Rend - 1);

    // 4. Ganhos - Câmbio
    calculos.GanhoFX_Down_BRL = calculos.downUS * (FX0 - FXbuy);

    // 5. Total Ganhos
    calculos.TOTAL_GANHOS = calculos.Rend_Down_BRL + calculos.GanhoFX_Down_BRL;

    // 6. Perdas - Valorização
    calculos.Fator_Val = Math.pow(1 + calculos.g_m, m);
    calculos.ValPerd_USD = V0 * (calculos.Fator_Val - 1);
    calculos.ValPerd_BRL = calculos.ValPerd_USD * FXbuy;

    // 7. Perdas - Yield
    calculos.Fator_Yield = Math.pow(1 + calculos.y_m, m);
    calculos.YieldPerd_USD = V0 * (calculos.Fator_Yield - 1);
    calculos.YieldPerd_BRL = calculos.YieldPerd_USD * FXbuy;

    // 8. Total Perdas
    calculos.TOTAL_PERDAS = calculos.ValPerd_BRL + calculos.YieldPerd_BRL;

    // 9. Resultado Final
    calculos.Resultado_BRL = calculos.TOTAL_GANHOS - calculos.TOTAL_PERDAS;
    calculos.Resultado_USD = calculos.Resultado_BRL / FXbuy;

    // Preparar output formatado
    const output = {
        resultado: {
            BRL: Math.round(calculos.Resultado_BRL),
            USD: Math.round(calculos.Resultado_USD)
        },
        ganhos: {
            total: Math.round(calculos.TOTAL_GANHOS),
            aplicacao: {
                base_BRL: Math.round(calculos.Base_Down_BRL),
                rendimento_BRL: Math.round(calculos.Rend_Down_BRL)
            },
            cambio: {
                ganho_BRL: Math.round(calculos.GanhoFX_Down_BRL)
            }
        },
        perdas: {
            total: Math.round(calculos.TOTAL_PERDAS),
            valorizacao: {
                USD: Math.round(calculos.ValPerd_USD),
                BRL: Math.round(calculos.ValPerd_BRL)
            },
            yield: {
                USD: Math.round(calculos.YieldPerd_USD),
                BRL: Math.round(calculos.YieldPerd_BRL)
            }
        },
        parametros: {
            valor_imovel_USD: V0,
            meses_espera: m,
            cambio_atual: FX0,
            cambio_futuro: FXbuy,
            taxa_aplicacao_anual: r,
            valorizacao_anual: g,
            yield_anual: y,
            downpayment: dp
        },
        calculos_intermediarios: calculos
    };

    return output;
}