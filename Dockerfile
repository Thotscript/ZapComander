# Usa imagem oficial do Node.js
FROM node:20

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos do projeto para dentro do container
COPY . .

# Instala as dependências do package.json
RUN npm install

# Expõe a porta usada pela aplicação (ajuste se sua porta for diferente)
EXPOSE 8443

# Comando para iniciar o servidor
CMD ["node", "server.js"]