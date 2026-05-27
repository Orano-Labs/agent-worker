CREATE TABLE `issuses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uid` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `issuses_id` PRIMARY KEY(`id`),
	CONSTRAINT `issuses_uid_unique` UNIQUE(`uid`)
);
--> statement-breakpoint
CREATE TABLE `issue_collaborators` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uid` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `issue_collaborators_id` PRIMARY KEY(`id`),
	CONSTRAINT `issue_collaborators_uid_unique` UNIQUE(`uid`)
);
--> statement-breakpoint
CREATE TABLE `supervisors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uid` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`name` varchar(255) NOT NULL,
	`public_key` binary(32) NOT NULL,
	`status` enum('active','suspended') NOT NULL DEFAULT 'suspended',
	CONSTRAINT `supervisors_id` PRIMARY KEY(`id`),
	CONSTRAINT `supervisors_uid_unique` UNIQUE(`uid`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uid` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `templates_uid_unique` UNIQUE(`uid`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uid` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1)),
	`create_timestamp` timestamp NOT NULL DEFAULT (now()),
	`update_timestamp` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`role` enum('admin','normal') NOT NULL DEFAULT 'normal',
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_uid_unique` UNIQUE(`uid`)
);
