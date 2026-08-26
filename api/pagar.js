export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Token do Mercado Pago não configurado.' });
    }

    // Criação de Preferência de Assinatura Recorrente (Preapproval)
    const response = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        reason: 'Assinatura Mensal - Diz Direito',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: 19.90,
          currency_id: 'BRL'
        },
        back_url: 'https://diz-direito-app.vercel.app/?status=approved',
        payer_email: 'cliente@exemplo.com' // O Mercado Pago pedirá o e-mail do cliente na tela de pagamento caso necessário
      })
    });

    const data = await response.json();

    // No endpoint de preapproval, o link de pagamento vem no campo 'init_point'
    if (data.init_point) {
      return res.status(200).json({ init_point: data.init_point });
    } else {
      console.error('Erro MP Recorrência:', data);
      return res.status(400).json({ error: 'Erro ao gerar assinatura recorrente', details: data });
    }
  } catch (error) {
    console.error('Erro interno:', error);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }
}