export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Token do Mercado Pago não configurado.' });
    }

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        items: [
          {
            title: 'Assinatura / Créditos - Diz Direito',
            quantity: 1,
            unit_price: 19.90,
            currency_id: 'BRL'
          }
        ],
        back_urls: {
          success: 'https://diz-direito-app.vercel.app/',
          failure: 'https://diz-direito-app.vercel.app/',
          pending: 'https://diz-direito-app.vercel.app/'
        },
        auto_return: 'approved'
      })
    });

    const data = await response.json();

    if (data.init_point) {
      return res.status(200).json({ init_point: data.init_point });
    } else {
      console.error('Erro MP:', data);
      return res.status(400).json({ error: 'Erro ao gerar preferência', details: data });
    }
  } catch (error) {
    console.error('Erro interno:', error);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }
}