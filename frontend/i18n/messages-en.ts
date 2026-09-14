import agents from '@/messages/en/agents.json';
import agentsChat from '@/messages/en/agentsChat.json';
import areas from '@/messages/en/areas.json';
import common from '@/messages/en/common.json';
import goals from '@/messages/en/goals.json';
import inbox from '@/messages/en/inbox.json';
import issueDetail from '@/messages/en/issueDetail.json';
import issueLists from '@/messages/en/issueLists.json';
import navigation from '@/messages/en/navigation.json';
import projects from '@/messages/en/projects.json';
import reviews from '@/messages/en/reviews.json';
import runtimes from '@/messages/en/runtimes.json';
import settings from '@/messages/en/settings.json';
import shell from '@/messages/en/shell.json';
import tasks from '@/messages/en/tasks.json';
import workspaceAdmin from '@/messages/en/workspaceAdmin.json';

/**
 * English is the source catalogue. Its shape types every `t()` call through
 * `AppConfig` in global.d.ts, so a missing key fails `next build` rather than
 * rendering as a raw key.
 */
const messages = {
   agents,
   agentsChat,
   areas,
   common,
   goals,
   inbox,
   issueDetail,
   issueLists,
   navigation,
   projects,
   reviews,
   runtimes,
   settings,
   shell,
   tasks,
   workspaceAdmin,
};

export default messages;
