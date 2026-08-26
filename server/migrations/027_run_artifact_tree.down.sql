INSERT INTO attachments (
    id, issue_id, uploader_type, uploader_agent_id, uploader_name, file_name,
    content_type, size_bytes, checksum_sha256, storage_key, state, run_id,
    created_at, ready_at
)
SELECT id, issue_id, 'agent'::assignee_type, agent_id, agent_name,
       replace(path, '/', '-'), content_type, size_bytes, checksum_sha256,
       storage_key, state, run_id, created_at, ready_at
  FROM run_artifacts
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS run_artifacts;
