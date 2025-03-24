import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';

export async function createChat(data) {
  try {
    const { data: chat, error } = await supabase
      .from('chats')
      .insert([data])
      .select()
      .single();

    if (error) throw error;
    return chat;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}