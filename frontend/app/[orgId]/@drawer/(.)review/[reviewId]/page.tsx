'use client';

import { useParams } from 'next/navigation';

import { ReviewDetail } from '@/components/common/reviews/review-detail';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';

export default function ReviewOverviewDrawerPage() {
   const { reviewId } = useParams<{ orgId: string; reviewId: string }>();

   return (
      <DetailDrawerShell>
         <ReviewDetail reviewId={reviewId} section="overview" />
      </DetailDrawerShell>
   );
}
