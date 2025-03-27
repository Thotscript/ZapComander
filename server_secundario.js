import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import wppconnect from '@wppconnect-team/wppconnect';
import FormData from 'form-data';

dotenv.config();

const SESSIONS = new Map();
const app = express();
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const server = http.createServer(app);
const PORT = process.env.PORT;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const TOKEN_DIR = path.join(__dirname, 'tokens');

// Criar diretórios necessários caso não existam
[QR_CODES_DIR,TOKEN_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});


app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Aqui é a rota que recebe a requisição que vai ser enviada pelo servidor Django depois que o usuário estiver logado.

app.get('/auth/:sessionName', async (req, res) => {

    const { sessionName } = req.params;

    if (SESSIONS.has(sessionName)) {
        return res.json({ message: `Sessão ${sessionName} já autenticada.` });
    }

    //Verifica se existe uma pasta já criada para a sessão iniciada ------------------

    try {
        console.log(`Criando sessão: ${sessionName}`);
        const sessionPath = path.join(TOKEN_DIR, sessionName);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }
    // --------------------------------------------------------------------------------


        //Start na criação da sessão com o WPPConnect -----------------

        const client = await Promise.race([
            wppconnect.create({
                session: sessionName,
                statusFind: (statusSession, sessionName) => {
                    if(statusSession === 'autocloseCalled'){
                        cleanupSession(sessionName)
                    }
                },
                deviceName: 'The Broker VIP',
                catchQR: (base64Qr) => saveQRCode(base64Qr, sessionName),
                headless: true,
                autoClose: 40000,
                puppeteerOptions: { userDataDir: sessionPath }
            })
        ]);


        // --------------------------------------------------------------

        //Cria o MAP da sessão salvando dentro dela o SessionName, O Client criado com a conexão do Wpp e uma variavel myNumber para receber valores posteriormente

        SESSIONS.set(sessionName, { client, myNumber: null });

        //---------------------------------------------------------------------------------------------------------------------------------------------------------


        // Evento cliente onStateChange, verifica a mudança do estado do client --------------

        client.onStateChange(async (state) => {
            try {
                console.log(`Estado da sessão ${sessionName}: ${state}`);

                if (state === 'CONNECTED') {
                    console.log(`✅ Sessão ${sessionName} autenticada.`);
                    broadcastSessionAuthenticated(sessionName);

                    const myNumber = await client.getWid();
                    SESSIONS.get(sessionName).myNumber = myNumber;
                    console.log(`Número Logado para ${sessionName}: ${myNumber}`);

                    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
                    if (fs.existsSync(qrFilePath)) {
                        fs.unlinkSync(qrFilePath);
                        console.log(`Sessão ${sessionName} autenticada, QR Code de autenticação removido!`);
                    }
                } 
            } catch (error) {
                console.error(`⚠️ Erro no evento onStateChange da sessão ${sessionName}:`, error);
            }
        });

        // -----------------------------------------------------------------------------------------

        // Evento para captura de mensagens -> é criado uma função async para ficar ouvindo o objeto message que vem do client ------------------------------
        // Verifica se a mensagem é do tipo Audio (ptt), devolve na tela que houve um audio recebido e chama a função para o tratamento/transcrição do audio
        client.onMessage(async (message) => {
            try {
                if (message.type === 'ptt' || message.mimetype?.startsWith('audio/')) {
                    console.log(`Mensagem de áudio recebida na sessão ${sessionName}. Processando...`);
                    await processAudio(sessionName, message);
                }
            } catch (error) {
                console.error(`Erro ao processar mensagem na sessão ${sessionName}:`, error);
            }
        });

        // ---------------------------------------------------------------------------------------------------------------------------------------------------

        //Mesma função mas essa verifica se o message é do tipo texto (chat) e faz a chamada da função de tratamento de texto ----------------

        client.onMessage(async (message) => {
            try {
                if (message.type === 'chat') {
                    console.log(`Mensagem de texto recebida na sessão ${sessionName}. Processando...`);
                    await processTextMessage(sessionName, message);
                }
            } catch (error) {
                console.error(`Erro ao processar mensagem na sessão ${sessionName}:`, error);
            }
        });

        // -------------------------------------------------------------------------------------------------------------------------------------


    } catch (error) {
        console.error(`Erro ao criar sessão:[${sessionName}]: => `, error);
    }

    // Fim do Try Catch de tentativa de conexão, ele encapsula a função de captura e criação da sessão para que o restante do código ou tentativas de novas sessões
    // não travem o serviço.
});

// ---------------------------------------------------------------------------------------- Final da Rota ----------------------------------------


//Função que extrai o qrcode de dentro da chamada do wppconnect e salva-o em um diretório temporário

function saveQRCode(base64Qr, sessionName) {
    const matches = base64Qr.match(/^data:image\/png;base64,(.+)$/);
    if (!matches) return console.error('Formato de QR Code inválido.');

    const imageBuffer = Buffer.from(matches[1], 'base64');
    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);

    fs.writeFile(qrFilePath, imageBuffer, (err) => {
        if (err) {
            console.error('Erro ao salvar QR Code:', err);
        } else {
            broadcastQR(sessionName);
        }
    });
}

//-----------------------------------------------------------------------------------------------------

//Função para apagar as pastas de sessões inativas ou com autenticações falhas, além de apagar o qrcode gerado para a sessão do servidor

async function cleanupSession(sessionName) {

    if (SESSIONS.has(sessionName)) {
        const session = SESSIONS.get(sessionName);
        await session.client.close();
        SESSIONS.delete(sessionName);
        console.log(`🔴 Sessão ${sessionName} encerrada.`);
    }

    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
    if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);

    const sessionPath = path.join(TOKEN_DIR, sessionName);
    setTimeout(() => {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`Sessão:[${sessionName}] => Removida por falha na autenticação!`);
        }
    }, 4000);
}

//-----------------------------------------------------------------------------------------------------------------------------------------

async function broadcastQR(sessionName) {
    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
    const form = new FormData();
    form.append('sessionName', sessionName);
    form.append('qrcode', fs.createReadStream(qrFilePath)); // Aqui adicionamos o arquivo
    console.log(`Caminho do QR Code: ${qrFilePath}`);


    const djangoEndpoint = 'http://localhost:8000/api/qrcode/';

    // Usando axios para enviar o arquivo
    try {
        const response = await axios.post(djangoEndpoint, form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${SECRET_TOKEN}`, // Adiciona o token de autenticação
            },
        });
        console.log('✅ QR Code enviado com sucesso para o Django');
    } catch (error) {
        console.error('❌ Erro ao enviar QR Code para o Django:', error.response ? error.response.data : error.message);
    }
}

// ---------------------------------------------------------------------------------------

server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
