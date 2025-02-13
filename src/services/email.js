import { supabase } from '../lib/supabase.js';
import { createChat } from './chat.js';
import { connect } from 'imap-simple';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

// Test email connection
export async function testEmailConnection(config) {
  let imapConnection;
  let smtpTransporter;

  try {
    // Test IMAP connection
    const imapConfig = {
      imap: {
        user: config.username,
        password: config.password,
        host: config.host,
        port: config.port,
        tls: config.secure,
        tlsOptions: { 
          rejectUnauthorized: false 
        }
      }
    };

    imapConnection = await connect(imapConfig);
    await imapConnection.openBox('INBOX');

    // Test SMTP connection
    smtpTransporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.smtpUsername,
        pass: config.smtpPassword
      },
      tlsOptions: {
        rejectUnauthorized: false // Tente mudar para `true` depois de testar
      }
    });

    await smtpTransporter.verify();

    return { success: true };
  } catch (error) {
    console.error('Error testing email connection:', error);
    return { 
      success: false, 
      error: error.message 
    };
  } finally {
    if (imapConnection) {
      imapConnection.end();
    }
    if (smtpTransporter) {
      smtpTransporter.close();
    }
  }
}

// Poll emails for all active email channels
export async function pollEmailChannels() {
  try {
    // Get all active email channels
    const { data: channels, error } = await supabase
      .from('chat_channels')
      .select('*, organization:organizations(id, name)')
      .eq('type', 'email')
      .eq('status', 'active');

    if (error) throw error;

    // Process each channel
    for (const channel of channels) {
      try {
        await processEmailChannel(channel);
      } catch (err) {
        console.error(`Error processing channel ${channel.id}:`, err);
      }
    }
  } catch (error) {
    console.error('Error polling email channels:', error);
  }
}

// Process emails for a single channel
async function processEmailChannel(channel) {
  const { credentials } = channel;
  if (!credentials?.host || !credentials?.username || !credentials?.password) {
    return;
  }

  const config = {
    imap: {
      user: credentials.username,
      password: credentials.password,
      host: credentials.host,
      port: credentials.port,
      tls: credentials.secure,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  let connection;
  try {
    // Connect to IMAP server
    connection = await connect(config);
    const box = await connection.openBox('INBOX');

    // Search for unread messages
    const searchCriteria = ['UNSEEN'];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: true
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    // Process each message
    for (const msg of messages) {
      try {
        const all = msg.parts.find(p => p.which === 'TEXT');
        const id = msg.attributes.uid;
        const idHeader = "Imap-Id: " + id + "\\r\\n";
        
        const email = await simpleParser(idHeader + all.body);

        // Create or update chat
        await handleIncomingEmail(channel, email);
      } catch (err) {
        console.error('Error processing email:', err);
      }
    }
  } catch (error) {
    console.error('Error connecting to email server:', error);
    throw error;
  } finally {
    if (connection) {
      connection.end();
    }
  }
}

// Handle incoming email
async function handleIncomingEmail(channel, email) {
  const { organization } = channel;
  
  try {
    // Check if customer exists
    let { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('organization_id', organization.id)
      .eq('email', email.from.value[0].address)
      .single();

    // Create customer if not exists
    if (!customer) {
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert({
          organization_id: organization.id,
          name: email.from.value[0].name || email.from.value[0].address,
          email: email.from.value[0].address
        })
        .select()
        .single();

      if (customerError) throw customerError;
      customer = newCustomer;
    }

    // Find existing chat or create new one
    let chat = await findExistingChat(channel.id, customer.id);
    
    if (!chat) {
      chat = await createChat({
        organization_id: organization.id,
        customer_id: customer.id,
        channel_id: channel.id,
        channel: 'email',
        email: customer.email,
        status: 'open'
      });
    }

    // Create message
    await supabase
      .from('messages')
      .insert({
        chat_id: chat.id,
        organization_id: organization.id,
        content: email.text || email.html,
        sender_type: 'customer',
        sender_id: customer.id,
        status: 'delivered'
      });

  } catch (error) {
    console.error('Error handling incoming email:', error);
    throw error;
  }
}

// Find existing open chat
async function findExistingChat(channelId, customerId) {
  const { data: chat } = await supabase
    .from('chats')
    .select('*')
    .eq('channel_id', channelId)
    .eq('customer_id', customerId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return chat;
}

// Send email reply
export async function sendEmailReply(chat, message) {
  try {
    const { data: channel } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', chat.channel_id)
      .single();

    if (!channel || channel.type !== 'email') {
      throw new Error('Invalid channel');
    }

    const { credentials } = channel;
    if (!credentials?.smtpHost || !credentials?.smtpUsername || !credentials?.smtpPassword) {
      throw new Error('Invalid SMTP credentials');
    }

    // Send email using nodemailer
    const transporter = nodemailer.createTransport({
      host: credentials.smtpHost,
      port: credentials.smtpPort,
      secure: credentials.smtpSecure,
      auth: {
        user: credentials.smtpUsername,
        pass: credentials.smtpPassword
      }
    });

    await transporter.sendMail({
      from: `"${credentials.fromName}" <${credentials.smtpUsername}>`,
      to: chat.email,
      subject: `Re: ${chat.subject || 'Your message'}`,
      text: message.content
    });

    // Update message status
    await supabase
      .from('messages')
      .update({ status: 'sent' })
      .eq('id', message.id);

  } catch (error) {
    console.error('Error sending email reply:', error);
    
    // Update message status to failed
    await supabase
      .from('messages')
      .update({ 
        status: 'failed',
        error_message: error.message
      })
      .eq('id', message.id);

    throw error;
  }
}