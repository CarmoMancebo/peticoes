-- v2.3 — Coluna ocupacao + RLS admin

-- 1. Adicionar coluna ocupacao (se ainda não existir)
ALTER TABLE gp_users
  ADD COLUMN IF NOT EXISTS ocupacao text;

-- 2. Função auxiliar (security definer) para verificar se o usuário logado é admin
--    Evita recursão nas políticas RLS
CREATE OR REPLACE FUNCTION gp_is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT is_admin FROM gp_users WHERE id = auth.uid()),
    false
  );
$$;

-- 3. Remover política de leitura existente e recriar permitindo admin ler tudo
DROP POLICY IF EXISTS "Usuário lê próprio perfil" ON gp_users;
DROP POLICY IF EXISTS "Users can view own profile" ON gp_users;
DROP POLICY IF EXISTS "gp_users_select_own" ON gp_users;

CREATE POLICY "gp_users_select"
  ON gp_users FOR SELECT
  USING (
    auth.uid() = id OR gp_is_admin()
  );

-- 4. Permitir admin atualizar qualquer linha (para o painel admin)
DROP POLICY IF EXISTS "gp_users_update_admin" ON gp_users;

CREATE POLICY "gp_users_update_admin"
  ON gp_users FOR UPDATE
  USING (
    auth.uid() = id OR gp_is_admin()
  );

-- 5. Definir is_admin = true para o proprietário da ferramenta
UPDATE gp_users
SET is_admin = true
WHERE email = 'carmo.mancebo@adv.oabsp.org.br';
