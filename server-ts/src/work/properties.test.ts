import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   InvalidPropertyValue,
   PropertyNameTaken,
   archiveProperty,
   createProperty,
   listValues,
   propertyCreateSchema,
   setValue,
} from './properties.ts';
import { MetadataTooLarge, patchMetadata, readMetadata } from './metadata.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('custom properties', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'props');
      other = await seedWorld(sql, 'props-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('a select without options is refused by the schema', () => {
      assert.equal(propertyCreateSchema.safeParse({ name: 'Size', kind: 'select' }).success, false);
      assert.equal(
         propertyCreateSchema.safeParse({ name: 'Notes', kind: 'text', options: [] }).success,
         false
      );
   });

   test('a property name is unique per workspace, ignoring case', async () => {
      await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Effort', kind: 'number' }));
      await assert.rejects(
         createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'effort', kind: 'text' })),
         PropertyNameTaken
      );
   });

   test('a select value must be one of its options', async () => {
      const size = await createProperty(
         sql,
         world.workspaceId,
         world.ownerId,
         propertyCreateSchema.parse({
            name: 'Size',
            kind: 'select',
            options: [
               { id: 's', name: 'Small', color: '#111111' },
               { id: 'l', name: 'Large', color: '#222222' },
            ],
         })
      );
      await setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: size.id, value: 's', actorId: world.ownerId });
      await assert.rejects(
         setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: size.id, value: 'xl', actorId: world.ownerId }),
         InvalidPropertyValue
      );
      const values = await listValues(sql, world.workspaceId, world.issueId);
      assert.deepEqual(values.find((entry) => entry.propertyId === size.id)?.value, 's');
   });

   test('a person must belong to the workspace', async () => {
      const owner = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Owner', kind: 'person' }));
      await setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: owner.id, value: { type: 'user', id: world.memberId }, actorId: world.ownerId });
      await assert.rejects(
         setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: owner.id, value: { type: 'user', id: other.ownerId }, actorId: world.ownerId }),
         InvalidPropertyValue
      );
   });

   test('an archived property drops out of an issue\'s values', async () => {
      const flag = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Flag', kind: 'boolean' }));
      await setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: flag.id, value: true, actorId: world.ownerId });
      assert.equal(await archiveProperty(sql, world.workspaceId, flag.id), true);
      const values = await listValues(sql, world.workspaceId, world.issueId);
      assert.equal(values.some((entry) => entry.propertyId === flag.id), false);
   });

   test('metadata merges, removes, and refuses more than fifty keys', async () => {
      await patchMetadata(sql, world.issueId, { set: { 'ci.run': 42, owner: 'ada' } });
      await patchMetadata(sql, world.issueId, { remove: ['owner'] });
      assert.deepEqual(await readMetadata(sql, world.issueId), { 'ci.run': 42 });
      const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, index]));
      await assert.rejects(
         sql.begin((tx) => patchMetadata(tx, world.issueId, { set: many })),
         MetadataTooLarge
      );
   });
});
