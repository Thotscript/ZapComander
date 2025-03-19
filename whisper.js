const axios = require('axios');

axios.post('https://440a-2804-14c-55-80ac-3d72-2af9-e1d-a25d.ngrok-free.app/process_qr', {
    sessionId: "teste",
    qrCode: "QRCode123"
}).then(response => {
    console.log("Resposta do servidor Python:", response.data);
}).catch(error => {
    console.error("Erro no envio:", error.message);
});