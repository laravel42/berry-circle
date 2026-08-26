import React from 'react';
import {
   MessageCircle,
   AtSign,
   UserPlus,
   GitPullRequest,
   RotateCcw,
   X,
   Edit,
   Plus,
   Upload,
   ShieldCheck,
   Target,
   Workflow,
   Sparkles,
} from 'lucide-react';
import { NotificationType } from '@/data/inbox';
import { cn } from '@/lib/utils';

export function getNotificationIcon(type: NotificationType, className?: string) {
   switch (type) {
      case 'comment':
         return <MessageCircle className={cn('text-blue-500', className)} />;
      case 'mention':
         return <AtSign className={cn('text-orange-500', className)} />;
      case 'assignment':
         return <UserPlus className={cn('text-green-500', className)} />;
      case 'status':
         return <GitPullRequest className={cn('text-purple-500', className)} />;
      case 'reopened':
         return <RotateCcw className={cn('text-yellow-500', className)} />;
      case 'closed':
         return <X className={cn('text-gray-500', className)} />;
      case 'edited':
         return <Edit className={cn('text-indigo-500', className)} />;
      case 'created':
         return <Plus className={cn('text-emerald-500', className)} />;
      case 'upload':
         return <Upload className={cn('text-pink-500', className)} />;
      case 'approval':
         return <ShieldCheck className={cn('text-status-warning', className)} />;
      case 'goal':
         return <Target className={cn('text-status-info', className)} />;
      case 'workflow':
         return <Workflow className={cn('text-status-info', className)} />;
      case 'plan':
         return <Sparkles className={cn('text-status-info', className)} />;
      default:
         return <MessageCircle className={cn('text-blue-500', className)} />;
   }
}
