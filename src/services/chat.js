import { supabase } from '../lib/supabase.js';

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
    console.error('Error creating chat:', error);
    throw error;
  }
}