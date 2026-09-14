import MainLayout from '@/components/layout/main-layout';
import { AttachmentPreviewPage } from '@/components/layout/attachments/attachment-preview-page';

/**
 * `/{orgId}/attachments/{id}/preview` — one file, on a page of its own.
 *
 * The id is all the link carries, which is why the client component fetches
 * the attachment rather than being handed it: this page is reached from a copy
 * of a link as often as from the modal.
 */
export default async function AttachmentPreviewRoute({
   params,
}: {
   params: Promise<{ orgId: string; id: string }>;
}) {
   const { id } = await params;
   return (
      <MainLayout>
         <AttachmentPreviewPage attachmentId={id} />
      </MainLayout>
   );
}
