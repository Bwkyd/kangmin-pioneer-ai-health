CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `content_items_type_status_idx` ON `content_items` (`type`,`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `content_items_category_idx` ON `content_items` (`category`,`updated_at`);