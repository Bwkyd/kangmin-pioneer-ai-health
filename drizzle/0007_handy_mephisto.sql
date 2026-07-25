DROP INDEX `allergen_exposure_records_user_date_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `allergen_exposure_records_user_date_idx` ON `allergen_exposure_records` (`user_id`,`exposure_date`);