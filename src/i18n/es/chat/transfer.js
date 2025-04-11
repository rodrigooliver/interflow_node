export const transfer = {
  errors: {
    required_fields: 'oldCustomerId y newCustomerId son obligatorios',
    same_team: 'No se puede transferir al mismo equipo',
    chat_not_found: 'Chat no encontrado',
    team_not_found: 'Equipo no encontrado',
    transfer_error: 'Error al transferir chats',
    team_transfer_error: 'Error al transferir chat al equipo',
    chat_not_active: 'Chat no está en progreso',
    leave_attendance_error: 'Error al salir del atendimiento',
    agent_not_found: 'Agente no encontrado',
    agent_not_in_team: 'El agente no pertenece al equipo',
    agent_transfer_error: 'Error al transferir chat al agente'
  },
  success: {
    chats_transferred: 'Chats transferidos con éxito',
    team_transferred: 'Chat transferido al equipo con éxito',
    leave_attendance: 'Atendimiento salido con éxito',
    agent_transferred: 'Chat transferido al agente con éxito'
  },
  notifications: {
    chat_available: 'Chat disponible',
    chat_awaiting_attendance: 'Chat aguardando atendimento',
    chat_assigned_to: 'Chat asignado a ti'
  }
}; 