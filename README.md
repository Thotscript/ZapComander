## TBVBroker MVP

Este é um servico MVP de transcricao de mensagens de audio do WhatsApp e interacao com bots no número determinado no server.js
para atender e rodar prompts no ChatGPT para atendimento e simulacoes no WhatsApp

Todos os endpoints estão apontados para o domínio `thebroker.vip` e devem ser substituídos em caso de mudanca

## Instalacao

Para rodar o servico você deve primeiro configurar o servidor web de exposicao de acordo  com as portas utilizadas dentro de `server.js` e `app.js`.
Antes de rodar o projeto vc deve navegar até o diretório e rodar: 

```bash
npm install
```

isso garante que as dependências do projeto sejam instaladas e entao rode como servico no linux ou manualmente com: 

```bash
node projeto.js
```

## Observacoes

Todos os endpoints se conectam com os plugins no wordpress do thebroker.vip e estão nomeados do 1 ao 8
e implementados via [short code] no wordpress.

O projeto é um MVP portanto não segue normas e tão pouco padrões de desenvolvimento, todas as regras e rotas estão definidas em `server.js` incluindo as variáveis globais definidas no topo do arquivo.