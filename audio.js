async function processAudio(sessionName, message) {
    try {
        if (!SESSIONS.has(sessionName)) throw new Error(`Sessão ${sessionName} não encontrada.`);

        const session = SESSIONS.get(sessionName);
        const client = session.client;
        const myNumber = session.myNumber;
        const email = session.email;

        if (!myNumber) {
            console.error(`⚠️ Número da sessão ${sessionName} ainda não definido.`);
            return;
        }

        const filtros = await loadFiltersFromDB(email, sessionName);

        const contact = await client.getContact(message.from);
        const senderName = contact.name || contact.pushname || message.from;

        console.log(`Processando imagem de ${senderName}`);


        const inputPath = path.join(AUDIO_DIR, `${message.id}.ogg`);
        let buffer = await client.decryptFile(message);

        
        await new Promise((resolve, reject) => {
          const stream = fs.createWriteStream(inputPath);
          stream.write(buffer, (err) => {
            if (err) reject(err);
            else resolve();
          });
          stream.end();
        });
        // Libera buffer da memória
        buffer = null;

        const duration = await getAudioDuration(inputPath);
        const roundduration = parseFloat(duration.toFixed(2));
        console.log(`Audio de ${roundduration} sec`);

        const formData = new FormData();
        formData.append('file', fs.createReadStream(inputPath));
        formData.append('model', 'whisper-1');

        // Chamada para transcrição no OpenAI Whisper
        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            }
        });

        const transcricao = response.data.text;

        let prompt_base = '';
        let prompt_use = transcricao;
        
        // 1. Define o idioma base se a tradução estiver ativada
// 1. Define o idioma base se a tradução estiver ativada
        let languagePrompt = '';
        if (filtros.translation_enabled) {
          switch (filtros.language) {
            case 'pt-br':
              languagePrompt = 'traduzir qualquer mensagem para português';
              break;
            case 'en-us':
              languagePrompt = 'traduzir qualquer mensagem para inglês';
              break;
            case 'es-es':
              languagePrompt = 'traduzir qualquer mensagem para espanhol';
              break;
            default:
              console.warn('Idioma não reconhecido para tradução:', filtros.language);
              break;
          }
        }
        
        // 2. Monta a estrutura do prompt com base nos outros filtros
        if (filtros.summarizeMessages && filtros.longmessage) {
          prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio, você deve devolver o texto original corrigido e então falar os tópicos do texto. Sempre pule 2 linhas e adicione ao final do texto: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        
        } else if (filtros.summarizeMessages) {
          // Usa prompt específico (caso tenha sido definido em outro lugar, ex: variável `prompt_transcricao`)
          prompt_base = typeof prompt_transcricao !== 'undefined' ? prompt_transcricao : `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio e então falar os tópicos do texto. Sempre pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        
        } else if (filtros.longmessage) {
          prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio. Mantenha o texto original o máximo possível, apenas fazendo correções gramaticais e de pontuação. Sempre pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        
        } else {
          // Fallback (sem filtros extras)
          prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de textos. Sempre pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        }
        
        
        const sendToSelf = filtros.sendForward === true || filtros.sendForward === '1' || filtros.sendForward === 1;
        const recipient = sendToSelf ? myNumber : message.from;
        
        

        // Chamada para resumir a transcrição no GPT-4o-mini
        const response_gpt = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: prompt_base
                    },
                    {
                        role: "user",
                        content: prompt_use
                    }
                ]
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const resumo = response_gpt.data.choices[0].message.content;
        const legenda = `*Transcrição do áudio de ${senderName}:* \n\n${transcricao}\n${resumo}`;
        await new Promise(resolve => setTimeout(resolve, 10));
        await client.sendText(recipient, resumo, {
            quotedMsg:message.id
        });

        fs.unlinkSync(inputPath);

        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');

        const formattedDateTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    
        const logData = {
          email: session.email,
          numero: sessionName,
          ultimo_acesso: formattedDateTime
        };

        try {
          await saveSessionLog(logData);
          console.log('✅ Log de sessão salvo no banco.');
        } catch (err) {
          console.error('❌ Erro ao gravar log de sessão no banco:', err);
        }
        
    
        const logFilePath = path.join(SESSION_LOGS_DIR, `${sessionName}.json`);
        try {
          fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2), 'utf8');
          console.log(`Log atualizado para a sessão ${sessionName}`);
        } catch (err) {
          console.error(`Falha ao salvar log para ${sessionName}:`, err);
        }

    } catch (error) {
        console.error('❌ Erro ao processar áudio:', error?.response?.data || error.message);
    }
}