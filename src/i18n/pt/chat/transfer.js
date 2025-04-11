export const transfer = {
  errors: {
    required_fields: 'oldCustomerId e newCustomerId são obrigatórios',
    same_team: 'Não é possível transferir para a mesma equipe',
    chat_not_found: 'Chat não encontrado',
    team_not_found: 'Equipe não encontrada',
    transfer_error: 'Erro ao transferir chats',
    team_transfer_error: 'Erro ao transferir chat para equipe',
    chat_not_active: 'Chat não está em andamento',
    leave_attendance_error: 'Erro ao sair do atendimento',
    agent_not_found: 'Agente não encontrado',
    agent_not_in_team: 'O agente não pertence à equipe',
    agent_transfer_error: 'Erro ao transferir chat para o agente'
  },
  success: {
    chats_transferred: 'Chats transferidos com sucesso',
    team_transferred: 'Chat transferido para a equipe com sucesso',
    leave_attendance: 'Atendimento saído com sucesso',
    agent_transferred: 'Chat transferido para o agente com sucesso'
  },
  notifications: {
    chat_available: 'Atendimento disponível',
    chat_awaiting_attendance: 'Atendimento aguardando em',
    chat_assigned_to: 'Atendimento atribuído a você'
  }
}; 