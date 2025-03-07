import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Validate required environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    'Missing required environment variables. Please ensure SUPABASE_URL and SUPABASE_SERVICE_KEY are set in your .env file.'
  );
}

// Create Supabase client with service role key for admin access
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  },
  global: {
    headers: { 
      'x-application-name': 'interflow-node',
      // Add service role header to bypass RLS
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'apikey': supabaseServiceKey
    },
    // Configurações de timeout para melhorar a performance
    fetch: (url, options) => {
      const timeout = 30000; // 30 segundos de timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      return fetch(url, {
        ...options,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
    }
  },
  db: {
    schema: 'public'
  },
  // Configure realtime com parâmetros otimizados
  realtime: {
    params: {
      eventsPerSecond: 20, // Aumentado para permitir mais eventos por segundo
      heartbeatIntervalMs: 15000, // Intervalo de heartbeat otimizado
      timeout: 60000 // Timeout de 60 segundos para conexões realtime
    }
  },
  // Configurações de pool de conexões
  pool: {
    max: 10, // Máximo de conexões no pool
    min: 2,  // Mínimo de conexões no pool
    idleTimeoutMillis: 30000 // Tempo máximo que uma conexão pode ficar ociosa
  },
  // Configurações de retry para falhas de rede
  retry: {
    count: 3, // Número de tentativas
    delay: 1000 // Delay entre tentativas (ms)
  }
});

// Configuração de cache para consultas frequentes
const queryCache = new Map();
const CACHE_TTL = 60000; // 1 minuto de TTL para o cache

// Método auxiliar para consultas com cache
supabase.queryWithCache = async (query, params = {}, ttl = CACHE_TTL) => {
  const cacheKey = JSON.stringify({ query, params });
  
  // Verifica se existe no cache e se ainda é válido
  if (queryCache.has(cacheKey)) {
    const { data, timestamp } = queryCache.get(cacheKey);
    if (Date.now() - timestamp < ttl) {
      return data;
    }
  }
  
  // Executa a consulta
  const { data, error } = await query;
  
  if (error) {
    throw error;
  }
  
  // Armazena no cache
  queryCache.set(cacheKey, { data, timestamp: Date.now() });
  
  return data;
};

// Add realtime subscription for chat channels
// supabase 
//   .channel('chat_channels')
//   .on('postgres_changes', {
//     event: '*',
//     schema: 'public',
//     table: 'chat_channels'
//   }, (payload) => {
//     console.log('Chat channel changed:', payload);
//   })
//   .subscribe();

// Add error handler with improved logging and recovery
supabase.handleError = (error) => {
  console.error('Supabase error:', error.message, {
    code: error.code,
    details: error.details,
    hint: error.hint,
    stack: error.stack
  });
  
  // Check for specific error types
  if (error.code === 'PGRST116') {
    return null; // Return null for no rows
  }
  
  if (error.code === '42703') {
    throw new Error('Database schema mismatch. Column does not exist.');
  }
  
  // Tratamento de erros de conexão
  if (error.message && error.message.includes('network')) {
    console.warn('Erro de rede detectado, tentando reconectar...');
    // Lógica para reconexão pode ser implementada aqui
  }
  
  throw error;
};

// Função para limpar o cache periodicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, { timestamp }] of queryCache.entries()) {
    if (now - timestamp > CACHE_TTL) {
      queryCache.delete(key);
    }
  }
}, CACHE_TTL);