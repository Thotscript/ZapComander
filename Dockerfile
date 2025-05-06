# Usa imagem oficial do Node.js
FROM node:20

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia só os arquivos de dependência primeiro
COPY package*.json ./

# Instala as dependências
RUN npm install

# Agora copia o restante do código
COPY . .

# Expõe a porta usada pela aplicação
EXPOSE 8443

# Comando para iniciar o servidor
CMD ["node", "server.js"]
