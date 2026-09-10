import type { Queryable } from '../db/pool.ts';

/**
 * What a squad leader is told on top of its task.
 *
 * Only on an issue the squad owns, and only for the leader: a member working
 * a delegated sub-issue is doing one task, not running the squad.
 */
export async function squadBriefing(sql: Queryable, issueId: string): Promise<string | null> {
   const [squad] = await sql`
      SELECT s.id, s.name, s.description FROM issue_squads i
        JOIN squads s ON s.id = i.squad_id AND s.archived_at IS NULL
       WHERE i.issue_id = ${issueId}`;
   if (!squad) return null;
   const members = await sql`
      SELECT m.member_type, m.member_id, m.role, COALESCE(a.name, u.name, '') AS name
        FROM squad_members m
        LEFT JOIN agents a ON m.member_type = 'agent' AND a.id = m.member_id
        LEFT JOIN users u ON m.member_type = 'user' AND u.id = m.member_id
       WHERE m.squad_id = ${squad.id as string}
       ORDER BY m.member_type, name`;
   const roster = members
      .map(
         (member) =>
            `- ${member.name as string} (${member.member_type as string}, ${member.role as string}) id=${member.member_id as string}`
      )
      .join('\n');
   const description = squad.description ? ` ${squad.description as string}` : '';
   return [
      `You lead the squad "${squad.name as string}".${description}`,
      'Members:',
      roster || '- (no members yet)',
      'Decide what each agent member should do. Delegate a piece of work by calling the ' +
         'delegate_to_member tool with the member id, a title and a description; it creates a ' +
         'sub-issue assigned to that member. You will be woken again when a member finishes. ' +
         'People are listed so you can mention them; do not delegate to them. When everything ' +
         'is done, report the combined result.',
   ].join('\n');
}
