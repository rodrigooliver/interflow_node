import { supabase } from '../lib/supabase.js';
import nodemailer from 'nodemailer';

// Configuração do serviço de email
const createTransporter = () => {
  // Verificar se as variáveis de ambiente necessárias estão definidas
  const { 
    EMAIL_HOST, 
    EMAIL_PORT, 
    EMAIL_USER, 
    EMAIL_PASSWORD,
    EMAIL_FROM
  } = process.env;

  // Verificar cada variável individualmente e logar quais estão faltando
  const missingVars = [];
  if (!EMAIL_HOST) missingVars.push('EMAIL_HOST');
  if (!EMAIL_PORT) missingVars.push('EMAIL_PORT');
  if (!EMAIL_USER) missingVars.push('EMAIL_USER');
  if (!EMAIL_PASSWORD) missingVars.push('EMAIL_PASSWORD');
  if (!EMAIL_FROM) missingVars.push('EMAIL_FROM');

  if (missingVars.length > 0) {
    console.warn(`Configuração de email incompleta. Variáveis ausentes: ${missingVars.join(', ')}. Usando serviço de email do Supabase.`);
    return null;
  }

  // Verificar se a porta está correta para SMTP
  const portNumber = parseInt(EMAIL_PORT);
  if (portNumber === 993 || portNumber === 143) {
    console.warn(`ATENÇÃO: A porta ${portNumber} é para IMAP, não para SMTP. Tentando porta 587 como alternativa.`);
    
    // Tentar usar a porta 587 como alternativa
    try {
      return nodemailer.createTransport({
        host: EMAIL_HOST,
        port: 587,
        secure: false, // false para TLS - porta 587
        auth: {
          user: EMAIL_USER,
          pass: EMAIL_PASSWORD,
        },
        tls: {
          rejectUnauthorized: false // Aceitar certificados auto-assinados
        }
      });
    } catch (error) {
      console.error('Erro ao criar transporter com porta alternativa:', error);
      return null;
    }
  }
  
  // Criar o transporter do nodemailer
  return nodemailer.createTransport({
    host: EMAIL_HOST,
    port: portNumber,
    secure: portNumber === 465, // true para porta 465, false para outras portas
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false // Aceitar certificados auto-assinados
    }
  });
};

// Função para enviar email
const sendEmail = async (to, subject, html) => {
  const transporter = createTransporter();
  
  // Se o transporter não foi criado, usar o serviço do Supabase
  if (!transporter) {
    const { data, error } = await supabase
      .from('emails')
      .insert([{ email: to, subject, html }]);
    
    if (error) {
      console.error('Erro ao enviar email pelo Supabase:', error);
      throw error;
    }
    return data;
  }

  // Enviar email usando nodemailer
  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (error) {
    console.error('Erro ao enviar email pelo SMTP:', error);
    
    // Tentar fallback para o Supabase em caso de erro no SMTP
    const { data, error: supabaseError } = await supabase
      .from('emails')
      .insert([{ email: to, subject, html }]);
    
    if (supabaseError) {
      console.error('Erro ao enviar email pelo Supabase (fallback):', supabaseError);
      throw supabaseError;
    }
    
    return data;
  }
};

// Frases para o template de email em diferentes idiomas
const emailTemplateStrings = {
  pt: {
    subject: "Convite para participar de {organization}",
    greeting: "Olá {name}",
    inviteMessage: "Você foi convidado para participar da organização",
    roleMessage: "Sua função será",
    instructions: "Clique no link abaixo para aceitar o convite e criar sua senha",
    buttonText: "Aceitar Convite",
    footer: "Se você não esperava este convite, pode ignorá-lo com segurança."
  },
  en: {
    subject: "Invitation to join {organization}",
    greeting: "Hello {name}",
    inviteMessage: "You have been invited to join the organization",
    roleMessage: "Your role will be",
    instructions: "Click the link below to accept the invitation and create your password",
    buttonText: "Accept Invitation",
    footer: "If you weren't expecting this invitation, you can safely ignore it."
  },
  es: {
    subject: "Invitación para unirte a {organization}",
    greeting: "Hola {name}",
    inviteMessage: "Has sido invitado a unirte a la organización",
    roleMessage: "Tu rol será",
    instructions: "Haz clic en el enlace de abajo para aceptar la invitación y crear tu contraseña",
    buttonText: "Aceptar Invitación",
    footer: "Si no esperabas esta invitación, puedes ignorarla de forma segura."
  }
};

// Tradução dos papéis
const roleTranslations = {
  pt: {
    admin: "Administrador",
    agent: "Agente",
    owner: "Proprietário",
    member: "Membro"
  },
  en: {
    admin: "Administrator",
    agent: "Agent",
    owner: "Owner",
    member: "Member"
  },
  es: {
    admin: "Administrador",
    agent: "Agente",
    owner: "Propietario",
    member: "Miembro"
  }
};

export const updateMember = async (req, res) => {
  try {
  const { id } = req.params;
    const { fullName, email, avatarUrl, whatsapp } = req.body;
    // console.log(req.params)

    // 1. Primeiro, buscar o perfil atual para verificar se o email mudou
    const { data: currentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', id)
      .single();

    if (profileError) {
      throw profileError;
    }

    // 2. Se o email mudou, atualizar no auth
    if (email !== currentProfile.email) {
      const { error: authError } = await supabase.auth.admin.updateUserById(
        id,
        { email: email }
      );

      if (authError) {
        throw authError;
      }
    }

    // 3. Atualizar perfil
    const { data, error } = await supabase
      .from('profiles')
      .update({
        full_name: fullName,
        email: email,
        avatar_url: avatarUrl,
        whatsapp: whatsapp
      })
      .eq('id', id)
      .select();

    if (error) {
      throw error;
    }

    res.status(200).json({ success: true, profile: data[0] });
  } catch (error) {
    console.error('Erro ao atualizar membro:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

export const inviteMember = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { email, fullName, role, language = 'pt' } = req.body;
    const invitedBy = req.profileId; // ID do usuário que está fazendo o convite
    
    // Obter o ano atual
    const currentYear = new Date().getFullYear();

    // Verificar se o idioma é suportado, caso contrário usar português
    const lang = ['pt', 'en', 'es'].includes(language) ? language : 'pt';
    
    // Obter as frases para o template de email no idioma selecionado
    const strings = emailTemplateStrings[lang];
    const roleString = roleTranslations[lang][role] || role;

    // Buscar o nome da organização para incluir no convite
    const { data: organization, error: organizationError } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', organizationId)
        .single();

    if (organizationError) {
      throw organizationError;
    }

    // Formatar o assunto do email substituindo {organization} pelo nome da organização
    const formattedSubject = strings.subject.replace('{organization}', organization.name);
    const formattedGreeting = strings.greeting.replace('{name}', fullName);
    // URL para redirecionar após o aceite do convite
    const redirectUrl = process.env.FRONTEND_URL || 'https://app.interflow.ai';
    const redirectToUrl = `${redirectUrl}/app/profile`;

    // Verificar se o usuário já existe
    const { data: existingUser, error: userError } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .single();

    // console.log(existingUser, userError)

    if (userError && userError.code !== 'PGRST116') { // PGRST116 = not found
      throw userError;
    }

    // Se o usuário já existe, verificar se já está vinculado à organização
    if (existingUser) {
     
      const { data: existingMember, error: memberError } = await supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('user_id', existingUser.id)
        .maybeSingle();

      if (memberError && memberError.code !== 'PGRST116') { // PGRST116 = not found
        throw memberError;
      }

      // Se o usuário já está vinculado à organização, retornar erro
      if (existingMember) {
        return res.status(400).json({ error: 'Usuário já é membro desta organização' });
      }

      // Se o usuário existe mas não está vinculado à organização, criar um token seguro
      // para vincular o usuário à organização
      const token = Buffer.from(JSON.stringify({
        userId: existingUser.id,
        organizationId,
        role,
        exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // 7 dias de expiração
      })).toString('base64');

      const linkUrl = `${redirectUrl}/join?token=${token}`;

      // Preparar o conteúdo do email
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
          <h2>${formattedGreeting}</h2>
          <p>${strings.inviteMessage} <strong>${organization.name}</strong>.</p>
          <p>${strings.roleMessage} <strong>${roleString}</strong>.</p>
          <p>${strings.instructions}</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${linkUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
              ${strings.buttonText}
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">${strings.footer}</p>
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px; text-align: center;">
            &copy; ${currentYear} ${organization.name}
          </div>
        </div>
      `;

      // Enviar email personalizado para o usuário existente
      try {
        await sendEmail(email, formattedSubject, emailHtml);
      } catch (emailError) {
        console.error('Erro ao enviar email:', emailError);
        throw new Error('Falha ao enviar email de convite');
      }

      // Adicionar à organização
      const { error: addMemberError } = await supabase
        .from('organization_members')
        .insert([
          {
            organization_id: organizationId,
            user_id: existingUser.id,
            profile_id: existingUser.id,
            role: role,
            status: 'pending'
          },
        ]);

      if (addMemberError) {
        throw addMemberError;
      }

      return res.status(201).json({ success: true, user: existingUser });
    }

    // Se o usuário não existe, criar um novo usuário e enviar convite por email
    // Gerar uma senha temporária aleatória
    const tempPassword = Math.random().toString(36).slice(-10);
    
    // Criar o usuário no Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        organization_id: organizationId,
        role: role
      },
      app_metadata: {
        provider: 'email'
      }
    });

    if (authError) {
      if (authError.message === 'User already registered') {
        return res.status(400).json({ error: 'Usuário já registrado' });
      }
      throw authError;
    }

    if (!authData.user) {
      throw new Error('Falha ao criar usuário');
    }

    // Gerar um token de redefinição de senha
    const { data: passwordResetData, error: passwordResetError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: {
        redirectTo: redirectToUrl
      }
    });

    if (passwordResetError) {
      throw passwordResetError;
    }

    // Extrair o link de redefinição de senha
    const resetLink = passwordResetData.properties.action_link;

    // Preparar o conteúdo do email
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <h2>${formattedGreeting}</h2>
        <p>${strings.inviteMessage} <strong>${organization.name}</strong>.</p>
        <p>${strings.roleMessage} <strong>${roleString}</strong>.</p>
        <p>${strings.instructions}</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
            ${strings.buttonText}
          </a>
        </div>
        <p style="color: #666; font-size: 14px;">${strings.footer}</p>
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px; text-align: center;">
          &copy; ${currentYear} ${organization.name}
        </div>
      </div>
    `;

    // Enviar email personalizado para o novo usuário
    try {
      await sendEmail(email, formattedSubject, emailHtml);
    } catch (emailError) {
      console.error('Erro ao enviar email:', emailError);
      throw new Error('Falha ao enviar email de convite');
    }

    // 2. Criar perfil
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .insert([
        {
          id: authData.user.id,
          email: email,
          full_name: fullName,
          role: role,
          is_superadmin: false,
        },
      ]);

    if (profileError) {
      throw profileError;
    }

    // 3. Adicionar à organização
    const { error: memberError } = await supabase
      .from('organization_members')
      .insert([
        {
          organization_id: organizationId,
          user_id: authData.user.id,
          profile_id: authData.user.id,
          role: role,
          status: 'pending'
        },
      ]);

    if (memberError) {
      throw memberError;
    }

    res.status(201).json({ success: true, user: authData.user });
  } catch (error) {
    console.error('Erro ao convidar membro:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

export const joinOrganization = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { userId, role } = req.body;
    
    // Verificar se o usuário existe
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('id', userId)
      .single();

    if (userError) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Verificar se o usuário já é membro da organização
    const { data: existingMember, error: memberError } = await supabase
      .from('organization_members')
      .select('id, status')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .single();

    if (memberError && memberError.code !== 'PGRST116') { // PGRST116 = not found
      throw memberError;
    }

    // Se o usuário já é membro ativo da organização, retornar sucesso
    if (existingMember && existingMember.status === 'active') {
      return res.status(200).json({ success: true, message: 'Usuário já é membro desta organização' });
    }

    // Se o usuário tem um convite pendente, atualizar o status para ativo
    if (existingMember && existingMember.status === 'pending') {
      const { error: updateError } = await supabase
        .from('organization_members')
        .update({ status: 'active' })
        .eq('id', existingMember.id);

      if (updateError) {
        throw updateError;
      }
      
      return res.status(200).json({ success: true, message: 'Convite aceito com sucesso' });
    }

    
    res.status(404).json({ success: false, message: 'Convite não encontrado' });
  } catch (error) {
    console.error('Erro ao adicionar usuário à organização:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

// Função para testar a conexão de email
export const testEmailConnection = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email de teste não fornecido' });
    }
    
    // Verificar se as variáveis de ambiente necessárias estão definidas
    const { 
      EMAIL_HOST, 
      EMAIL_PORT, 
      EMAIL_USER, 
      EMAIL_PASSWORD,
      EMAIL_FROM
    } = process.env;
    
    // Verificar cada variável individualmente
    const missingVars = [];
    if (!EMAIL_HOST) missingVars.push('EMAIL_HOST');
    if (!EMAIL_PORT) missingVars.push('EMAIL_PORT');
    if (!EMAIL_USER) missingVars.push('EMAIL_USER');
    if (!EMAIL_PASSWORD) missingVars.push('EMAIL_PASSWORD');
    if (!EMAIL_FROM) missingVars.push('EMAIL_FROM');
    
    // Se alguma variável estiver faltando, retornar erro
    if (missingVars.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Configuração de email incompleta. Variáveis ausentes: ${missingVars.join(', ')}`,
        missingVars,
        usingSupabase: true
      });
    }
    
    // Verificar se a porta está correta para SMTP
    const portNumber = parseInt(EMAIL_PORT);
    const isImapPort = portNumber === 993 || portNumber === 143;
    
    // Tentar criar o transporter com a configuração atual
    try {
      const transporter = nodemailer.createTransport({
        host: EMAIL_HOST,
        port: portNumber,
        secure: portNumber === 465,
        auth: {
          user: EMAIL_USER,
          pass: EMAIL_PASSWORD,
        },
        tls: {
          rejectUnauthorized: false // Aceitar certificados auto-assinados
        }
      });
      
      // Verificar a conexão
      try {
        await transporter.verify();
      } catch (verifyError) {
        // Se a porta atual é IMAP, tentar com porta SMTP alternativa
        if (isImapPort) {
          // Tentar porta 587 (TLS)
          try {
            const alternativeTransporter = nodemailer.createTransport({
              host: EMAIL_HOST,
              port: 587,
              secure: false,
              auth: {
                user: EMAIL_USER,
                pass: EMAIL_PASSWORD,
              },
              tls: {
                rejectUnauthorized: false
              }
            });
            
            await alternativeTransporter.verify();
            
            // Atualizar o transporter para usar a porta que funcionou
            transporter.options.port = 587;
            transporter.options.secure = false;
          } catch (altError) {
            // Tentar porta 465 (SSL)
            try {
              const sslTransporter = nodemailer.createTransport({
                host: EMAIL_HOST,
                port: 465,
                secure: true,
                auth: {
                  user: EMAIL_USER,
                  pass: EMAIL_PASSWORD,
                },
                tls: {
                  rejectUnauthorized: false
                }
              });
              
              await sslTransporter.verify();
              
              // Atualizar o transporter para usar a porta que funcionou
              transporter.options.port = 465;
              transporter.options.secure = true;
            } catch (sslError) {
              throw new Error(`Não foi possível conectar ao servidor SMTP. Tentativas em portas 587 e 465 falharam. Erro original: ${verifyError.message}`);
            }
          }
        } else {
          throw verifyError;
        }
      }
      
      // Enviar email de teste
      const mailOptions = {
        from: EMAIL_FROM,
        to: email,
        subject: 'Teste de Conexão de Email - Interflow',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
            <h2>Teste de Conexão de Email</h2>
            <p>Este é um email de teste para verificar se a configuração do servidor SMTP está funcionando corretamente.</p>
            <p><strong>Detalhes da configuração:</strong></p>
            <ul>
              <li>Host: ${EMAIL_HOST}</li>
              <li>Porta: ${transporter.options.port}</li>
              <li>Seguro: ${transporter.options.secure ? 'Sim' : 'Não'}</li>
              <li>Usuário: ${EMAIL_USER}</li>
              <li>Remetente: ${EMAIL_FROM}</li>
            </ul>
            <p>Se você recebeu este email, a configuração está funcionando corretamente!</p>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px; text-align: center;">
              &copy; ${new Date().getFullYear()} Interflow
            </div>
          </div>
        `
      };
      
      const info = await transporter.sendMail(mailOptions);
      
      // Verificar se a porta usada é diferente da configurada
      const portWarning = transporter.options.port !== portNumber 
        ? `ATENÇÃO: A porta ${portNumber} configurada no .env não funcionou. Usando porta ${transporter.options.port} em vez disso.` 
        : null;
      
      res.status(200).json({ 
        success: true, 
        message: 'Conexão de email testada com sucesso', 
        messageId: info.messageId,
        config: {
          host: EMAIL_HOST,
          port: transporter.options.port,
          secure: transporter.options.secure,
          user: EMAIL_USER,
          from: EMAIL_FROM
        },
        portWarning
      });
    } catch (error) {
      console.error('Erro ao testar conexão de email:', error);
      
      // Verificar se é um erro de timeout
      const isTimeout = error.message.includes('ETIMEDOUT') || error.message.includes('timeout');
      let sugestao = '';
      
      if (isTimeout) {
        sugestao = 'O servidor não respondeu a tempo. Verifique se o host está correto e se não há bloqueios de firewall.';
        
        if (isImapPort) {
          sugestao += ' Você está usando uma porta IMAP (993/143) para SMTP. Tente usar as portas 587 ou 465 para SMTP.';
        }
      } else if (error.message.includes('certificate')) {
        sugestao = 'Há um problema com o certificado SSL do servidor. Verifique se o certificado é válido ou considere usar a opção TLS.';
      } else if (error.message.includes('authentication')) {
        sugestao = 'Falha na autenticação. Verifique se o usuário e senha estão corretos.';
      }
      
      res.status(500).json({ 
        success: false, 
        error: `Erro ao testar conexão de email: ${error.message}`,
        details: error.toString(),
        sugestao
      });
    }
  } catch (error) {
    console.error('Erro ao testar conexão de email:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

