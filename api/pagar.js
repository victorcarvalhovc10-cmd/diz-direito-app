import { MercadoPagoConfig, Preference } from 'mercadopago';

// Configura o Mercado Pago com a chave de segurança da Vercel
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const preference = new Preference(client);
    
    const response = await preference.create({
      body: {
        items: [
          {
            title: 'Pacote de Créditos - Diz Direito',
            quantity: 1,
            unit_price: 19.90, // Valor do pacote
            currency_id: 'BRL',
          },
        ],
        back_urls: {
          success: 'https://diz-direito-app.vercel.app/',
          failure: 'https://diz-direito-app.vercel.app/',
          pending: 'https://diz-direito-app.vercel.app/',
        },
        auto_return: 'approved',
      },
    });

    return res.status(200).json({ init_point: response.init_point });
    
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao gerar pagamento' });
  }
}