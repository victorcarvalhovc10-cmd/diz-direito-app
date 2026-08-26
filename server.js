// Este arquivo é usado só para rodar LOCALMENTE no seu computador (npm start).
// No Vercel, quem entra em ação é o arquivo api/index.js — a lógica do app
// (rotas, motor de IA) mora em app.js e é compartilhada pelos dois.
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Diz Direito backend rodando em http://localhost:${PORT}`);
});
