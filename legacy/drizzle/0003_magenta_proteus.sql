CREATE TABLE `allergen_exposure_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`exposure_date` text NOT NULL,
	`other_description` text,
	`note` text,
	`mutation_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `allergen_exposure_records_user_date_idx` ON `allergen_exposure_records` (`user_id`,`exposure_date`,`id`);--> statement-breakpoint
CREATE TABLE `allergen_exposure_selections` (
	`exposure_id` text NOT NULL,
	`group_code` text NOT NULL,
	`option_code` text NOT NULL,
	PRIMARY KEY(`exposure_id`, `option_code`),
	FOREIGN KEY (`exposure_id`) REFERENCES `allergen_exposure_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `allergen_exposure_selections_option_idx` ON `allergen_exposure_selections` (`option_code`,`exposure_id`);--> statement-breakpoint
CREATE TABLE `health_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`basic_info` text NOT NULL,
	`allergy_history` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `health_record_idempotency` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text NOT NULL,
	`response` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `health_record_idempotency_user_scope_key_idx` ON `health_record_idempotency` (`user_id`,`scope`,`key`);--> statement-breakpoint
CREATE TABLE `medication_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`taken_at` text NOT NULL,
	`medication_name` text NOT NULL,
	`dosage_status` text NOT NULL,
	`dosage_value` text,
	`dosage_unit` text,
	`actual_use_status` text NOT NULL,
	`actual_use_description` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `medication_records_user_time_idx` ON `medication_records` (`user_id`,`taken_at`,`id`);