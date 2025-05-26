import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import dotenv from 'dotenv';
import Sentry from '../lib/sentry.js';

// Load environment variables from .env file
dotenv.config();

// Cache para armazenar hashes de API keys válidas
const apiKeyCache = new Map();

// Cache para armazenar tokens válidos
const tokenCache = new Map();

// Limpa o cache periodicamente (a cada 1 hora)
setInterval(() => {
  const now = new Date();
  for (const [key, value] of apiKeyCache.entries()) {
    if (value.expiresAt && value.expiresAt < now) {
      apiKeyCache.delete(key);
    }
  }
}, 60 * 60 * 1000);

// Função para validar API key
async function validateApiKey(apiKey) {
  // Verifica se a key está no cache
  const cached = apiKeyCache.get(apiKey);
  if (cached) {
    if (!cached.expiresAt || cached.expiresAt > new Date()) {
      return cached.organizationId;
    }
    apiKeyCache.delete(apiKey);
  }

  // Hash da API key
  const keyHash = crypto
    .createHash('sha256')
    .update(apiKey)
    .digest('hex');

  // Busca no banco
  const { data: apiKeyData, error } = await supabase
    .from('api_keys')
    .select('organization_id, expires_at')
    .eq('key_hash', keyHash)
    .eq('is_active', true)
    .single();

  if (error || !apiKeyData) return null;

  // Atualiza o cache
  apiKeyCache.set(apiKey, {
    organizationId: apiKeyData.organization_id,
    expiresAt: apiKeyData.expires_at ? new Date(apiKeyData.expires_at) : undefined
  });

  return apiKeyData.organization_id;
}

// Função para validar token JWT do Supabase
async function validateSupabaseToken(token) {
  // Verifica cache primeiro
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  try {
    // Verifica o token usando a API do Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error) throw error;
    
    // Armazena no cache por 5 minutos
    tokenCache.set(token, {
      user,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    return user;
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        location: 'validateSupabaseToken'
      }
    });
    console.error('Token validation error:', error);
    return null;
  }
}

// Middleware para rotas públicas (webhook)
export async function verifyPublicAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    const keyHash = crypto
      .createHash('sha256')
      .update(apiKey)
      .digest('hex');

    const { data: apiKeyData } = await supabase
      .from('api_keys')
      .select('organization_id, profile_id')
      .eq('key_hash', keyHash)
      .eq('is_active', true)
      .single();

    if (!apiKeyData) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.organizationId = req.params.organizationId;
    req.profileId = apiKeyData.profile_id;
    next();
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        location: 'verifyPublicAuth',
        organizationId: req.params.organizationId
      }
    });
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Middleware para rotas privadas (requer autenticação)
export async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];
  const organizationId = req.params.organizationId;

  if (!authHeader && !apiKey) {
    return res.status(401).json({ error: 'No authorization header or API key' });
  }

  if (!organizationId) {
    return res.status(400).json({ error: 'Organization ID is required' });
  }

  try {
    if (apiKey) {
      // Lógica para API keys
      const keyHash = crypto
        .createHash('sha256')
        .update(apiKey)
        .digest('hex');

      const { data: apiKeyData } = await supabase
        .from('api_keys')
        .select('organization_id, profile_id, organization:organizations(settings, usage), profiles(is_superadmin)')
        .eq('key_hash', keyHash)
        .eq('is_active', true)
        .single();

      if (!apiKeyData) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      // Verifica se a API key pertence à organização OU se o perfil é superadmin
      if (apiKeyData.organization_id !== organizationId && !apiKeyData.profiles?.is_superadmin) {
        return res.status(403).json({ error: 'API key does not have access to this organization' });
      }

      req.organizationId = organizationId;
      req.profileId = apiKeyData.profile_id;
      req.is_superadmin = apiKeyData.profiles?.is_superadmin || false;
      req.usage = apiKeyData.organization?.usage || null;
      
      // Se a API key é de superadmin mas não da organização específica, busca as configurações da organização
      if (apiKeyData.profiles?.is_superadmin && apiKeyData.organization_id !== organizationId) {
        const { data: organization } = await supabase
          .from('organizations')
          .select('settings')
          .eq('id', organizationId)
          .single();
        req.language = req.language ?? organization?.settings?.language ?? 'pt';
      } else {
        req.language = req.language ?? apiKeyData.organization?.settings?.language ?? 'pt';
      }
    } else {
      // Validação do token JWT do Supabase
      const token = authHeader.replace('Bearer ', '');
      const user = await validateSupabaseToken(token);

      if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      try {
        // Primeiro verifica se o usuário é superadmin
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, is_superadmin')
          .eq('id', user.id)
          .single();

        if (profileError || !profile) {
          return res.status(403).json({ error: 'User profile not found' });
        }

        // Se é superadmin, tem acesso a todas as organizações
        if (profile.is_superadmin) {
          // Busca as configurações da organização para o idioma
          const { data: organization } = await supabase
            .from('organizations')
            .select('settings, usage')
            .eq('id', organizationId)
            .single();

          req.profileId = user.id;
          req.organizationId = organizationId;
          req.language = req.language ?? organization?.settings?.language ?? 'pt';
          req.is_superadmin = true;
          req.usage = organization?.usage || null;
        } else {
          // Se não é superadmin, verifica se é membro da organização
          const { data: membership, error: membershipError } = await supabase
            .from('organization_members')
            .select('organization_id, organization:organizations(settings, usage)')
            .eq('profile_id', user.id)
            .eq('organization_id', organizationId)
            .single();

          if (membershipError || !membership) {
            console.log(membershipError);
            return res.status(403).json({ error: 'User does not have access to this organization' });
          }

          req.profileId = user.id;
          req.organizationId = organizationId;
          req.language = req.language ?? membership.organization?.settings?.language ?? 'pt';
          req.is_superadmin = false;
          req.usage = membership.organization?.usage || null;
        }
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            location: 'verifyAuth_access_check',
            organizationId,
            userId: user.id
          }
        });
        console.error('Error checking organization access:', error);
        return res.status(401).json({ error: 'Error checking organization access' });
      }
    }

    next();
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        location: 'verifyAuth',
        organizationId,
        hasApiKey: !!apiKey,
        hasAuthHeader: !!authHeader
      }
    });
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Middleware para rotas privadas que requerem superadmin
export async function verifyAuthSuperAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];

  if (!authHeader && !apiKey) {
    return res.status(401).json({ error: 'No authorization header or API key' });
  }

  try {
    if (apiKey) {
      // Validação via API Key
      const keyHash = crypto
        .createHash('sha256')
        .update(apiKey)
        .digest('hex');

      const { data: apiKeyData } = await supabase
        .from('api_keys')
        .select('profile_id, profiles(is_superadmin)')
        .eq('key_hash', keyHash)
        .eq('is_active', true)
        .single();

      if (!apiKeyData || !apiKeyData.profiles?.is_superadmin) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      req.profileId = apiKeyData.profile_id;
    } else {
      // Validação via token JWT
      const token = authHeader.replace('Bearer ', '');
      const user = await validateSupabaseToken(token);

      if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      try {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, is_superadmin')
          .eq('id', user.id)
          .single();

        if (profileError || !profile) {
          return res.status(403).json({ error: 'User profile not found' });
        }

        if (!profile.is_superadmin) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }

        req.profileId = user.id;
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            location: 'verifyAuthSuperAdmin_profile_check',
            userId: user.id
          }
        });
        console.error('Error checking superadmin access:', error);
        return res.status(401).json({ error: 'Error checking superadmin access' });
      }
    }

    next();
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        location: 'verifyAuthSuperAdmin',
        hasApiKey: !!apiKey,
        hasAuthHeader: !!authHeader
      }
    });
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Middleware para rotas de perfil (não requer organização)
export async function verifyAuthProfile(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];

  if (!authHeader && !apiKey) {
    return res.status(401).json({ error: 'No authorization header or API key' });
  }

  try {
    if (apiKey) {
      // Validação via API Key
      const keyHash = crypto
        .createHash('sha256')
        .update(apiKey)
        .digest('hex');

      const { data: apiKeyData } = await supabase
        .from('api_keys')
        .select('profile_id')
        .eq('key_hash', keyHash)
        .eq('is_active', true)
        .single();

      if (!apiKeyData) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      req.profileId = apiKeyData.profile_id;
    } else {
      // Validação via token JWT
      const token = authHeader.replace('Bearer ', '');
      const user = await validateSupabaseToken(token);

      if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      req.profileId = user.id;
    }

    next();
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        location: 'verifyAuthProfile',
        hasApiKey: !!apiKey,
        hasAuthHeader: !!authHeader
      }
    });
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}