import { Suspense } from 'react';

import { Chat } from '@/components/common/chat/chat';

// `Chat` reads the query string, which Next requires to sit under a Suspense
// boundary so the rest of the page can still prerender.
export default function ChatPage() {
   return (
      <Suspense fallback={null}>
         <Chat />
      </Suspense>
   );
}
