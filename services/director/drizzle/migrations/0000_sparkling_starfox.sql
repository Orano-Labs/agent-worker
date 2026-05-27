CREATE TABLE `issuses` (
	`id` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `issuses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `issue_collaborators` (
	`id` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `issue_collaborators_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `supervisiors` (
	`id` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`name` varchar(255) NOT NULL,
	`public_key` binary(32) NOT NULL,
	`status` enum('active','suspended') NOT NULL DEFAULT 'suspended',
	CONSTRAINT `supervisiors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`role` enum('admin','normal') DEFAULT 'normal',
	CONSTRAINT `users_id` PRIMARY KEY(`id`)
);
