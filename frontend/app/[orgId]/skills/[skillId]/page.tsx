'use client';

import { useParams, useRouter } from 'next/navigation';

import SkillDetail from '@/components/common/skills/skill-detail';
import MainLayout from '@/components/layout/main-layout';
import { canEditProduct } from '@/lib/workspace-role';
import { useSessionStore } from '@/store/session-store';

/**
 * One skill on its own page.
 *
 * The catalogue opens a skill beside itself (`/skills?view=…`); this is the
 * same panel for a link straight to one, so a bookmark or a mention still
 * lands somewhere sensible.
 */
export default function SkillPage() {
   const { orgId, skillId } = useParams<{ orgId: string; skillId: string }>();
   const router = useRouter();
   const role = useSessionStore((state) => state.workspace?.role);

   return (
      <MainLayout>
         <SkillDetail
            skillId={skillId}
            canEdit={canEditProduct(role)}
            onClose={() => router.push(`/${orgId}/skills`)}
         />
      </MainLayout>
   );
}
