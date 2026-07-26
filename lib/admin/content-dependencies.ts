export const invalidPlanStepMediaSql = `
  step.media_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM content_items video
    JOIN clinical_approvals approval
      ON approval.content_id = video.id
     AND approval.content_version = video.version
    JOIN media_assets asset
      ON asset.id = step.media_id
     AND asset.kind = 'video'
     AND asset.status = 'ready'
    WHERE video.type = 'video'
      AND video.media_id = step.media_id
      AND video.status = 'published'
  )`;

export const planVideoDependencyError = "调理步骤只能关联已发布且通过当前临床审核的视频";
