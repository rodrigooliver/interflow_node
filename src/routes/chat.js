import express from 'express';
import Sentry from '../lib/sentry.js';
import { verifyAuth } from '../middleware/auth.js';
import { createMessageRoute, deleteMessageRoute } from '../controllers/chat/message-handlers.js';
import { validateWapiNumberRoute } from '../controllers/channels/wapi.js';
import { sendWhatsAppTemplateRoute } from '../controllers/channels/whatsapp-official.js';
import { transferAllChatsCustomerRoute, transferChatToCustomerRoute, transferToTeamRoute, leaveAttendanceRoute, transferToAgentRoute } from '../controllers/chat/transfer-handlers.js';
import { resolveChatRoute } from '../controllers/chat/resolve-handlers.js';
import { startFlowRoute } from '../controllers/chat/flow-handlers.js';
import { deleteChatRoute } from '../controllers/chat/delete-handlers.js';
import { generateTaskContentRoute } from '../controllers/chat/task-handlers.js';
import { addCollaboratorRoute, removeCollaboratorRoute, listCollaboratorsRoute } from '../controllers/chat/collaborator-handlers.js';
const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

router.post('/validate-wapi-number', validateWapiNumberRoute);
router.post('/transfer-all-chats-customer', transferAllChatsCustomerRoute);
router.post('/:chatId/transfer-to-customer', transferChatToCustomerRoute);
router.post('/:chatId/transfer-to-team', transferToTeamRoute);
router.post('/:chatId/transfer-to-agent', transferToAgentRoute);
router.post('/:chatId/leave-attendance', leaveAttendanceRoute);
router.post('/:chatId/message', createMessageRoute);
router.delete('/:chatId', deleteChatRoute);
router.delete('/:chatId/message/:messageId', deleteMessageRoute);
router.post('/:chatId/send-template', sendWhatsAppTemplateRoute);
router.post('/:chatId/generate-summary', resolveChatRoute);
router.post('/:chatId/generate-task-content', generateTaskContentRoute);
router.post('/:chatId/start-flow', startFlowRoute);

// Rotas de colaboradores
router.post('/:chatId/collaborators', addCollaboratorRoute);
router.get('/:chatId/collaborators', listCollaboratorsRoute);
router.delete('/:chatId/collaborators/:collaboratorId', removeCollaboratorRoute);

export default router;