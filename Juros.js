async function handleTriggerEsperarJuros(session, message, userInput, sessionName, email) {
  const client   = session.client;
  const sender   = message.from;
  const convoKey = `${session.myNumber}:${sender}`;
  
  // Inicia ou recupera o estado da conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvesperarjuros'
  };
  
  // Se for a primeira interação, injeta o system prompt
  if (convo.history.length === 0) {
    // Carrega o prompt "EsperarJuros"
    const prompt = loadPrompt('tbvjuros');
    
    // Combina tudo em uma única mensagem system para evitar conflitos
    // MODIFICADO: Removido instruções sobre incluir o link do PDF
    const fullSystemPrompt = `${prompt}

Você tem acesso a uma função chamada calcularEsperarJurosComRefinanciamento que recebe um JSON e retorna os cálculos. 

Quando tiver todos os dados necessários, use esta função passando um objeto JSON com os seguintes campos:
- V0: valor do imóvel em USD (obrigatório)
- m1: meses até a compra (obrigatório)
- m2: meses até entrega após compra (obrigatório, default 1)
- r_atual: taxa de juros atual anual (obrigatório)
- r_futura: taxa de juros futura anual (obrigatório)
- dp: downpayment (opcional, default 0.30)
- g: valorização anual do imóvel (opcional, default 0.05)
- r_app_usd: taxa aplicação em USD (opcional, default 0.04)
- pontos: taxa de pontos (opcional, default 0.015)
- pct_closing: custo refinanciamento (opcional, default 0.01)
- prazo_meses: prazo financiamento (opcional, default 360)

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
    functions: [{
      name: "calcularEsperarJurosComRefinanciamento",
      description: "Calcula se vale a pena esperar juros cair ou comprar agora e refinanciar",
      parameters: {
        type: "object",
        properties: {
          V0: { type: "number", description: "Valor do imóvel em USD" },
          m1: { type: "number", description: "Meses até a compra" },
          m2: { type: "number", description: "Meses até entrega após compra" },
          r_atual: { type: "number", description: "Taxa de juros atual anual (ex: 0.08 para 8%)" },
          r_futura: { type: "number", description: "Taxa de juros futura anual (ex: 0.05 para 5%)" },
          dp: { type: "number", description: "Percentual de downpayment (opcional)" },
          g: { type: "number", description: "Valorização anual do imóvel (opcional)" },
          r_app_usd: { type: "number", description: "Taxa aplicação em USD anual (opcional)" },
          pontos: { type: "number", description: "Taxa de pontos (opcional)" },
          pct_closing: { type: "number", description: "Custo refinanciamento (opcional)" },
          prazo_meses: { type: "number", description: "Prazo do financiamento em meses (opcional)" }
        },
        required: ["V0", "m1", "m2", "r_atual", "r_futura"]
      }
    }],
    function_call: "auto"
  });
  
  const responseMessage = gptResponse.choices[0].message;
  
  // Se o GPT chamou a função
  if (responseMessage.function_call) {
    const functionName = responseMessage.function_call.name;
    const functionArgs = JSON.parse(responseMessage.function_call.arguments);
    
    if (functionName === "calcularEsperarJurosComRefinanciamento") {
      let pdfInfo = null;
      
      try {
        // Executa a função de cálculo
        const resultado = calcularEsperarJurosComRefinanciamento(functionArgs);
        
        // Gera o PDF com os resultados
        pdfInfo = await gerarPDFResultado(resultado, functionArgs);
        
        // MODIFICADO: Não incluímos mais o PDF no resultado enviado ao GPT
        convo.history.push({
          role: 'function',
          name: 'calcularEsperarJurosComRefinanciamento',
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

📊 **ANÁLISE: ESPERAR JUROS vs COMPRAR AGORA**

**Cenário Analisado:**
• Imóvel de US$ [use o valor de parametros.V0]
• Espera de [use parametros.m1] meses para juros caírem
• Taxa atual: [use parametros.r_atual convertido para %]% → Taxa futura: [use parametros.r_futura convertido para %]%

**RESULTADO: [use resultado.conclusao]**
Diferença: US$ [use resultado.valor_final]

✅ **GANHOS AO ESPERAR:**
• Economia pontos refinanciamento: US$ [use ganhos.economia_pontos]
• Economia prestações iniciais: US$ [use ganhos.economia_prestacoes_periodo]
• Rendimento do downpayment: US$ [use ganhos.rendimento_downpayment]
• Total ganhos: US$ [use ganhos.total]

❌ **PERDAS POR ESPERAR:**
• Valorização do imóvel: US$ [use perdas.valorizacao_imovel]
• Downpayment adicional: US$ [use perdas.downpayment_adicional]
• Total perdas: US$ [use perdas.total]

📈 **COMPARAÇÃO DE CENÁRIOS:**

**Se comprar hoje:**
• Downpayment: US$ [use comparacao_cenarios.comprar_hoje.downpayment]
• Prestação inicial ([r_atual]%): US$ [use comparacao_cenarios.comprar_hoje.prestacao_inicial]/mês
• Prestação após refinanciar ([r_futura]%): US$ [use comparacao_cenarios.comprar_hoje.prestacao_apos_refi]/mês

**Se esperar:**
• Downpayment: US$ [use comparacao_cenarios.esperar_comprar.downpayment]
• Prestação única ([r_futura]%): US$ [use comparacao_cenarios.esperar_comprar.prestacao_unica]/mês

💡 **CONCLUSÃO:**
[Se resultado.valor_final > 0]: Esperar [m1] meses resultaria em economia de US$ [valor_final]. Os ganhos com aplicação e economia de juros compensam a valorização do imóvel.
[Se resultado.valor_final < 0]: Comprar agora economizaria US$ [valor_final absoluto]. A valorização do imóvel supera os benefícios de esperar juros menores.

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
          const pdfMessage = `📑 **RELATÓRIO COMPLETO EM PDF**

Preparei um relatório detalhado com gráficos e análise visual completa dos seus cenários.

🔗 **Acesse aqui:** ${pdfInfo.url}

⏰ *Link válido até ${new Date(pdfInfo.validade).toLocaleTimeString('pt-BR')} (5 minutos)*

💡 Dica: Salve o PDF para consultas futuras!`;
          
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

// Função para gerar o PDF (mantida sem alterações)
async function gerarPDFResultado(resultado, inputs) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // HTML com design profissional inspirado no PDF
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
            grid-template-columns: repeat(3, 1fr);
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
            font-size: 24px;
            font-weight: 700;
        }
        
        .circle-label {
            font-size: 12px;
            color: #ccc;
            margin-top: 5px;
        }
        
        .metric-title {
            font-size: 14px;
            color: #ccc;
            font-weight: 600;
        }
        
        /* Bottom Metrics */
        .bottom-metrics {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 30px;
            margin-top: 30px;
            padding-top: 30px;
            border-top: 1px solid #333;
        }
        
        .big-metric {
            text-align: center;
            padding: 20px;
            border: 2px solid #333;
            border-radius: 8px;
        }
        
        .big-metric-value {
            font-size: 32px;
            font-weight: 700;
            color: #e91e63;
            margin-bottom: 5px;
        }
        
        .big-metric-label {
            font-size: 14px;
            color: #ccc;
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
        
        /* Responsiveness for PDF */
        @media print {
            body {
                background-color: #ffffff;
            }
            .page {
                max-width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="page">
        <!-- Header -->
        <div class="header">
            <h1>ANÁLISE ESPERAR JUROS CAIR</h1>
            <div class="logo">THE FLORIDA<br>LOUNGE</div>
        </div>
        
        <!-- Subtitle -->
        <div class="subtitle-bar">
            IMÓVEL: ${formatCurrency(inputs.V0)} | ESPERA: ${inputs.m1} MESES | JUROS: ${(inputs.r_atual*100).toFixed(1)}% → ${(inputs.r_futura*100).toFixed(1)}%
        </div>
        
        <!-- Main Content -->
        <div class="main-content">
            <!-- Left Section - Details -->
            <div class="left-section">
                <h3 class="section-title">CENÁRIO ATUAL</h3>
                <div class="data-row">
                    <span class="data-label">VALOR IMÓVEL</span>
                    <span class="data-value">${formatCurrency(inputs.V0)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">DOWNPAYMENT (${((inputs.dp || 0.30)*100).toFixed(0)}%)</span>
                    <span class="data-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.downpayment)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">VALOR FINANCIADO</span>
                    <span class="data-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.valor_financiado)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">TAXA ATUAL</span>
                    <span class="data-value">${(inputs.r_atual*100).toFixed(1)}%</span>
                </div>
                <div class="data-row">
                    <span class="data-label">PRESTAÇÃO INICIAL</span>
                    <span class="data-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.prestacao_inicial)}</span>
                </div>
            </div>
            
            <!-- Right Section - Metrics -->
            <div class="right-section">
                <div class="metrics-grid">
                    <!-- Ganhos -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-positive">
                                <div class="circle-value">${formatCurrency(resultado.ganhos.total)}</div>
                                <div class="circle-label">Ganhos</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL GANHOS</div>
                    </div>
                    
                    <!-- Perdas -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-negative">
                                <div class="circle-value">${formatCurrency(resultado.perdas.total)}</div>
                                <div class="circle-label">Perdas</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL PERDAS</div>
                    </div>
                    
                    <!-- Valorização -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg">
                                <div class="circle-value">${((inputs.g || 0.05)*100).toFixed(0)}%</div>
                                <div class="circle-label">a.a.</div>
                            </div>
                        </div>
                        <div class="metric-title">VALORIZAÇÃO</div>
                    </div>
                </div>
                
                <!-- Bottom Metrics -->
                <div class="bottom-metrics">
                    <div class="big-metric">
                        <div class="big-metric-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.prestacao_inicial)}</div>
                        <div class="big-metric-label">Prestação<br>Taxa Alta</div>
                    </div>
                    <div class="big-metric">
                        <div class="big-metric-value">${formatCurrency(resultado.comparacao_cenarios.esperar_comprar.prestacao_unica)}</div>
                        <div class="big-metric-label">Prestação<br>Se Esperar</div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Result Section -->
        <div class="result-section ${resultado.resultado.valor_final > 0 ? 'result-positive' : 'result-negative'}">
            <h2 class="result-title">${resultado.resultado.conclusao.toUpperCase()}</h2>
            <div class="result-value">${formatCurrency(Math.abs(resultado.resultado.valor_final))}</div>
            <p class="result-description">
                ${resultado.resultado.valor_final > 0 
                    ? `Esperar ${inputs.m1} meses resultaria em uma economia de ${formatCurrency(Math.abs(resultado.resultado.valor_final))}. Os ganhos com aplicação do capital e economia de pontos compensam a valorização do imóvel.`
                    : `Comprar agora economizaria ${formatCurrency(Math.abs(resultado.resultado.valor_final))}. A valorização do imóvel em ${inputs.m1} meses supera os benefícios de esperar juros menores.`}
            </p>
        </div>
        
        <!-- Detailed Breakdown -->
        <div class="main-content">
            <div class="left-section">
                <h3 class="section-title">GANHOS AO ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">ECONOMIA PONTOS</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.economia_pontos)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">ECONOMIA PRESTAÇÕES</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.economia_prestacoes_periodo || 0)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">RENDIMENTO DOWNPAYMENT</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.rendimento_downpayment)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL GANHOS</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.total)}</span>
                </div>
            </div>
            
            <div class="left-section">
                <h3 class="section-title">PERDAS POR ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">VALORIZAÇÃO IMÓVEL</span>
                    <span class="data-value">${formatCurrency(resultado.perdas.valorizacao_imovel)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">DOWNPAYMENT ADICIONAL</span>
                    <span class="data-value">${formatCurrency(resultado.perdas.downpayment_adicional)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL PERDAS</span>
                    <span class="data-value">${formatCurrency(resultado.perdas.total)}</span>
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
    const nomeArquivo = `analise_juros_${timestamp}_${randomHash}.pdf`;
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
    
    console.log(`📊 [JUROS-PDF] Arquivo PDF criado: ${nomeArquivo} em ${PDF_DIR}`);
    
    // Agendar exclusão do arquivo após 5 minutos
    setTimeout(async () => {
      try {
        await fs.unlink(caminhoCompleto);
        console.log(`📊 [JUROS-PDF] PDF ${nomeArquivo} removido após 5 minutos`);
      } catch (error) {
        console.error(`❌ [JUROS-PDF] Erro ao remover PDF ${nomeArquivo}:`, error);
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

// Função auxiliar para formatar moeda
function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

// Função de cálculo (mesma que criamos anteriormente)
function calcularEsperarJurosComRefinanciamento(inputs) {
    // Validar e extrair inputs com defaults
    const {
        V0,                    // Valor do imóvel em US$ (obrigatório)
        m1,                    // Meses até a compra (obrigatório)
        m2 = 1,               // Meses até entrega após compra (default 1)
        r_atual,              // Taxa de juros atual anual (obrigatório)
        r_futura,             // Taxa de juros futura anual (obrigatório)
        dp = 0.30,            // Downpayment (default 30%)
        g = 0.05,             // Valorização anual imóvel (default 5%)
        r_app_usd = 0.04,     // Taxa aplicação em USD (default 4% a.a.)
        pontos = 0.015,       // Taxa de pontos (default 1.5%)
        prazo_meses = 360,    // Prazo financiamento (default 30 anos)
        pct_closing = 0.01    // Custo refinanciamento (default 1%)
    } = inputs;

    // Validar inputs obrigatórios
    if (!V0 || !m1 || r_atual === undefined || r_futura === undefined) {
        throw new Error('Inputs obrigatórios: V0, m1, r_atual, r_futura');
    }

    // Função auxiliar PMT (pagamento mensal)
    function PMT(rate, nper, pv) {
        if (rate === 0) return -pv / nper;
        const pvif = Math.pow(1 + rate, nper);
        const pmt = rate * pv * pvif / (pvif - 1);
        return pmt;
    }

    // Cálculos
    const calculos = {};
    
    // Período total de espera
    const periodo_total = m1 + m2;

    // 1. Valorização do imóvel durante a espera
    const g_m = Math.pow(1 + g, 1/12) - 1;
    calculos.Val_Perdida = V0 * (Math.pow(1 + g_m, m1) - 1);
    calculos.V0_Valorizado = V0 + calculos.Val_Perdida;

    // 2. Valores de downpayment
    calculos.Down_Inicial = V0 * dp;
    calculos.Down_Futuro = calculos.V0_Valorizado * dp;

    // 3. Valores financiados
    calculos.Financiado_Inicial = V0 * (1 - dp);
    calculos.Financiado_Futuro = calculos.V0_Valorizado * (1 - dp);
    
    // Prestações
    const r_mensal_atual = r_atual / 12;
    const r_mensal_futura = r_futura / 12;
    
    calculos.Prestacao_Alta = PMT(r_mensal_atual, prazo_meses, calculos.Financiado_Inicial);
    calculos.Prestacao_Futura = PMT(r_mensal_futura, prazo_meses, calculos.Financiado_Futuro);
    
    // Saldo após período para refinanciamento
    let saldo_apos_periodo = calculos.Financiado_Inicial;
    for (let i = 0; i < periodo_total; i++) {
        const juros_mes = saldo_apos_periodo * r_mensal_atual;
        const amortizacao = calculos.Prestacao_Alta - juros_mes;
        saldo_apos_periodo -= amortizacao;
    }
    
    // Refinanciamento
    calculos.Closing_Cost_Refi = V0 * pct_closing;
    calculos.Valor_Refinanciamento = saldo_apos_periodo + calculos.Closing_Cost_Refi;
    
    const meses_restantes = prazo_meses - periodo_total;
    calculos.Prestacao_Refinanciada = PMT(r_mensal_futura, meses_restantes, calculos.Valor_Refinanciamento);
    
    // GANHOS
    calculos.Economia_Pontos = calculos.Financiado_Inicial * pontos;
    calculos.Economia_Prestacoes_Periodo = (calculos.Prestacao_Alta - calculos.Prestacao_Futura) * periodo_total;
    
    const r_app_mensal = Math.pow(1 + r_app_usd, 1/12) - 1;
    calculos.Rendimento_Down = calculos.Down_Inicial * (Math.pow(1 + r_app_mensal, m1) - 1);
    
    calculos.TOTAL_GANHOS = calculos.Economia_Pontos + calculos.Economia_Prestacoes_Periodo + calculos.Rendimento_Down;
    
    // PERDAS
    calculos.Perda_Valorizacao = calculos.Val_Perdida;
    calculos.Perda_Down = calculos.Down_Futuro - calculos.Down_Inicial;
    
    calculos.TOTAL_PERDAS = calculos.Perda_Valorizacao + calculos.Perda_Down;
    
    // Resultado
    calculos.Resultado = calculos.TOTAL_GANHOS - calculos.TOTAL_PERDAS;

    // Preparar output
    const output = {
        resultado: {
            valor_final: Math.round(calculos.Resultado),
            conclusao: calculos.Resultado > 0 ? "Vale a pena esperar" : "Melhor comprar agora"
        },
        ganhos: {
            economia_pontos: Math.round(calculos.Economia_Pontos),
            economia_prestacoes_periodo: Math.round(calculos.Economia_Prestacoes_Periodo),
            rendimento_downpayment: Math.round(calculos.Rendimento_Down),
            total: Math.round(calculos.TOTAL_GANHOS)
        },
        perdas: {
            valorizacao_imovel: Math.round(calculos.Perda_Valorizacao),
            downpayment_adicional: Math.round(calculos.Perda_Down),
            total: Math.round(calculos.TOTAL_PERDAS)
        },
        comparacao_cenarios: {
            comprar_hoje: {
                downpayment: Math.round(calculos.Down_Inicial),
                valor_financiado: Math.round(calculos.Financiado_Inicial),
                prestacao_inicial: Math.round(calculos.Prestacao_Alta),
                custo_refinanciamento: Math.round(calculos.Closing_Cost_Refi),
                prestacao_apos_refi: Math.round(calculos.Prestacao_Refinanciada)
            },
            esperar_comprar: {
                downpayment: Math.round(calculos.Down_Futuro),
                valor_financiado: Math.round(calculos.Financiado_Futuro),
                prestacao_unica: Math.round(calculos.Prestacao_Futura)
            }
        },
        parametros: inputs,
        detalhes: {
            valor_imovel_valorizado: Math.round(calculos.V0_Valorizado),
            periodo_total_espera: periodo_total,
            saldo_ao_refinanciar: Math.round(saldo_apos_periodo)
        }
    };

    return output;
}