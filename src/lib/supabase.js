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
    }
  },
  db: {
    schema: 'public'
  },
  // Add request retries
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  },
  // Add custom fetch with timeout
  fetch: (url, options = {}) => {
    return fetch(url, {
      ...options,
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });
  }
});

// Add error handler
supabase.handleError = (error) => {
  console.error('Supabase error:', error);
  
  // Check for specific error types
  if (error.code === 'PGRST116') {
    return null; // Return null for no rows
  }
  
  if (error.code === '42703') {
    throw new Error('Database schema mismatch. Column does not exist.');
  }
  
  throw error;
};