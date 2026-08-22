# Diz Direito — como testar no seu computador

## O que você precisa ter instalado
- Node.js (versão 18 ou mais nova). Se não tiver: https://nodejs.org (baixe a versão "LTS")

## Passo a passo

1. **Pegue sua chave de API da Anthropic**
   - Acesse https://console.anthropic.com/settings/keys
   - Crie uma conta (se ainda não tiver) e gere uma chave
   - Adicione um pouco de crédito (US$5 já é suficiente pra testar bastante — cada prompt gerado custa uma fração de centavo)

2. **Configure o projeto**
   - Renomeie o arquivo `.env.example` para `.env`
   - Abra o `.env` e cole sua chave na linha `ANTHROPIC_API_KEY=`

3. **Instale as dependências** (abra o terminal nesta pasta e rode):
   ```
   npm install
   ```

4. **Rode o servidor**:
   ```
   npm start
   ```
   Você vai ver a mensagem "Diz Direito backend rodando em http://localhost:3000"

5. **Teste no navegador do computador**:
   - Abra http://localhost:3000 no Chrome/Safari/Firefox
   - Use o app normalmente — agora ele passa pelo seu próprio backend, com sua própria chave

## Testar no seu celular (mesmo wifi)

1. Descubra o IP local do seu computador:
   - Mac: Preferências do Sistema → Rede → veja o IP (algo como 192.168.x.x)
   - Windows: abra o cmd e digite `ipconfig`, veja o "Endereço IPv4"
2. No celular (conectado na mesma rede wifi), abra o navegador e acesse:
   `http://SEU-IP-AQUI:3000` (ex: `http://192.168.1.42:3000`)
3. No Safari (iPhone) ou Chrome (Android), você pode usar "Adicionar à Tela de Início" pra deixar com carinha de app instalado.

## Testar de qualquer lugar (não só na sua wifi)

Pra isso o backend precisa estar hospedado num servidor de verdade, não só rodando no seu computador. Serviços com plano gratuito que funcionam bem pra começar: Render, Railway ou Fly.io. Quando você quiser fazer isso, me avisa que eu preparo os arquivos de configuração específicos pra cada um.

## Sobre o limite gratuito
O arquivo `.env` tem `FREE_LIMIT_PER_DAY=8` — isso limita quantos prompts cada pessoa pode gerar por dia, controlado por um ID salvo no navegador dela. É simples (não é à prova de trapaça), mas já protege sua fatura da API enquanto você testa e valida o produto.
