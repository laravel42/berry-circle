'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
   Form,
   FormControl,
   FormField,
   FormItem,
   FormLabel,
   FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { acceptInvitation, createWorkspace, slugFromWorkspaceName } from '@/lib/workspaces';
import { zodFormResolver } from '@/lib/zod-resolver';

// Mirror the server bounds so a doomed submit never leaves the tab; the server
// stays the authority (it re-validates and lowercases the slug).
const createSchema = z.object({
   name: z
      .string()
      .min(1, 'Workspace name is required')
      .max(100, 'Name must be at most 100 characters'),
   description: z.string().max(5000, 'Description must be at most 5,000 characters').optional(),
});

// An invitation token is a fixed 53 characters (10-char prefix + 43-char
// secret); the server rejects any other shape, so we block it here too.
const joinSchema = z.object({
   invitationId: z.string().min(1, 'Invitation ID is required'),
   token: z.string().length(53, 'Invitation token is invalid'),
});

type CreateValues = z.infer<typeof createSchema>;
type JoinValues = z.infer<typeof joinSchema>;

const CREATE_ERROR = 'We could not create your workspace. Please try again.';
const SLUG_TAKEN_ERROR = 'That workspace name is already taken. Try a different one.';
const JOIN_ERROR = 'We could not accept that invitation. Check the details and try again.';
const JOIN_INVALID_ERROR = 'That invitation is invalid, expired, or already used.';

interface CreateOrJoinProps {
   /**
    * Called with the id of a workspace the user now belongs to (created or
    * joined). The parent refreshes session state and routes into it.
    */
   onEntered: (workspaceId: string) => Promise<void> | void;
}

/**
 * The no-membership step (Requirement 10.2). Two paths, never auto-run: create
 * a workspace or join one with an invitation. Each hands its workspace id up on
 * success; the parent owns the refresh-and-route so this component stays
 * presentational.
 */
export function CreateOrJoin({ onEntered }: CreateOrJoinProps) {
   const [createError, setCreateError] = useState<string | null>(null);
   const [joinError, setJoinError] = useState<string | null>(null);

   const createForm = useForm<CreateValues>({
      resolver: zodFormResolver(createSchema),
      defaultValues: { name: '', description: '' },
   });
   const joinForm = useForm<JoinValues>({
      resolver: zodFormResolver(joinSchema),
      defaultValues: { invitationId: '', token: '' },
   });

   const onCreate = async (values: CreateValues) => {
      setCreateError(null);
      try {
         const workspace = await createWorkspace({
            name: values.name.trim(),
            slug: slugFromWorkspaceName(values.name),
            description: values.description,
         });
         await onEntered(workspace.id);
      } catch (error) {
         if (error instanceof BerryApiError && error.status === 409) {
            setCreateError(SLUG_TAKEN_ERROR);
         } else {
            setCreateError(CREATE_ERROR);
         }
      }
   };

   const onJoin = async (values: JoinValues) => {
      setJoinError(null);
      try {
         const member = await acceptInvitation(values.invitationId.trim(), values.token.trim());
         await onEntered(member.workspaceId);
      } catch (error) {
         if (
            error instanceof BerryApiError &&
            (error.status === 404 || error.status === 409 || error.status === 410)
         ) {
            setJoinError(JOIN_INVALID_ERROR);
         } else {
            setJoinError(JOIN_ERROR);
         }
      }
   };

   return (
      <Tabs defaultValue="create" className="gap-4">
         <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="create">Create</TabsTrigger>
            <TabsTrigger value="join">Join</TabsTrigger>
         </TabsList>

         <TabsContent value="create">
            <Form {...createForm}>
               <form
                  onSubmit={createForm.handleSubmit(onCreate)}
                  className="grid gap-4"
                  noValidate
               >
                  <FormField
                     control={createForm.control}
                     name="name"
                     render={({ field }) => (
                        <FormItem>
                           <FormLabel>Workspace name</FormLabel>
                           <FormControl>
                              <Input placeholder="Acme" autoComplete="off" {...field} />
                           </FormControl>
                           <FormMessage />
                        </FormItem>
                     )}
                  />
                  <FormField
                     control={createForm.control}
                     name="description"
                     render={({ field }) => (
                        <FormItem>
                           <FormLabel>Description (optional)</FormLabel>
                           <FormControl>
                              <Textarea
                                 placeholder="What this workspace is for"
                                 {...field}
                              />
                           </FormControl>
                           <FormMessage />
                        </FormItem>
                     )}
                  />
                  {createError ? (
                     <p role="alert" className="text-destructive-foreground">
                        {createError}
                     </p>
                  ) : null}
                  <Button
                     type="submit"
                     className="w-full"
                     disabled={createForm.formState.isSubmitting}
                  >
                     {createForm.formState.isSubmitting ? 'Creating…' : 'Create workspace'}
                  </Button>
               </form>
            </Form>
         </TabsContent>

         <TabsContent value="join">
            <Form {...joinForm}>
               <form onSubmit={joinForm.handleSubmit(onJoin)} className="grid gap-4" noValidate>
                  <FormField
                     control={joinForm.control}
                     name="invitationId"
                     render={({ field }) => (
                        <FormItem>
                           <FormLabel>Invitation ID</FormLabel>
                           <FormControl>
                              <Input
                                 placeholder="Invitation ID from your invite"
                                 autoComplete="off"
                                 {...field}
                              />
                           </FormControl>
                           <FormMessage />
                        </FormItem>
                     )}
                  />
                  <FormField
                     control={joinForm.control}
                     name="token"
                     render={({ field }) => (
                        <FormItem>
                           <FormLabel>Invitation token</FormLabel>
                           <FormControl>
                              <Input
                                 placeholder="The token from your invite"
                                 autoComplete="off"
                                 {...field}
                              />
                           </FormControl>
                           <FormMessage />
                        </FormItem>
                     )}
                  />
                  {joinError ? (
                     <p role="alert" className="text-destructive-foreground">
                        {joinError}
                     </p>
                  ) : null}
                  <Button
                     type="submit"
                     className="w-full"
                     disabled={joinForm.formState.isSubmitting}
                  >
                     {joinForm.formState.isSubmitting ? 'Joining…' : 'Join workspace'}
                  </Button>
               </form>
            </Form>
         </TabsContent>
      </Tabs>
   );
}
