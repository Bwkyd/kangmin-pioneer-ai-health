DROP INDEX `allergen_exposure_records_user_date_idx`;--> statement-breakpoint
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
