PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_idempotency_keys` (
	`key` text NOT NULL,
	`actor` text NOT NULL,
	`response` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`key`, `actor`)
);
--> statement-breakpoint
INSERT INTO `__new_idempotency_keys`("key", "actor", "response", "created_at") SELECT "key", "actor", "response", "created_at" FROM `idempotency_keys`;--> statement-breakpoint
DROP TABLE `idempotency_keys`;--> statement-breakpoint
ALTER TABLE `__new_idempotency_keys` RENAME TO `idempotency_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;