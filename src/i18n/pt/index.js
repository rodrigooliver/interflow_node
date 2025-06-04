import { transfer } from './chat/transfer.js';
import { collaborator } from './chat/collaborator.js';
import { schedule } from './schedule/index.js';
import { tasks } from './tasks/index.js';

export const pt = {
  chat: {
    transfer,
    collaborator
  },
  schedule,
  tasks
}; 