# Diz Direito — como colocar online pra qualquer pessoa testar

O app que você rodou no seu PC só funciona no seu PC (localhost). Pra mandar
pra alguém testar de qualquer lugar, ele precisa estar hospedado num
servidor de verdade. Vamos usar o **Render**, que tem plano gratuito e não
exige cartão de crédito pra esse tipo de projeto pequeno.

## Passo 1 — Colocar o código no GitHub

O Render pega o código direto de um repositório do GitHub. Se você nunca
usou GitHub:

1. Crie uma conta grátis em github.com
2. Clique no "+" no canto superior direito → "New repository"
3. Dê um nome (ex: `diz-direito-app`), deixe como "Public", clique em
   "Create repository"
4. Na página do repositório vazio, clique em "uploading an existing file"
5. Arraste TODOS os arquivos da pasta `diz-direito-app` (menos a pasta
   `node_modules`, se ela existir) pra essa área
6. Clique em "Commit changes"

## Passo 2 — Criar o serviço no Render

1. Crie uma conta grátis em render.com (dá pra entrar direto com sua conta
   do GitHub, fica mais fácil)
2. Clique em "New +" → "Web Service"
3. Escolha o repositório `diz-direito-app` que você acabou de criar
4. Preencha:
   - **Name**: diz-direito (ou o nome que quiser)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Antes de clicar em criar, desça até "Environment Variables" e adicione:
   - Key: `ANTHROPIC_API_KEY` → Value: sua chave (a mesma do arquivo .env)
   - Key: `FREE_LIMIT_PER_DAY` → Value: `8` (ou o número que preferir)
6. Clique em "Create Web Service"

## Passo 3 — Esperar e pegar o link

O Render vai instalar e ligar o app sozinho (leva uns 2-5 minutos na
primeira vez). Quando terminar, ele te dá um link parecido com:

`https://diz-direito.onrender.com`

Esse link já é público — qualquer pessoa pode abrir, de qualquer celular
ou computador, sem precisar do seu PC ligado.

## Passo 4 — Mandar pra alguém testar com cara de app

1. Manda esse link por WhatsApp pra quem for testar
2. A pessoa abre o link no celular
3. No iPhone (Safari): toca no botão de compartilhar → "Adicionar à Tela
   de Início"
4. No Android (Chrome): toca nos três pontinhos → "Adicionar à tela
   inicial" (ou vai aparecer um banner automático oferecendo isso)
5. Vai aparecer um ícone com a logo do Diz Direito na tela do celular,
   igual um app instalado — abre em tela cheia, sem barra do navegador

## Atenção com o plano gratuito do Render

O plano free "dorme" depois de alguns minutos sem uso — quando alguém abre
o link depois de um tempo parado, pode demorar uns 30-50 segundos pra
"acordar" na primeira vez. Depois disso funciona normal. É uma limitação
só do plano grátis; se o app validar bem, dá pra migrar pra um plano pago
bem barato (uns US$7/mês) que não dorme.
