DROP INDEX `allergen_exposure_records_user_date_idx`;--> statement-breakpoint
INSERT INTO `audit_logs` (`id`, `actor`, `action`, `entity_type`, `entity_id`, `details`, `created_at`)
SELECT
  'migration-0007:' || duplicate.`id`,
  'system:migration',
  'merge_duplicate_exposure',
  'allergen_exposure',
  duplicate.`id`,
  json_object(
    'keptId', keeper.`id`,
    'userId', duplicate.`user_id`,
    'date', duplicate.`exposure_date`,
    'otherDescription', duplicate.`other_description`,
    'note', duplicate.`note`,
    'mutationId', duplicate.`mutation_id`,
    'version', duplicate.`version`,
    'createdAt', duplicate.`created_at`,
    'updatedAt', duplicate.`updated_at`,
    'selections', (SELECT json_group_array(json_object('group', selection.`group_code`, 'code', selection.`option_code`)) FROM `allergen_exposure_selections` selection WHERE selection.`exposure_id` = duplicate.`id`)
  ),
  datetime('now')
FROM `allergen_exposure_records` duplicate
JOIN `allergen_exposure_records` keeper ON keeper.`id` = (
  SELECT candidate.`id`
  FROM `allergen_exposure_records` candidate
  WHERE candidate.`user_id` = duplicate.`user_id` AND candidate.`exposure_date` = duplicate.`exposure_date`
  ORDER BY candidate.`created_at` DESC, candidate.`id` DESC
  LIMIT 1
)
WHERE duplicate.`id` <> keeper.`id`;--> statement-breakpoint
DELETE FROM `allergen_exposure_selections`
WHERE `exposure_id` IN (
  SELECT duplicate.`id`
  FROM `allergen_exposure_records` duplicate
  WHERE EXISTS (
    SELECT 1
    FROM `allergen_exposure_records` keeper
    WHERE keeper.`user_id` = duplicate.`user_id`
      AND keeper.`exposure_date` = duplicate.`exposure_date`
      AND (keeper.`created_at` > duplicate.`created_at` OR (keeper.`created_at` = duplicate.`created_at` AND keeper.`id` > duplicate.`id`))
  )
);--> statement-breakpoint
DELETE FROM `allergen_exposure_records`
WHERE `id` IN (
  SELECT duplicate.`id`
  FROM `allergen_exposure_records` duplicate
  WHERE EXISTS (
    SELECT 1
    FROM `allergen_exposure_records` keeper
    WHERE keeper.`user_id` = duplicate.`user_id`
      AND keeper.`exposure_date` = duplicate.`exposure_date`
      AND (keeper.`created_at` > duplicate.`created_at` OR (keeper.`created_at` = duplicate.`created_at` AND keeper.`id` > duplicate.`id`))
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX `allergen_exposure_records_user_date_idx` ON `allergen_exposure_records` (`user_id`,`exposure_date`);
