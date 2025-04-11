export const transfer = {
  errors: {
    required_fields: 'oldCustomerId and newCustomerId are required',
    same_team: 'Cannot transfer to the same team',
    chat_not_found: 'Chat not found',
    team_not_found: 'Team not found',
    transfer_error: 'Error transferring chats',
    team_transfer_error: 'Error transferring chat to team',
    chat_not_active: 'Chat is not in progress',
    leave_attendance_error: 'Error leaving attendance',
    agent_not_found: 'Agent not found',
    agent_not_in_team: 'Agent does not belong to the team',
    agent_transfer_error: 'Error transferring chat to agent'
  },
  success: {
    chats_transferred: 'Chats transferred successfully',
    team_transferred: 'Chat transferred to team successfully',
    leave_attendance: 'Attendance left successfully',
    agent_transferred: 'Chat transferred to agent successfully'
  },
  notifications: {
    chat_available: 'Chat available',
    chat_awaiting_attendance: 'Chat awaiting attendance',
    chat_assigned_to: 'Chat assigned to you'
  }
}; 