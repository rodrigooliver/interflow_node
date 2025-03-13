import { supabase } from '../lib/supabase.js';

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
    console.log(req.params)

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
    const formattedSubject = strings.subject.replace(['{organization}', '{name}'], [organization.name, fullName]);

    // URL para redirecionar após o aceite do convite
    const redirectUrl = process.env.FRONTEND_URL || null;
    const redirectToUrl = `${redirectUrl}/app/profile`;

    // 1. Enviar convite por email com dados personalizados
    const { data: authData, error: authError } = await supabase.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo: redirectToUrl,
        data: {
          organization_name: organization.name,
          organization_id: organizationId,
          role: role,
          invited_by: invitedBy,
          current_year: currentYear,
          // Adicionar frases para o template de email
          email_strings: {
            subject: formattedSubject,
            greeting: strings.greeting,
            inviteMessage: strings.inviteMessage,
            roleMessage: strings.roleMessage,
            instructions: strings.instructions,
            buttonText: strings.buttonText,
            footer: strings.footer,
            roleString: roleString
          }
        }
      }
    );

    if (authError) {
      if (authError.message === 'User already registered') {
        return res.status(400).json({ error: 'Usuário já registrado' });
      }
      throw authError;
    }

    if (!authData.user) {
      throw new Error('Falha ao convidar usuário');
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

