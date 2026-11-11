module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const model = process.env.CLOUDFLARE_MODEL || '@cf/qwen/qwen3.8-27b';
  res.setHeader('Cache-Control', 'no-store');

  if (!accountId || !apiToken) {
    return res.status(500).json({
      error: 'Configure CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN nas variáveis de ambiente da Vercel e faça um novo deploy.'
    });
  }

  const input = req.body || {};
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 8) {
    return res.status(400).json({ error: 'O campo messages deve conter de 1 a 8 mensagens.' });
  }

  const messages = input.messages.map((m) => ({
    role: ['system', 'user', 'assistant'].includes(m?.role) ? m.role : 'user',
    content: String(m?.content || '').slice(0, 12000)
  }));

  try {
    const upstream = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' +
        encodeURIComponent(accountId) + '/ai/run/' + encodeURIComponent(model).replace(/%2F/g, '/'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messages, max_tokens: 1400, temperature: 0.2 }),
        signal: AbortSignal.timeout(55000)
      }
    );

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || data.success === false) {
      const detail = data?.errors?.[0]?.message || data?.error || 'Falha no serviço Cloudflare AI.';
      return res.status(upstream.status >= 400 ? upstream.status : 502).json({ error: detail });
    }

    const result = data?.result ?? data;
    const candidates = [
      typeof result === 'string' ? result : null,
      result?.response,
      result?.choices?.[0]?.message?.content,
      result?.choices?.[0]?.delta?.content,
      result?.output?.[0]?.content?.[0]?.text,
      result?.message?.content,
      result?.content?.[0]?.text
    ];
    const answerValue = candidates.find((value) => typeof value === 'string' && value.trim());
    if (!answerValue) {
      const shape = result && typeof result === 'object' ? Object.keys(result).join(', ') : typeof result;
      return res.status(502).json({ error: 'Formato de resposta da Cloudflare não reconhecido. Campos recebidos: ' + (shape || 'nenhum') });
    }
    return res.status(200).json({ ok: true, model, text: answerValue, finish_reason: result?.choices?.[0]?.finish_reason || null });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? 'Tempo limite excedido ao consultar Cloudflare AI.' : 'Falha ao consultar Cloudflare AI: ' + (error?.message || 'erro desconhecido')
    });
  }
};

module.exports.config = { maxDuration: 60 };
