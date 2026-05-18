// Edge Function: ai-proxy — v2.3
// Proxy seguro para Anthropic API via Supabase
// Deploy: supabase functions deploy ai-proxy --project-ref qlpqybumoaxndzppddyk
// Secrets necessários: ANTHROPIC_KEY, SB_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── MAPA DE MODELOS ──────────────────────────────────────────────────────────
// Chaves: nomes proprietários enviados pelo cliente (nunca expor à IA ao usuário)
// Valores: IDs reais da API Anthropic
const MODELOS_ANTHROPIC: Record<string, string> = {
  'essencial': 'claude-haiku-4-5-20251001', // Rápido
  'avancado':  'claude-sonnet-4-6',          // Padrão
  'completo':  'claude-opus-4-7',            // Premium
};

// ── MODELOS PERMITIDOS POR PLANO ─────────────────────────────────────────────
// plano (valor do banco) → lista de chaves de modelo permitidas
const MODELOS_PERMITIDOS: Record<string, string[]> = {
  'trial':      ['essencial', 'avancado'],   // Demonstração
  'solo':       ['essencial', 'avancado'],   // Avançado
  'pro':        ['essencial', 'avancado', 'completo'], // Completo
  'escritorio': ['essencial', 'avancado', 'completo'], // Escritório (futuro)
};

// ── LIMITES MENSAIS POR PLANO ────────────────────────────────────────────────
const LIMITES_PLANO: Record<string, number> = {
  'trial':      25,
  'solo':       150,
  'pro':        300,
  'escritorio': 300,
};

// ── CORS ─────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── VERIFICAR SE O RESET MENSAL É NECESSÁRIO ─────────────────────────────────
function deveResetarMes(resetAt: string | null): boolean {
  if (!resetAt) return true;
  const reset = new Date(resetAt);
  const agora = new Date();
  return reset.getFullYear() !== agora.getFullYear() ||
         reset.getMonth()    !== agora.getMonth();
}

// ─────────────────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    // 1. Autenticação via JWT do Supabase Auth
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResp({ error: 'Não autorizado.' }, 401);
    }

    const supabaseAdmin = createClient(
      'https://qlpqybumoaxndzppddyk.supabase.co',
      Deno.env.get('SB_SERVICE_ROLE_KEY') ?? '',
    );

    const token = authHeader.slice(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return jsonResp({ error: 'Sessão inválida. Faça login novamente.' }, 401);
    }

    // 2. Buscar perfil do usuário na tabela gp_users
    const { data: perfil, error: perfilError } = await supabaseAdmin
      .from('gp_users')
      .select('plano, pecas_mes, pecas_mes_reset, is_admin')
      .eq('id', user.id)
      .single();

    if (perfilError && perfilError.code !== 'PGRST116') {
      // PGRST116 = row not found (usuário novo sem perfil ainda)
      console.error('Erro ao buscar perfil:', perfilError.message);
    }

    const plano    = perfil?.plano ?? 'trial';
    const isAdmin  = perfil?.is_admin === true;
    const limite   = LIMITES_PLANO[plano] ?? LIMITES_PLANO['trial'];

    // 3. Verificar e resetar contador mensal se necessário
    let pecasMes = perfil?.pecas_mes ?? 0;
    if (deveResetarMes(perfil?.pecas_mes_reset ?? null)) {
      pecasMes = 0;
      supabaseAdmin.from('gp_users').upsert({
        id: user.id,
        pecas_mes: 0,
        pecas_mes_reset: new Date().toISOString(),
      }, { onConflict: 'id' }).then(() => {}).catch(() => {});
    }

    // 4. Verificar limite mensal (admin bypass)
    if (!isAdmin && pecasMes >= limite) {
      return jsonResp({
        error: `Você atingiu o limite de ${limite} peças do seu plano este mês. Entre em contato para fazer upgrade.`,
        codigo: 'LIMITE_PLANO',
      }, 429);
    }

    // 5. Ler corpo da requisição
    const body = await req.json();
    const { modelo, system, messages, max_tokens = 8000, stream = true } = body;

    // 6. Validar modelo conforme plano
    const modelosPermitidos = MODELOS_PERMITIDOS[plano] ?? MODELOS_PERMITIDOS['trial'];
    const modeloSolicitado  = (modelo && MODELOS_ANTHROPIC[modelo]) ? modelo : 'avancado';

    // Se o modelo não é permitido no plano, usar o melhor disponível silenciosamente
    // (evita erro desnecessário — o usuário já não tem como selecionar Opus no trial via UI)
    const modeloFinal = modelosPermitidos.includes(modeloSolicitado)
      ? modeloSolicitado
      : 'avancado';  // fallback seguro disponível em todos os planos

    const modelId = MODELOS_ANTHROPIC[modeloFinal];

    // 7. Chamar Anthropic API
    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_KEY') ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: modelId, max_tokens, system, messages, stream }),
    });

    if (!anthropicResp.ok) {
      const errData = await anthropicResp.json().catch(() => ({}));
      const msg = (errData as Record<string,Record<string,string>>)?.error?.message
        ?? `Erro ${anthropicResp.status} na API.`;
      return jsonResp({ error: 'Erro ao chamar a IA: ' + msg }, anthropicResp.status);
    }

    // 8. Incrementar contador de peças (não bloqueante)
    supabaseAdmin.from('gp_users').upsert({
      id: user.id,
      pecas_mes: pecasMes + 1,
      pecas_mes_reset: deveResetarMes(perfil?.pecas_mes_reset ?? null)
        ? new Date().toISOString()
        : (perfil?.pecas_mes_reset ?? new Date().toISOString()),
    }, { onConflict: 'id' }).then(() => {}).catch(() => {});

    // 9. Repassar stream para o cliente
    return new Response(anthropicResp.body, {
      headers: {
        ...CORS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResp({ error: 'Erro ao chamar a IA: ' + msg }, 500);
  }
});
