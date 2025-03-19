const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const inputPath = "/home/jurandirsantos/Área de Trabalho/Node_Projects/WhatsApp_Bot/audios/false_5511991210633@c.us_3A8BCE59AFA18DC8901F.ogg";
const tempWavPath = "/home/jurandirsantos/Área de Trabalho/Node_Projects/WhatsApp_Bot/audios/false_5511991210633@c.us_3A8BCE59AFA18DC8901F.wav";

// Usando opusdec para converter o arquivo opus para wav
exec(`opusdec ${inputPath} ${tempWavPath}`, async (error, stdout, stderr) => {
    if (error) {
        console.error(`Erro na conversão: ${error.message}`);
        return;
    }

    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(tempWavPath));
        formData.append('model', 'whisper-1');

        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer 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`
            }
        });

        console.log('Resposta da API Whisper:', response.data);
    } catch (apiError) {
        console.error('Erro ao enviar para a API Whisper:', apiError.response ? apiError.response.data : apiError.message);
    }
});